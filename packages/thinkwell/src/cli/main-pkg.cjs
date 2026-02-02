#!/usr/bin/env node
/**
 * Thinkwell CLI - Node.js entry point for pkg-compiled binary (CommonJS).
 *
 * This is the main entry point for the pkg-compiled binary. pkg works best
 * with CommonJS, so this file uses require() syntax. Unlike the Bun entry
 * point (main.ts), this runs in Node.js with --experimental-strip-types
 * for native TypeScript support in user scripts.
 *
 * The pkg binary uses a custom loader to:
 * - Route thinkwell:* imports to bundled packages
 * - Resolve external packages from user's node_modules
 * - Handle @JSONSchema type processing (Phase 5)
 */

const { existsSync } = require("node:fs");
const { resolve, isAbsolute } = require("node:path");

// Version must be updated manually to match package.json
const VERSION = "0.4.0";

// ============================================================================
// Bundled Module Registration
// ============================================================================

/**
 * Register bundled thinkwell packages to global.__bundled__.
 *
 * The thinkwell packages are pre-bundled into CJS format by scripts/bundle-for-pkg.ts.
 * This is necessary because pkg doesn't properly handle ESM imports inside the
 * /snapshot/ virtual filesystem.
 *
 * Pre-bundled files (in dist-pkg/):
 *   - thinkwell.cjs      - bundled thinkwell package
 *   - acp.cjs            - bundled @thinkwell/acp package
 *   - protocol.cjs       - bundled @thinkwell/protocol package
 *
 * IMPORTANT: Use literal strings in require() calls so pkg can statically
 * analyze and bundle these modules.
 */
function registerBundledModules() {
  try {
    // Require pre-bundled CJS packages using RELATIVE PATHS from src/cli/ directory.
    // Path: src/cli/ -> ../../dist-pkg/
    const thinkwell = require("../../dist-pkg/thinkwell.cjs");
    const acpModule = require("../../dist-pkg/acp.cjs");
    const protocolModule = require("../../dist-pkg/protocol.cjs");

    // Register to global.__bundled__ for the loader to access
    global.__bundled__ = {
      thinkwell: thinkwell,
      "@thinkwell/acp": acpModule,
      "@thinkwell/protocol": protocolModule,
    };
  } catch (error) {
    // This error occurs when pkg bundling didn't include all required modules.
    console.error("Error: Failed to load bundled modules.");
    console.error("");
    console.error("This may indicate a build issue with the pkg binary.");
    console.error("Please report this at: https://github.com/dherman/thinkwell/issues");
    console.error("");
    if (process.env.DEBUG) {
      console.error("Debug info:");
      console.error(`  ${error.message}`);
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// ============================================================================
// CLI Commands
// ============================================================================

function showHelp() {
  console.log(`
thinkwell - Run TypeScript scripts with automatic schema generation

Usage:
  thinkwell <script.ts> [args...]     Run a TypeScript script
  thinkwell run <script.ts> [args...] Explicit run command
  thinkwell init [project-name]       Initialize a new project
  thinkwell types [dir]               Generate .d.ts files for IDE support
  thinkwell --help                    Show this help message
  thinkwell --version                 Show version

Examples:
  thinkwell hello.ts                 Run hello.ts
  thinkwell run hello.ts --verbose   Run with arguments
  thinkwell init my-agent            Create a new project
  ./script.ts                        Via shebang: #!/usr/bin/env thinkwell
  thinkwell types                    Generate declarations in current dir
  thinkwell types src                Generate declarations in src/

The thinkwell CLI automatically:
  - Generates JSON Schema for types marked with @JSONSchema
  - Resolves thinkwell:* imports to built-in modules
  - Creates .thinkwell.d.ts files for IDE autocomplete (types command)

For more information, visit: https://github.com/dherman/thinkwell
`);
}

/**
 * Run the init command to scaffold a new project.
 */
async function runInitCommand(args) {
  // Import the init command from the bundled dist
  // Path: src/cli/ -> ../../dist/cli/init-command.js
  const { runInit } = require("../../dist/cli/init-command.js");
  await runInit(args);
}

/**
 * Run the types command to generate .d.ts files.
 *
 * Note: This is a placeholder for Phase 5. The full implementation
 * requires @JSONSchema processing which will be added later.
 */
async function runTypesCommand(args) {
  // For now, provide a helpful message
  console.log("The 'types' command requires @JSONSchema processing.");
  console.log("");
  console.log("This feature will be available in a future release.");
  console.log("For now, use the npm distribution with Bun for 'thinkwell types'.");
  process.exit(0);
}

/**
 * Run a user script using the custom loader.
 */
async function runUserScript(scriptPath, args) {
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

  // Import the loader from the pre-bundled CJS
  // Path: src/cli/ -> ../../dist-pkg/cli-loader.cjs
  const { runScript } = require("../../dist-pkg/cli-loader.cjs");

  try {
    await runScript(resolvedPath, args);
  } catch (error) {
    // Handle common error cases with helpful messages
    if (error.message && error.message.includes("Cannot find module")) {
      console.error(`Error: ${error.message}`);
      console.error("");
      console.error("Make sure the module is installed in your project's node_modules.");
      process.exit(1);
    }

    if (error.message && error.message.includes("Cannot find package")) {
      console.error(`Error: ${error.message}`);
      console.error("");
      console.error("Run 'npm install' or 'pnpm install' to install dependencies.");
      process.exit(1);
    }

    // Re-throw other errors
    throw error;
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Handle --help (global)
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    showHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`thinkwell ${VERSION} (pkg binary)`);
    process.exit(0);
  }

  // Handle "init" subcommand - does NOT require bundled modules
  if (args[0] === "init") {
    await runInitCommand(args.slice(1));
    process.exit(0);
  }

  // Handle "types" subcommand - placeholder for Phase 5
  if (args[0] === "types") {
    await runTypesCommand(args.slice(1));
    process.exit(0);
  }

  // Handle "run" subcommand - just strip it
  const runArgs = args[0] === "run" ? args.slice(1) : args;

  // If no script provided after "run", show help
  if (runArgs.length === 0) {
    console.error("Error: No script provided.");
    console.error("");
    console.error("Usage: thinkwell <script.ts> [args...]");
    process.exit(1);
  }

  // Register bundled modules before loading user scripts
  // This populates global.__bundled__ which the loader uses to resolve
  // thinkwell:* imports in user scripts.
  registerBundledModules();

  // Run the user script
  const scriptPath = runArgs[0];
  const scriptArgs = runArgs.slice(1);
  await runUserScript(scriptPath, scriptArgs);
}

main().catch((error) => {
  console.error("Unexpected error:");
  console.error(`  ${error.message || error}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
