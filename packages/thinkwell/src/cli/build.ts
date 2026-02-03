/**
 * Build command for creating self-contained executables from user scripts.
 *
 * This module provides the `thinkwell build` command that compiles user scripts
 * into standalone binaries using the same pkg-based tooling as the thinkwell CLI.
 *
 * The build process follows a two-stage pipeline:
 * 1. **Pre-bundle with esbuild** - Bundle user script + thinkwell packages into CJS
 * 2. **Compile with pkg** - Create self-contained binary with Node.js runtime
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, basename, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { build as esbuild } from "esbuild";
import ora, { type Ora } from "ora";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supported build targets
export type Target = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "host";

// Map user-friendly target names to pkg target names
const TARGET_MAP: Record<Exclude<Target, "host">, string> = {
  "darwin-arm64": "node24-macos-arm64",
  "darwin-x64": "node24-macos-x64",
  "linux-x64": "node24-linux-x64",
  "linux-arm64": "node24-linux-arm64",
};

// Detect the current host platform
function detectHostTarget(): Exclude<Target, "host"> {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";

  throw new Error(
    `Unsupported platform: ${platform}-${arch}. ` +
    `Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64`
  );
}

export interface BuildOptions {
  /** Entry point TypeScript/JavaScript file */
  entry: string;
  /** Output file path (default: ./<entry-basename>-<target>) */
  output?: string;
  /** Target platforms (default: ["host"]) */
  targets?: Target[];
  /** Additional files to embed as assets */
  include?: string[];
  /** Show detailed build output */
  verbose?: boolean;
  /** Suppress all non-error output (for CI environments) */
  quiet?: boolean;
  /** Show what would be built without actually building */
  dryRun?: boolean;
}

interface BuildContext {
  /** Absolute path to the entry file */
  entryPath: string;
  /** Base name of the entry file (without extension) */
  entryBasename: string;
  /** Directory containing the entry file */
  entryDir: string;
  /** Temporary build directory */
  buildDir: string;
  /** Path to bundled thinkwell packages (dist-pkg from thinkwell package) */
  thinkwellDistPkg: string;
  /** Resolved targets (no "host") */
  resolvedTargets: Exclude<Target, "host">[];
  /** Build options */
  options: BuildOptions;
}

/**
 * Parse and validate build options from command-line arguments.
 */
export function parseBuildArgs(args: string[]): BuildOptions {
  const options: BuildOptions = {
    entry: "",
    targets: [],
    include: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-o" || arg === "--output") {
      i++;
      if (i >= args.length) {
        throw new Error("Missing value for --output");
      }
      options.output = args[i];
    } else if (arg === "-t" || arg === "--target") {
      i++;
      if (i >= args.length) {
        throw new Error("Missing value for --target");
      }
      const target = args[i] as Target;
      const validTargets: Target[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "host"];
      if (!validTargets.includes(target)) {
        throw new Error(
          `Invalid target '${target}'. Valid targets: ${validTargets.join(", ")}`
        );
      }
      options.targets!.push(target);
    } else if (arg === "--include") {
      i++;
      if (i >= args.length) {
        throw new Error("Missing value for --include");
      }
      options.include!.push(args[i]);
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else if (arg === "--dry-run" || arg === "-n") {
      options.dryRun = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      // Positional argument - entry file
      if (options.entry) {
        throw new Error(`Unexpected argument: ${arg}`);
      }
      options.entry = arg;
    }
    i++;
  }

  // Validate entry
  if (!options.entry) {
    throw new Error("No entry file specified");
  }

  // Default target is host
  if (options.targets!.length === 0) {
    options.targets = ["host"];
  }

  return options;
}

/**
 * Initialize the build context with resolved paths and validated inputs.
 */
function initBuildContext(options: BuildOptions): BuildContext {
  // Resolve entry path
  const entryPath = isAbsolute(options.entry)
    ? options.entry
    : resolve(process.cwd(), options.entry);

  if (!existsSync(entryPath)) {
    const suggestion = options.entry.endsWith(".ts") || options.entry.endsWith(".js")
      ? ""
      : "\n  Did you mean to add a .ts or .js extension?";
    throw new Error(
      `Entry file not found: ${options.entry}${suggestion}\n` +
      `  Working directory: ${process.cwd()}`
    );
  }

  const entryBasename = basename(entryPath).replace(/\.(ts|js|mts|mjs|cts|cjs)$/, "");
  const entryDir = dirname(entryPath);

  // Create build directory in the entry file's directory
  const buildDir = join(entryDir, ".thinkwell-build");

  // Find the thinkwell dist-pkg directory
  // When running from npm install: node_modules/thinkwell/dist-pkg
  // When running from source: packages/thinkwell/dist-pkg
  const thinkwellDistPkg = resolve(__dirname, "../../dist-pkg");
  if (!existsSync(thinkwellDistPkg)) {
    throw new Error(
      `Thinkwell dist-pkg not found at ${thinkwellDistPkg}.\n` +
      `  This may indicate a corrupted installation.\n` +
      `  Try reinstalling thinkwell: npm install thinkwell`
    );
  }

  // Resolve "host" targets to actual platform
  const resolvedTargets = options.targets!.map((t) =>
    t === "host" ? detectHostTarget() : t
  );

  // Deduplicate targets
  const uniqueTargets = [...new Set(resolvedTargets)];

  return {
    entryPath,
    entryBasename,
    entryDir,
    buildDir,
    thinkwellDistPkg,
    resolvedTargets: uniqueTargets,
    options,
  };
}

/**
 * Generate the output path for a given target.
 */
function getOutputPath(ctx: BuildContext, target: Exclude<Target, "host">): string {
  if (ctx.options.output) {
    if (ctx.resolvedTargets.length === 1) {
      // Single target: use exact output path
      return isAbsolute(ctx.options.output)
        ? ctx.options.output
        : resolve(process.cwd(), ctx.options.output);
    } else {
      // Multiple targets: append target suffix
      const base = isAbsolute(ctx.options.output)
        ? ctx.options.output
        : resolve(process.cwd(), ctx.options.output);
      return `${base}-${target}`;
    }
  } else {
    // Default: <entry-basename>-<target> in current directory
    return resolve(process.cwd(), `${ctx.entryBasename}-${target}`);
  }
}

/**
 * Generate the wrapper entry point that sets up global.__bundled__.
 *
 * This creates a CJS file that:
 * 1. Loads the pre-bundled thinkwell packages
 * 2. Registers them in global.__bundled__
 * 3. Loads and runs the user's bundled code
 */
function generateWrapperSource(userBundlePath: string): string {
  return `#!/usr/bin/env node
/**
 * Generated wrapper for thinkwell build.
 * This file is auto-generated - do not edit.
 */

// Register bundled thinkwell packages
const thinkwell = require('./thinkwell.cjs');
const acpModule = require('./acp.cjs');
const protocolModule = require('./protocol.cjs');

global.__bundled__ = {
  'thinkwell': thinkwell,
  '@thinkwell/acp': acpModule,
  '@thinkwell/protocol': protocolModule,
};

// Load the user's bundled code
require('./${basename(userBundlePath)}');
`;
}

/**
 * Stage 1: Bundle user script with esbuild.
 *
 * This bundles the user's entry point along with all its dependencies
 * into a single CJS file. The thinkwell packages are marked as external
 * since they'll be provided via global.__bundled__.
 */
async function bundleUserScript(ctx: BuildContext): Promise<string> {
  const outputFile = join(ctx.buildDir, `${ctx.entryBasename}-bundle.cjs`);

  if (ctx.options.verbose) {
    console.log(`  Bundling ${ctx.entryPath}...`);
  }

  try {
    await esbuild({
      entryPoints: [ctx.entryPath],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: outputFile,
      // External: Node built-ins
      external: ["node:*"],
      // Mark thinkwell packages as external - they're provided via global.__bundled__
      // But actually, we need to transform the imports, so let's bundle them
      // and use a banner to set up the module aliases
      banner: {
        js: `
// Alias thinkwell packages to global.__bundled__
const __origRequire = require;
require = function(id) {
  if (id === 'thinkwell' || id === 'thinkwell:agent' || id === 'thinkwell:connectors') {
    return global.__bundled__['thinkwell'];
  }
  if (id === '@thinkwell/acp' || id === 'thinkwell:acp') {
    return global.__bundled__['@thinkwell/acp'];
  }
  if (id === '@thinkwell/protocol' || id === 'thinkwell:protocol') {
    return global.__bundled__['@thinkwell/protocol'];
  }
  return __origRequire(id);
};
require.resolve = __origRequire.resolve;
require.cache = __origRequire.cache;
require.extensions = __origRequire.extensions;
require.main = __origRequire.main;
`,
      },
      // Resolve thinkwell imports to bundled versions during bundle time
      plugins: [
        {
          name: "thinkwell-resolver",
          setup(build) {
            // Resolve thinkwell:* imports to the npm package
            build.onResolve({ filter: /^thinkwell:/ }, (args) => {
              const moduleName = args.path.replace("thinkwell:", "");
              const moduleMap: Record<string, string> = {
                agent: "thinkwell",
                acp: "@thinkwell/acp",
                protocol: "@thinkwell/protocol",
                connectors: "thinkwell",
              };
              const resolved = moduleMap[moduleName];
              if (resolved) {
                // Mark as external - will be provided by global.__bundled__ at runtime
                return { path: resolved, external: true };
              }
              return null;
            });

            // Mark thinkwell packages as external
            build.onResolve({ filter: /^(thinkwell|@thinkwell\/(acp|protocol))$/ }, (args) => {
              return { path: args.path, external: true };
            });
          },
        },
      ],
      sourcemap: false,
      minify: false,
      keepNames: true,
      target: "node24",
      logLevel: ctx.options.verbose ? "info" : "silent",
    });
  } catch (error) {
    // Provide helpful error messages for common failures
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Could not resolve")) {
      const match = message.match(/Could not resolve "([^"]+)"/);
      const moduleName = match ? match[1] : "unknown module";
      throw new Error(
        `Could not resolve dependency "${moduleName}".\n` +
        `  Make sure all dependencies are installed: npm install\n` +
        `  If this is a dev dependency, it may need to be a regular dependency.`
      );
    }

    if (message.includes("No loader is configured")) {
      throw new Error(
        `Unsupported file type in import.\n` +
        `  esbuild cannot bundle this file type by default.\n` +
        `  Consider using --include to embed the file as an asset instead.`
      );
    }

    throw error;
  }

  return outputFile;
}

/**
 * Copy thinkwell pre-bundled packages to build directory.
 */
function copyThinkwellBundles(ctx: BuildContext): void {
  const bundles = ["thinkwell.cjs", "acp.cjs", "protocol.cjs"];

  for (const bundle of bundles) {
    const src = join(ctx.thinkwellDistPkg, bundle);
    const dest = join(ctx.buildDir, bundle);

    if (!existsSync(src)) {
      throw new Error(`Thinkwell bundle not found: ${src}`);
    }

    const content = readFileSync(src);
    writeFileSync(dest, content);

    if (ctx.options.verbose) {
      console.log(`  Copied ${bundle}`);
    }
  }
}

/**
 * Stage 2: Compile with pkg.
 *
 * Uses @yao-pkg/pkg to create a self-contained binary.
 */
async function compileWithPkg(
  ctx: BuildContext,
  wrapperPath: string,
  target: Exclude<Target, "host">,
  outputPath: string
): Promise<void> {
  // Dynamic import of pkg
  const { exec } = await import("@yao-pkg/pkg");

  const pkgTarget = TARGET_MAP[target];

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Build pkg configuration
  const pkgConfig = [
    wrapperPath,
    "--targets",
    pkgTarget,
    "--output",
    outputPath,
    "--options",
    "experimental-transform-types,disable-warning=ExperimentalWarning",
    "--public", // Include source instead of bytecode (required for cross-compilation)
  ];

  // Add assets if specified
  if (ctx.options.include && ctx.options.include.length > 0) {
    for (const pattern of ctx.options.include) {
      pkgConfig.push("--assets", pattern);
    }
  }

  await exec(pkgConfig);
}

// ============================================================================
// Top-Level Await Detection
// ============================================================================

/**
 * Detect top-level await usage in the entry file.
 * Returns an array of line numbers where top-level await is found.
 */
function detectTopLevelAwait(filePath: string): number[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const awaits: number[] = [];

  // Track nesting depth of functions/classes
  let depth = 0;
  let inMultiLineComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle multi-line comments
    if (inMultiLineComment) {
      const endIdx = line.indexOf("*/");
      if (endIdx !== -1) {
        line = line.slice(endIdx + 2);
        inMultiLineComment = false;
      } else {
        continue;
      }
    }

    // Remove single-line comments
    const singleLineCommentIdx = line.indexOf("//");
    if (singleLineCommentIdx !== -1) {
      line = line.slice(0, singleLineCommentIdx);
    }

    // Handle multi-line comment start
    const multiLineStart = line.indexOf("/*");
    if (multiLineStart !== -1) {
      const multiLineEnd = line.indexOf("*/", multiLineStart);
      if (multiLineEnd !== -1) {
        line = line.slice(0, multiLineStart) + line.slice(multiLineEnd + 2);
      } else {
        line = line.slice(0, multiLineStart);
        inMultiLineComment = true;
      }
    }

    // Count function/class/arrow function depth changes
    // This is a simplified heuristic - not a full parser
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Check for function/class/arrow declarations that increase depth
    if (/\b(function|class|async\s+function)\b/.test(line) && line.includes("{")) {
      depth += 1;
    } else if (/=>\s*\{/.test(line)) {
      depth += 1;
    }

    // Adjust depth for brace changes (simplified)
    depth += openBraces - closeBraces;
    if (depth < 0) depth = 0;

    // Check for await at top level (depth 0)
    if (depth === 0 && /\bawait\b/.test(line)) {
      // Make sure it's not inside a string
      const withoutStrings = line.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "");
      if (/\bawait\b/.test(withoutStrings)) {
        awaits.push(i + 1); // 1-indexed line numbers
      }
    }
  }

  return awaits;
}

// ============================================================================
// Output Helpers
// ============================================================================

/** Log output respecting quiet mode */
function log(ctx: BuildContext, message: string): void {
  if (!ctx.options.quiet) {
    console.log(message);
  }
}

/** Create a spinner respecting quiet mode */
function createSpinner(ctx: BuildContext, text: string): Ora {
  return ora({
    text,
    isSilent: ctx.options.quiet,
  });
}

/**
 * Run a dry-run build that shows what would be built without actually building.
 */
function runDryRun(ctx: BuildContext): void {
  console.log(styleText("bold", "Dry run mode - no files will be created\n"));

  console.log(styleText("bold", "Entry point:"));
  console.log(`  ${ctx.entryPath}\n`);

  console.log(styleText("bold", "Targets:"));
  for (const target of ctx.resolvedTargets) {
    const outputPath = getOutputPath(ctx, target);
    console.log(`  ${target} → ${outputPath}`);
  }
  console.log();

  if (ctx.options.include && ctx.options.include.length > 0) {
    console.log(styleText("bold", "Assets to include:"));
    for (const pattern of ctx.options.include) {
      console.log(`  ${pattern}`);
    }
    console.log();
  }

  console.log(styleText("bold", "Build steps:"));
  console.log("  1. Bundle user script with esbuild");
  console.log("  2. Copy thinkwell packages");
  console.log("  3. Generate wrapper entry point");
  console.log(`  4. Compile with pkg for ${ctx.resolvedTargets.length} target(s)`);
  console.log();

  // Check for potential issues
  const topLevelAwaits = detectTopLevelAwait(ctx.entryPath);
  if (topLevelAwaits.length > 0) {
    console.log(styleText("yellow", "Warning: Top-level await detected"));
    console.log("  Top-level await is not supported in compiled binaries.");
    console.log(`  Found at line(s): ${topLevelAwaits.join(", ")}`);
    console.log("  Wrap async code in an async main() function instead.\n");
  }

  console.log(styleText("dim", "Run without --dry-run to build."));
}

/**
 * Main build function.
 */
export async function runBuild(options: BuildOptions): Promise<void> {
  const ctx = initBuildContext(options);

  // Check for top-level await and warn
  const topLevelAwaits = detectTopLevelAwait(ctx.entryPath);
  if (topLevelAwaits.length > 0) {
    console.log(styleText("yellow", "Warning: Top-level await detected"));
    console.log("  Top-level await is not supported in compiled binaries.");
    console.log(`  Found at line(s): ${topLevelAwaits.join(", ")}`);
    console.log("  Wrap async code in an async main() function instead.\n");
  }

  // Handle dry-run mode
  if (options.dryRun) {
    runDryRun(ctx);
    return;
  }

  log(ctx, `Building ${styleText("bold", ctx.entryBasename)}...\n`);

  // Create build directory
  if (existsSync(ctx.buildDir)) {
    rmSync(ctx.buildDir, { recursive: true });
  }
  mkdirSync(ctx.buildDir, { recursive: true });

  try {
    // Stage 1: Bundle user script
    let spinner = createSpinner(ctx, "Bundling with esbuild...");
    spinner.start();

    const userBundlePath = await bundleUserScript(ctx);
    spinner.succeed("User script bundled");

    // Stage 2: Copy thinkwell bundles
    spinner = createSpinner(ctx, "Preparing thinkwell packages...");
    spinner.start();

    copyThinkwellBundles(ctx);
    spinner.succeed("Thinkwell packages ready");

    // Generate wrapper
    const wrapperPath = join(ctx.buildDir, "wrapper.cjs");
    const wrapperSource = generateWrapperSource(userBundlePath);
    writeFileSync(wrapperPath, wrapperSource);

    if (ctx.options.verbose) {
      log(ctx, "  Generated wrapper entry point");
    }

    // Stage 3: Compile with pkg for each target
    const outputs: string[] = [];

    for (const target of ctx.resolvedTargets) {
      const outputPath = getOutputPath(ctx, target);

      spinner = createSpinner(ctx, `Compiling for ${target}...`);
      spinner.start();

      await compileWithPkg(ctx, wrapperPath, target, outputPath);
      outputs.push(outputPath);

      spinner.succeed(`Built ${basename(outputPath)}`);
    }

    log(ctx, "");
    log(ctx, styleText("green", "Build complete!"));
    log(ctx, "");
    log(ctx, styleText("bold", "Output:"));
    for (const output of outputs) {
      log(ctx, `  ${output}`);
    }
  } finally {
    // Clean up build directory
    if (!ctx.options.verbose) {
      try {
        rmSync(ctx.buildDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    } else {
      log(ctx, `\nBuild artifacts preserved in: ${ctx.buildDir}`);
    }
  }
}

/**
 * Show help for the build command.
 */
export function showBuildHelp(): void {
  console.log(`
thinkwell build - Compile TypeScript scripts into standalone executables

Usage:
  thinkwell build [options] <entry>

Arguments:
  entry                  TypeScript or JavaScript entry point

Options:
  -o, --output <path>    Output file path (default: ./<name>-<target>)
  -t, --target <target>  Target platform (can be specified multiple times)
  --include <glob>       Additional files to embed as assets
  -n, --dry-run          Show what would be built without building
  -q, --quiet            Suppress all output except errors (for CI)
  -v, --verbose          Show detailed build output
  -h, --help             Show this help message

Targets:
  host                   Current platform (default)
  darwin-arm64           macOS on Apple Silicon
  darwin-x64             macOS on Intel
  linux-x64              Linux on x64
  linux-arm64            Linux on ARM64

Examples:
  thinkwell build src/agent.ts                     Build for current platform
  thinkwell build src/agent.ts -o dist/my-agent    Specify output path
  thinkwell build src/agent.ts --target linux-x64  Build for Linux
  thinkwell build src/agent.ts -t darwin-arm64 -t linux-x64  Multi-platform
  thinkwell build src/agent.ts --dry-run           Preview build without executing

The resulting binary is self-contained and includes:
  - Node.js 24 runtime with TypeScript support
  - All thinkwell packages
  - Your bundled application code

Note: Binaries are ~70-90 MB due to the embedded Node.js runtime.
`);
}
