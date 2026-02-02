#!/usr/bin/env bun
/**
 * Thinkwell CLI - Bun-native entry point for compiled binary.
 *
 * This is the main entry point for the self-contained Bun-compiled binary.
 * Unlike the Node.js launcher (bin/thinkwell), this runs directly in Bun
 * and can be compiled with `bun build --compile`.
 *
 * The bun-plugin is imported at the top level, which registers it with Bun's
 * plugin system. This means any TypeScript files loaded after this point
 * will automatically have @JSONSchema types processed.
 */

import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

// Import the bun-plugin - this registers it with Bun's plugin system.
// The plugin will intercept all .ts/.tsx file loads and process @JSONSchema types.
import { registerModule } from "@thinkwell/bun-plugin";

// Import thinkwell packages so they get bundled into the compiled binary.
// These are registered as virtual modules so user scripts can import from them.
import * as thinkwell from "thinkwell";
import * as thinkwellAcp from "@thinkwell/acp";
import * as thinkwellProtocol from "@thinkwell/protocol";

// Register modules for virtual resolution in compiled binary.
// This enables user scripts to import from "thinkwell:agent" etc.
registerModule("thinkwell", thinkwell as Record<string, unknown>);
registerModule("@thinkwell/acp", thinkwellAcp as Record<string, unknown>);
registerModule("@thinkwell/protocol", thinkwellProtocol as Record<string, unknown>);

import { runInit } from "./init-command.js";

// Get version from package.json at build time
const VERSION = "0.3.0-alpha.1"; // Will be replaced by build script

function showHelp(): void {
  console.log(`
thinkwell - Run TypeScript scripts with automatic schema generation

Usage:
  thinkwell <script.ts> [args...]     Run a TypeScript script
  thinkwell run <script.ts> [args...] Explicit run command
  thinkwell init [project-name]       Initialize a new project
  thinkwell types [dir]               Generate .d.ts files for IDE support
  thinkwell types --watch [dir]       Watch and regenerate .d.ts files
  thinkwell --help                    Show this help message
  thinkwell --version                 Show version

Examples:
  thinkwell hello.ts                 Run hello.ts
  thinkwell run hello.ts --verbose   Run with arguments
  thinkwell init my-agent            Create a new project
  ./script.ts                        Via shebang: #!/usr/bin/env thinkwell
  thinkwell types                    Generate declarations in current dir
  thinkwell types src                Generate declarations in src/
  thinkwell types --watch            Watch for changes and regenerate

The thinkwell CLI automatically:
  - Generates JSON Schema for types marked with @JSONSchema
  - Resolves thinkwell:* imports to built-in modules
  - Creates .thinkwell.d.ts files for IDE autocomplete (types command)

For more information, visit: https://github.com/dherman/thinkwell
`);
}

async function runTypes(args: string[]): Promise<void> {
  // Import the types command implementation from the bundled bun-plugin
  const { generateDeclarations, watchDeclarations } = await import(
    "@thinkwell/bun-plugin"
  );

  const watchMode = args.includes("--watch") || args.includes("-w");
  const dirArg = args.find((arg) => !arg.startsWith("-"));
  const rootDir = dirArg ? resolve(dirArg) : process.cwd();

  // Validate directory exists
  if (!existsSync(rootDir)) {
    console.error(`Error: Directory not found: ${rootDir}`);
    process.exit(1);
  }

  const formatError = (error: Error, sourceFile: string): string => {
    const lines = [`Error processing: ${sourceFile}`, `  ${error.message}`];
    if (process.env.DEBUG) {
      lines.push(
        `  Stack: ${error.stack?.split("\n").slice(1, 3).join("\n  ")}`
      );
    }
    return lines.join("\n");
  };

  if (watchMode) {
    console.log(`Watching for changes in ${rootDir}...`);
    console.log("Press Ctrl+C to stop.\n");

    const watcher = watchDeclarations({
      rootDir,
      onWrite: (_source: string, decl: string) => {
        console.log(`✓ ${decl}`);
      },
      onRemove: (_source: string, decl: string) => {
        console.log(`✗ ${decl} (removed)`);
      },
      onError: (error: Error, source: string) => {
        console.error(formatError(error, source));
      },
    });

    // Initial generation
    console.log("Generating initial declarations...\n");
    await generateDeclarations({
      rootDir,
      onWrite: (_source: string, decl: string) => {
        console.log(`✓ ${decl}`);
      },
      onError: (error: Error, source: string) => {
        console.error(formatError(error, source));
      },
    });

    console.log("\nWatching for changes...\n");

    // Keep process alive
    process.on("SIGINT", () => {
      watcher.stop();
      console.log("\nStopped watching.");
      process.exit(0);
    });

    // Prevent the process from exiting
    await new Promise(() => {});
  } else {
    console.log(`Generating declarations in ${rootDir}...\n`);

    let errorCount = 0;
    const generated = await generateDeclarations({
      rootDir,
      onWrite: (_source: string, decl: string) => {
        console.log(`✓ ${decl}`);
      },
      onError: (error: Error, source: string) => {
        errorCount++;
        console.error(formatError(error, source));
      },
    });

    if (generated.length === 0 && errorCount === 0) {
      console.log("No @JSONSchema types found.");
      console.log("");
      console.log(
        "To mark a type for schema generation, add the @JSONSchema JSDoc tag:"
      );
      console.log("");
      console.log("  /** @JSONSchema */");
      console.log("  interface MyType {");
      console.log("    name: string;");
      console.log("  }");
    } else {
      console.log(`\nGenerated ${generated.length} declaration file(s).`);
      if (errorCount > 0) {
        console.log(`Encountered ${errorCount} error(s).`);
        process.exit(1);
      }
    }
  }
}

async function runScript(args: string[]): Promise<void> {
  const scriptPath = args[0];

  // Resolve the script path
  const resolvedPath = isAbsolute(scriptPath)
    ? scriptPath
    : resolve(process.cwd(), scriptPath);

  // Check if the script file exists
  if (!existsSync(resolvedPath)) {
    console.error(`Error: Script not found: ${scriptPath}`);
    console.error("");
    console.error("Make sure the file exists and the path is correct.");
    process.exit(1);
  }

  // Set up process.argv for the script
  // The script should see: [bun, script.ts, ...args]
  const originalArgv = process.argv;
  process.argv = [process.argv[0], resolvedPath, ...args.slice(1)];

  try {
    // Dynamically import the script.
    // Because the bun-plugin is registered, it will intercept this import
    // and process any @JSONSchema types in the file.
    const scriptUrl = pathToFileURL(resolvedPath).href;
    await import(scriptUrl);
  } catch (error) {
    // Restore argv before handling error
    process.argv = originalArgv;

    if (error instanceof Error) {
      // Check if it's a module not found error for thinkwell packages
      if (
        error.message.includes("Cannot find module") ||
        error.message.includes("Cannot find package")
      ) {
        console.error(`Error: ${error.message}`);
        console.error("");
        console.error(
          "If your script uses thinkwell:* imports, make sure to use"
        );
        console.error("the import syntax like: import { Agent } from 'thinkwell:agent'");
        process.exit(1);
      }
      throw error;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle "init" subcommand first - does NOT require schema plugin
  if (args[0] === "init") {
    await runInit(args.slice(1));
    process.exit(0);
  }

  // Handle --help (global)
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    showHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`thinkwell ${VERSION}`);
    process.exit(0);
  }

  // Handle "types" subcommand
  if (args[0] === "types") {
    await runTypes(args.slice(1));
    process.exit(0);
  }

  // Handle "run" subcommand - just strip it
  const runArgs = args[0] === "run" ? args.slice(1) : args;

  // If no script provided after "run", show help
  if (runArgs.length === 0) {
    console.error("Error: No script provided.");
    console.error("");
    console.error("Usage: thinkwell run <script.ts> [args...]");
    process.exit(1);
  }

  await runScript(runArgs);
}

main().catch((error) => {
  console.error("Unexpected error:");
  console.error(`  ${error.message || error}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
