#!/usr/bin/env node
/**
 * Thinkwell CLI - Entry point for compiled binary (CommonJS).
 *
 * This is the main entry point for the compiled binary. The binary is built
 * with pkg, which works best with CommonJS, so this file uses require() syntax.
 * It runs in Node.js with --experimental-strip-types for native TypeScript
 * support in user scripts.
 *
 * The compiled binary uses a custom loader to:
 * - Route thinkwell:* imports to bundled packages
 * - Resolve external packages from user's node_modules
 * - Handle @JSONSchema type processing
 */

const { existsSync } = require("node:fs");
const { resolve, isAbsolute } = require("node:path");
const { showMainHelp, showNoScriptError, hasHelpFlag, fmtError } = require("../../dist/cli/commands.js");

// Version must be updated manually to match package.json
const VERSION = "0.5.2";

// ============================================================================
// Bundled Module Registration
// ============================================================================

/**
 * Register bundled thinkwell packages to global.__bundled__.
 *
 * The thinkwell packages are pre-bundled into CJS format by scripts/bundle.ts.
 * This is necessary because the compiled binary doesn't properly handle ESM
 * imports inside the /snapshot/ virtual filesystem.
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
    console.error(fmtError("Failed to load bundled modules."));
    console.error("");
    console.error("This may indicate a build issue with the compiled binary.");
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

// showMainHelp() is imported from commands.ts

/**
 * Run the init command to add dependencies to an existing project.
 */
async function runInitCommand(args) {
  // Import the init command from the bundled dist
  // Path: src/cli/ -> ../../dist/cli/init.js
  const { parseInitArgs, runInit, showInitHelp } = require("../../dist/cli/init.js");

  if (hasHelpFlag(args)) {
    showInitHelp();
    return;
  }

  const options = parseInitArgs(args);
  await runInit(options);
}

/**
 * Run the new command to scaffold a new project.
 */
async function runNewCommand(args) {
  // Import the new command from the bundled dist
  // Path: src/cli/ -> ../../dist/cli/new-command.js
  const { runNew } = require("../../dist/cli/new-command.js");
  await runNew(args);
}

/**
 * Run the build command (tsc-based compilation with @JSONSchema transformation).
 */
async function runBuildCommand(args) {
  if (hasHelpFlag(args)) {
    const { showBuildHelp } = require("../../dist-pkg/cli-build.cjs");
    showBuildHelp();
    return;
  }

  // Import and run the build command from pre-bundled CJS
  // Path: src/cli/ -> ../../dist-pkg/cli-build.cjs
  const { parseBuildArgs, runBuild } = require("../../dist-pkg/cli-build.cjs");

  try {
    const options = parseBuildArgs(args);
    await runBuild(options);
  } catch (error) {
    console.error(fmtError(error.message));
    process.exit(1);
  }
}

/**
 * Run the check command (type-check with @JSONSchema transformation, no emit).
 */
async function runCheckCommand(args) {
  if (hasHelpFlag(args)) {
    const { showCheckHelp } = require("../../dist-pkg/cli-check.cjs");
    showCheckHelp();
    return;
  }

  // Import and run the check command from pre-bundled CJS
  // Path: src/cli/ -> ../../dist-pkg/cli-check.cjs
  const { parseCheckArgs, runCheck } = require("../../dist-pkg/cli-check.cjs");

  try {
    const options = parseCheckArgs(args);
    await runCheck(options);
  } catch (error) {
    console.error(fmtError(error.message));
    process.exit(1);
  }
}

/**
 * Set up esbuild for compiled binary environment.
 *
 * When running from the compiled binary, esbuild's native binary can't be
 * spawned directly from the snapshot filesystem. We extract it to a cache
 * directory and set ESBUILD_BINARY_PATH before loading esbuild.
 *
 * This MUST be called before requiring cli-bundle.cjs since esbuild is bundled
 * into that module and initializes when the module loads.
 */
function setupEsbuildForBuild(verbose) {
  // Only needed when running from compiled binary
  if (typeof process.pkg === "undefined") {
    return;
  }

  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");

  // Get thinkwell version for cache invalidation
  let version = "unknown";
  try {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    version = pkg.version || "unknown";
  } catch {}

  // Cache directory: ~/.cache/thinkwell/esbuild/<version>/
  const cacheDir = path.join(
    process.env.THINKWELL_CACHE_DIR || path.join(os.homedir(), ".cache", "thinkwell"),
    "esbuild",
    version
  );
  const esbuildDest = path.join(cacheDir, "esbuild");

  // Check if already extracted
  if (fs.existsSync(esbuildDest)) {
    if (verbose) {
      console.log(`  Using cached esbuild: ${esbuildDest}`);
    }
    process.env.ESBUILD_BINARY_PATH = esbuildDest;
    return;
  }

  // Find esbuild binary in snapshot
  const platform = process.platform;
  const arch = process.arch;
  const platformDir = `${platform === "darwin" ? "darwin" : "linux"}-${arch}`;
  const esbuildSrc = `/snapshot/thinkwell/packages/thinkwell/dist-pkg/esbuild-bin/${platformDir}/esbuild`;

  if (!fs.existsSync(esbuildSrc)) {
    console.error(fmtError(`Could not find esbuild binary for ${platformDir}`));
    console.error(`  Expected at: ${esbuildSrc}`);
    console.error("  The build command is not available in this binary.");
    process.exit(1);
  }

  // Extract to cache
  if (verbose) {
    console.log(`  Extracting esbuild to: ${esbuildDest}`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(esbuildSrc, esbuildDest);
  fs.chmodSync(esbuildDest, 0o755);

  process.env.ESBUILD_BINARY_PATH = esbuildDest;
}

/**
 * Run the bundle command to compile scripts into standalone executables.
 *
 * Uses the pre-bundled cli-bundle.cjs which handles esbuild setup for
 * compiled binary environments (extracting esbuild binary from pkg snapshot).
 */
async function runBundleCommand(args) {
  const verbose = args.includes("--verbose") || args.includes("-v");

  // Set up esbuild binary BEFORE loading cli-bundle.cjs
  // This is critical because esbuild is bundled into cli-bundle.cjs and
  // initializes when the module is loaded.
  setupEsbuildForBuild(verbose);

  if (hasHelpFlag(args)) {
    const { showBundleHelp } = require("../../dist-pkg/cli-bundle.cjs");
    showBundleHelp();
    return;
  }

  // Import and run the bundle command from pre-bundled CJS
  // Path: src/cli/ -> ../../dist-pkg/cli-bundle.cjs
  const { parseBundleArgs, runBundle } = require("../../dist-pkg/cli-bundle.cjs");

  try {
    const options = parseBundleArgs(args);
    await runBundle(options);
  } catch (error) {
    console.error(fmtError(error.message));
    process.exit(1);
  }
}

/**
 * Run the types command to generate .d.ts files.
 *
 * Note: This is a placeholder for Phase 5. The full implementation
 * requires @JSONSchema processing which will be added later.
 */
async function runTypesCommand(args) {
  // For now, provide a helpful message
  console.error("Not yet implemented.");
  process.exit(1);
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
    console.error(fmtError(`Script not found: ${scriptPath}`));
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
      console.error(fmtError(error.message));
      console.error("");
      console.error("Make sure the module is installed in your project's node_modules.");
      process.exit(1);
    }

    if (error.message && error.message.includes("Cannot find package")) {
      console.error(fmtError(error.message));
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

  // Handle "init" subcommand - adds dependencies to existing project
  // Must come before global --help check so "init --help" works
  if (args[0] === "init") {
    await runInitCommand(args.slice(1));
    process.exit(0);
  }

  // Handle "new" subcommand - scaffolds a new project
  if (args[0] === "new") {
    await runNewCommand(args.slice(1));
    process.exit(0);
  }

  // Handle "bundle" subcommand
  // Must come before global --help check so "bundle --help" works
  if (args[0] === "bundle") {
    await runBundleCommand(args.slice(1));
    process.exit(0);
  }

  // Handle "build" subcommand — tsc-based build with @JSONSchema transformation
  if (args[0] === "build") {
    await runBuildCommand(args.slice(1));
    process.exit(0);
  }

  // Handle "check" subcommand — type-check with @JSONSchema transformation (no emit)
  if (args[0] === "check") {
    await runCheckCommand(args.slice(1));
    process.exit(0);
  }

  // Handle "types" subcommand - placeholder for Phase 5
  // Must come before global --help check so "types --help" works
  if (args[0] === "types") {
    await runTypesCommand(args.slice(1));
    process.exit(0);
  }

  // Handle --help (global) - after subcommand checks
  if (hasHelpFlag(args) || args.length === 0) {
    showMainHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`thinkwell ${VERSION}`);
    process.exit(0);
  }

  // Handle "run" subcommand - just strip it
  const runArgs = args[0] === "run" ? args.slice(1) : args;

  // If no script provided after "run", show help
  if (runArgs.length === 0) {
    showNoScriptError();
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
  console.error(fmtError(`Unexpected error: ${error.message || error}`));
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
