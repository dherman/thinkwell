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
 * - Handle @JSONSchema type processing
 *
 * Phase 1 stub: This is a minimal implementation to verify pkg bundling works.
 * Full implementation will be added in Phase 2 (Loader) and Phase 3 (CLI).
 */

const { existsSync } = require("node:fs");
const { resolve, isAbsolute } = require("node:path");

// Version must be updated manually to match package.json
const VERSION = "0.3.2";

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

Note: This is the pkg-compiled binary. Full functionality will be implemented
in subsequent phases.

For more information, visit: https://github.com/dherman/thinkwell
`);
}

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

  // For Phase 1, just acknowledge commands but indicate they're not yet implemented
  const command = args[0];

  if (command === "init") {
    console.log("init command: Will be implemented in Phase 3");
    process.exit(0);
  }

  if (command === "types") {
    console.log("types command: Will be implemented in Phase 5");
    process.exit(0);
  }

  // Handle script execution (Phase 2+)
  const scriptPath = command === "run" ? args[1] : args[0];

  if (!scriptPath) {
    console.error("Error: No script provided.");
    console.error("");
    console.error("Usage: thinkwell <script.ts> [args...]");
    process.exit(1);
  }

  const resolvedPath = isAbsolute(scriptPath)
    ? scriptPath
    : resolve(process.cwd(), scriptPath);

  if (!existsSync(resolvedPath)) {
    console.error(`Error: Script not found: ${scriptPath}`);
    process.exit(1);
  }

  console.log(`Script execution will be implemented in Phase 2.`);
  console.log(`Script path: ${resolvedPath}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Unexpected error:");
  console.error(`  ${error.message || error}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
