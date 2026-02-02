/**
 * CLI command for generating declaration files.
 *
 * This script is invoked by the thinkwell CLI when the user runs
 * `thinkwell types` or `thinkwell types --watch`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateDeclarations,
  watchDeclarations,
} from "@thinkwell/bun-plugin";

/**
 * Format an error for console output.
 */
function formatError(error: Error, sourceFile: string): string {
  const lines = [
    `Error processing: ${sourceFile}`,
    `  ${error.message}`,
  ];

  // Add stack trace hint for debugging
  if (process.env.DEBUG) {
    lines.push(`  Stack: ${error.stack?.split("\n").slice(1, 3).join("\n  ")}`);
  }

  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);

  const watchMode = args.includes("--watch") || args.includes("-w");
  const dirArg = args.find((arg) => !arg.startsWith("-"));
  const rootDir = dirArg ? resolve(dirArg) : process.cwd();

  // Validate directory exists
  if (!existsSync(rootDir)) {
    console.error(`Error: Directory not found: ${rootDir}`);
    process.exit(1);
  }

  if (watchMode) {
    console.log(`Watching for changes in ${rootDir}...`);
    console.log("Press Ctrl+C to stop.\n");

    const watcher = watchDeclarations({
      rootDir,
      onWrite: (source, decl) => {
        console.log(`✓ ${decl}`);
      },
      onRemove: (source, decl) => {
        console.log(`✗ ${decl} (removed)`);
      },
      onError: (error, source) => {
        console.error(formatError(error, source));
      },
    });

    // Initial generation
    console.log("Generating initial declarations...\n");
    await generateDeclarations({
      rootDir,
      onWrite: (source, decl) => {
        console.log(`✓ ${decl}`);
      },
      onError: (error, source) => {
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
      onWrite: (source, decl) => {
        console.log(`✓ ${decl}`);
      },
      onError: (error, source) => {
        errorCount++;
        console.error(formatError(error, source));
      },
    });

    if (generated.length === 0 && errorCount === 0) {
      console.log("No @JSONSchema types found.");
      console.log("");
      console.log("To mark a type for schema generation, add the @JSONSchema JSDoc tag:");
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

main().catch((error) => {
  console.error("Unexpected error:");
  console.error(`  ${error.message || error}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
