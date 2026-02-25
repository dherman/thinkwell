/**
 * Bundle command for creating self-contained executables from user scripts.
 *
 * This module provides the `thinkwell bundle` command that compiles user scripts
 * into standalone binaries using the same pkg-based tooling as the thinkwell CLI.
 *
 * The bundle process follows a two-stage pipeline:
 * 1. **Pre-bundle with esbuild** - Bundle user script + thinkwell packages into CJS
 * 2. **Compile with pkg** - Create self-contained binary with Node.js runtime
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
  createWriteStream,
  watch as fsWatch,
} from "node:fs";
import { dirname, resolve, basename, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { homedir, tmpdir } from "node:os";
import { cyan, cyanBold, greenBold, whiteBold, dim } from "./fmt.js";
import { createHash } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import * as esbuild from "esbuild";
import { transformJsonSchemas, hasJsonSchemaMarkers } from "./schema.js";
import { findProjectRoot, checkDependencies } from "./dependency-check.js";
import { hasMissingDeps, formatMissingDepsError } from "./dependency-errors.js";

// ============================================================================
// Simple Spinner Implementation
// ============================================================================
//
// We use a custom spinner instead of ora because ora's restore-cursor dependency
// evaluates process.stderr.isTTY at module load time, which crashes V8 during
// bootstrap in pkg's virtual filesystem environment when stderr is a TTY.
// See doc/debugging-build-crash.md for full analysis.
//
// This implementation lazily checks isTTY only when start() is called.

interface Spinner {
  start(text?: string): Spinner;
  stop(): Spinner;
  succeed(text?: string): Spinner;
  fail(text?: string): Spinner;
  text: string;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 80;

function createSpinnerImpl(options: { text: string; isSilent?: boolean }): Spinner {
  let text = options.text;
  let interval: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  const isSilent = options.isSilent ?? false;

  // Check TTY lazily - only when we actually try to render
  const isTTY = () => process.stderr.isTTY === true;

  const clearLine = () => {
    if (isTTY()) {
      process.stderr.write("\r\x1b[K");
    }
  };

  const render = () => {
    if (isSilent) return;
    if (isTTY()) {
      const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
      process.stderr.write(`\r${frame} ${text}`);
      frameIndex++;
    }
  };

  const spinner: Spinner = {
    get text() {
      return text;
    },
    set text(value: string) {
      text = value;
    },

    start(newText?: string) {
      if (newText) text = newText;
      if (isSilent) return this;

      if (isTTY()) {
        render();
        interval = setInterval(render, SPINNER_INTERVAL);
      } else {
        // Non-TTY: just print the text with a dash prefix
        process.stderr.write(`- ${text}\n`);
      }
      return this;
    },

    stop() {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      clearLine();
      return this;
    },

    succeed(successText?: string) {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      if (isSilent) return this;

      const finalText = successText ?? text;
      if (isTTY()) {
        process.stderr.write(`\r\x1b[K✔ ${finalText}\n`);
      } else {
        process.stderr.write(`✔ ${finalText}\n`);
      }
      return this;
    },

    fail(failText?: string) {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      if (isSilent) return this;

      const finalText = failText ?? text;
      if (isTTY()) {
        process.stderr.write(`\r\x1b[K✖ ${finalText}\n`);
      } else {
        process.stderr.write(`✖ ${finalText}\n`);
      }
      return this;
    },
  };

  return spinner;
}

// Handle both ESM and CJS contexts for __dirname
// When bundled to CJS, import.meta.url won't work, but global __dirname will
const __dirname = typeof import.meta?.url === "string"
  ? dirname(fileURLToPath(import.meta.url))
  : (globalThis as any).__dirname || dirname(process.argv[1]);

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

export interface BundleOptions {
  /** Entry point TypeScript/JavaScript file */
  entry: string;
  /** Output file path (default: ./<entry-basename>-<target>) */
  output?: string;
  /** Target platforms (default: ["host"]) */
  targets?: Target[];
  /** Additional files to embed as assets */
  include?: string[];
  /** Packages to exclude from bundling (kept as external imports) */
  external?: string[];
  /** Show detailed build output */
  verbose?: boolean;
  /** Suppress all non-error output (for CI environments) */
  quiet?: boolean;
  /** Show what would be built without actually building */
  dryRun?: boolean;
  /** Minify the bundled output for smaller binaries */
  minify?: boolean;
  /** Watch for changes and rebuild automatically */
  watch?: boolean;
}

/**
 * Configuration that can be specified in package.json under "thinkwell.bundle".
 */
export interface PackageJsonBundleConfig {
  /** Default output path */
  output?: string;
  /** Default target platforms */
  targets?: Target[];
  /** Default assets to include */
  include?: string[];
  /** Default packages to exclude from bundling */
  external?: string[];
  /** Default minification setting */
  minify?: boolean;
}

/**
 * Read build configuration from package.json in the given directory.
 * Returns undefined if no configuration is found.
 */
function readPackageJsonConfig(dir: string): PackageJsonBundleConfig | undefined {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);

    // Look for "thinkwell.bundle" configuration
    const config = pkg?.thinkwell?.bundle;
    if (!config || typeof config !== "object") {
      return undefined;
    }

    // Validate and extract configuration
    const result: PackageJsonBundleConfig = {};

    if (typeof config.output === "string") {
      result.output = config.output;
    }

    if (Array.isArray(config.targets)) {
      const validTargets: Target[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "host"];
      result.targets = config.targets.filter((t: unknown): t is Target =>
        typeof t === "string" && validTargets.includes(t as Target)
      );
    }

    if (Array.isArray(config.include)) {
      result.include = config.include.filter((i: unknown): i is string => typeof i === "string");
    }

    if (Array.isArray(config.external)) {
      result.external = config.external.filter((e: unknown): e is string => typeof e === "string");
    }

    if (typeof config.minify === "boolean") {
      result.minify = config.minify;
    }

    return result;
  } catch {
    // Ignore JSON parse errors
    return undefined;
  }
}

/**
 * Merge package.json configuration with CLI options.
 * CLI options take precedence over package.json configuration.
 */
function mergeWithPackageConfig(options: BundleOptions, entryDir: string): BundleOptions {
  const pkgConfig = readPackageJsonConfig(entryDir);
  if (!pkgConfig) {
    return options;
  }

  // CLI options take precedence - only use package.json defaults for unset values
  return {
    ...options,
    output: options.output ?? pkgConfig.output,
    targets: options.targets && options.targets.length > 0
      ? options.targets
      : pkgConfig.targets ?? options.targets,
    include: [
      ...(pkgConfig.include || []),
      ...(options.include || []),
    ],
    external: [
      ...(pkgConfig.external || []),
      ...(options.external || []),
    ],
    minify: options.minify ?? pkgConfig.minify,
  };
}

interface BundleContext {
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
  options: BundleOptions;
  /** Project root directory (when package.json found), for resolving project-local deps */
  projectDir?: string;
}

/**
 * Parse and validate build options from command-line arguments.
 */
export function parseBundleArgs(args: string[]): BundleOptions {
  const options: BundleOptions = {
    entry: "",
    targets: [],
    include: [],
    external: [],
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
    } else if (arg === "--external" || arg === "-e") {
      i++;
      if (i >= args.length) {
        throw new Error("Missing value for --external");
      }
      options.external!.push(args[i]);
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else if (arg === "--dry-run" || arg === "-n") {
      options.dryRun = true;
    } else if (arg === "--minify" || arg === "-m") {
      options.minify = true;
    } else if (arg === "--watch" || arg === "-w") {
      options.watch = true;
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
function initBundleContext(options: BundleOptions): BundleContext {
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

  // Merge CLI options with package.json configuration
  // Check both entry directory and current working directory for package.json
  let mergedOptions = mergeWithPackageConfig(options, entryDir);
  if (entryDir !== process.cwd()) {
    mergedOptions = mergeWithPackageConfig(mergedOptions, process.cwd());
  }

  // Create build directory in system temp directory using mkdtempSync for atomicity
  const buildDir = mkdtempSync(join(tmpdir(), `thinkwell-bundle-${entryBasename}-`));

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
  const resolvedTargets = mergedOptions.targets!.map((t) =>
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
    options: mergedOptions,
  };
}

/**
 * Generate the output path for a given target.
 */
function getOutputPath(ctx: BundleContext, target: Exclude<Target, "host">): string {
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
 * Generated wrapper for thinkwell bundle.
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
async function bundleUserScript(ctx: BundleContext): Promise<string> {
  const outputFile = join(ctx.buildDir, `${ctx.entryBasename}-bundle.cjs`);

  if (ctx.options.verbose) {
    console.log(`  Bundling ${ctx.entryPath}...`);
  }

  // Note: When running from a compiled binary, ESBUILD_BINARY_PATH is set
  // by main-pkg.cjs before this module loads.
  try {
    // Combine Node built-ins with user-specified external packages
    const externalPackages = ["node:*", ...(ctx.options.external || [])];

    await esbuild.build({
      entryPoints: [ctx.entryPath],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: outputFile,
      // External: Node built-ins and user-specified packages
      external: externalPackages,
      // Mark thinkwell packages as external - they're provided via global.__bundled__
      // But actually, we need to transform the imports, so let's bundle them
      // and use a banner to set up the module aliases
      banner: {
        js: `
// Alias thinkwell packages to global.__bundled__
const __origRequire = require;
require = function(id) {
  if (id === 'thinkwell') {
    return global.__bundled__['thinkwell'];
  }
  if (id === '@thinkwell/acp') {
    return global.__bundled__['@thinkwell/acp'];
  }
  if (id === '@thinkwell/protocol') {
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
        // Transform @JSONSchema types into namespace declarations with schema providers
        {
          name: "jsonschema-transformer",
          setup(build) {
            build.onLoad({ filter: /\.(ts|tsx|mts|cts)$/ }, async (args) => {
              // Skip node_modules
              if (args.path.includes("node_modules")) {
                return null;
              }

              const source = readFileSync(args.path, "utf-8");

              // Fast path: skip files without @JSONSchema markers
              if (!hasJsonSchemaMarkers(source)) {
                return null;
              }

              // Transform the source to inject schema namespaces
              const transformed = transformJsonSchemas(args.path, source, ctx.projectDir);

              return {
                contents: transformed,
                loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
              };
            });
          },
        },
        {
          name: "thinkwell-resolver",
          setup(build) {
            // Mark thinkwell packages as external - provided via global.__bundled__ at runtime
            build.onResolve({ filter: /^(thinkwell|@thinkwell\/(acp|protocol))$/ }, (args) => {
              return { path: args.path, external: true };
            });
          },
        },
      ],
      sourcemap: false,
      minify: ctx.options.minify ?? false,
      keepNames: !ctx.options.minify, // Keep names unless minifying
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
function copyThinkwellBundles(ctx: BundleContext): void {
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
 * Check if running from a pkg-compiled binary.
 */
function isRunningFromCompiledBinary(): boolean {
  // @ts-expect-error process.pkg is set by pkg at runtime
  return typeof process.pkg !== "undefined";
}

// ============================================================================
// Portable Node.js Download (for compiled binary builds)
// ============================================================================

/** Pinned Node.js version for portable runtime */
const PORTABLE_NODE_VERSION = "24.1.0";

/** Get the thinkwell cache directory */
function getCacheDir(): string {
  return process.env.THINKWELL_CACHE_DIR || join(homedir(), ".cache", "thinkwell");
}

/** Get the thinkwell version from package.json */
function getThinkwellVersion(): string {
  try {
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Map process.platform/arch to Node.js download format.
 */
function getNodePlatformArch(): { platform: string; arch: string } {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch; // x64 or arm64
  return { platform, arch };
}

/**
 * Download a file from a URL with progress reporting.
 */
async function downloadFile(
  url: string,
  destPath: string,
  spinner?: Spinner
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

  // Ensure directory exists
  mkdirSync(dirname(destPath), { recursive: true });

  const fileStream = createWriteStream(destPath);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  let downloadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      fileStream.write(Buffer.from(value));
      downloadedBytes += value.length;

      if (spinner && totalBytes > 0) {
        const percent = Math.round((downloadedBytes / totalBytes) * 100);
        const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1);
        const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
        spinner.text = `Downloading Node.js runtime... ${downloadedMB} MB / ${totalMB} MB (${percent}%)`;
      }
    }
  } finally {
    fileStream.end();
  }

  // Wait for file to be fully written
  await new Promise<void>((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });
}

/**
 * Compute SHA-256 hash of a file.
 */
function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Fetch the expected SHA-256 checksum for a Node.js download.
 */
async function fetchExpectedChecksum(version: string, filename: string): Promise<string> {
  const url = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch checksums: ${response.status}`);
  }

  const text = await response.text();
  for (const line of text.split("\n")) {
    // Format: "hash  filename"
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2 && parts[1] === filename) {
      return parts[0];
    }
  }

  throw new Error(`Checksum not found for ${filename}`);
}

/**
 * Extract a .tar.gz archive using the system tar command.
 */
function extractTarGz(archivePath: string, destDir: string): void {
  execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, {
    stdio: "pipe",
  });
}

/**
 * Ensure portable Node.js is available in the cache.
 *
 * Downloads from nodejs.org if not cached, verifies checksum, and extracts.
 * Returns the path to the node binary.
 */
async function ensurePortableNode(spinner?: Spinner): Promise<string> {
  const version = PORTABLE_NODE_VERSION;
  const { platform, arch } = getNodePlatformArch();
  const cacheDir = join(getCacheDir(), "node", `v${version}`);
  const nodeBinary = process.platform === "win32" ? "node.exe" : "node";
  const nodePath = join(cacheDir, nodeBinary);

  // Check if already cached
  if (existsSync(nodePath)) {
    return nodePath;
  }

  const filename = `node-v${version}-${platform}-${arch}.tar.gz`;
  const url = `https://nodejs.org/dist/v${version}/${filename}`;
  const archivePath = join(cacheDir, filename);

  spinner?.start("Downloading Node.js runtime (first time only)...");

  try {
    // Ensure cache directory exists
    mkdirSync(cacheDir, { recursive: true });

    // Download
    await downloadFile(url, archivePath, spinner);

    // Verify checksum
    spinner?.start("Verifying download integrity...");
    const expectedHash = await fetchExpectedChecksum(version, filename);
    const actualHash = hashFile(archivePath);

    if (actualHash !== expectedHash) {
      // Clean up the corrupted download
      rmSync(archivePath, { force: true });
      throw new Error(
        `Node.js download verification failed.\n\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}\n\n` +
        `This may indicate a corrupted download or network interference.\n` +
        `Please retry or report this issue.`
      );
    }

    // Extract
    spinner?.start("Extracting Node.js...");
    extractTarGz(archivePath, cacheDir);

    // Move node binary to cache root
    // The tarball extracts to node-v{version}-{platform}-{arch}/bin/node
    const extractedDir = join(cacheDir, `node-v${version}-${platform}-${arch}`);
    const extractedBin = join(extractedDir, "bin", nodeBinary);
    copyFileSync(extractedBin, nodePath);
    chmodSync(nodePath, 0o755);

    // Cleanup: remove extracted directory and archive
    rmSync(extractedDir, { recursive: true, force: true });
    rmSync(archivePath, { force: true });

    spinner?.succeed(`Node.js v${version} cached to ${cacheDir}`);
    return nodePath;
  } catch (error) {
    // Cleanup on error
    rmSync(cacheDir, { recursive: true, force: true });

    const message = error instanceof Error ? error.message : String(error);

    // Provide helpful error messages
    if (message.includes("ETIMEDOUT") || message.includes("ENOTFOUND")) {
      throw new Error(
        `Failed to download Node.js runtime.\n\n` +
        `  URL: ${url}\n` +
        `  Error: ${message}\n\n` +
        `Check your network connection and try again.\n` +
        `If behind a proxy, set HTTPS_PROXY environment variable.`
      );
    }

    throw error;
  }
}

/**
 * Ensure the pkg CLI bundle and its auxiliary files are extracted from the
 * compiled binary's assets.
 *
 * pkg requires several auxiliary files at runtime:
 * - pkg-cli.cjs - The main bundled CLI
 * - package.json - pkg's version info (read as ../package.json from cacheDir)
 * - pkg-prelude/ - JavaScript files injected into compiled binaries
 * - pkg-dictionary/ - Compression dictionaries for bytecode
 * - pkg-common.cjs - Common utilities
 *
 * Returns the path to the extracted pkg-cli.cjs file.
 */
function ensurePkgCli(): string {
  const version = getThinkwellVersion();
  const pkgCliBaseDir = join(getCacheDir(), "pkg-cli");
  const cacheDir = join(pkgCliBaseDir, version);
  const pkgCliPath = join(cacheDir, "pkg-cli.cjs");

  // Check if already cached (check for main file and a prelude file)
  const preludeCheck = join(cacheDir, "pkg-prelude", "bootstrap.js");
  if (existsSync(pkgCliPath) && existsSync(preludeCheck)) {
    return pkgCliPath;
  }

  // Base path for pkg assets in the compiled binary's snapshot
  const distPkgPath = resolve(__dirname, "../../dist-pkg");

  // Extract main CLI bundle
  const cliSrc = join(distPkgPath, "pkg-cli.cjs");
  if (!existsSync(cliSrc)) {
    throw new Error(
      `pkg CLI not found in compiled binary assets.\n` +
      `  Expected at: ${cliSrc}\n\n` +
      `This may indicate a build issue. Please report this.`
    );
  }

  mkdirSync(cacheDir, { recursive: true });
  copyFileSync(cliSrc, pkgCliPath);

  // Extract pkg's package.json (for version info)
  // pkg reads ../package.json relative to __dirname (which is cacheDir)
  // So we place it in the parent directory (pkgCliBaseDir)
  const pkgJsonSrc = join(distPkgPath, "package.json");
  if (existsSync(pkgJsonSrc)) {
    copyFileSync(pkgJsonSrc, join(pkgCliBaseDir, "package.json"));
  }

  // Extract prelude files
  const preludeDir = join(cacheDir, "pkg-prelude");
  mkdirSync(preludeDir, { recursive: true });
  for (const file of ["bootstrap.js", "diagnostic.js"]) {
    const src = join(distPkgPath, "pkg-prelude", file);
    if (existsSync(src)) {
      copyFileSync(src, join(preludeDir, file));
    }
  }

  // Extract common.js
  const commonSrc = join(distPkgPath, "pkg-common.cjs");
  if (existsSync(commonSrc)) {
    copyFileSync(commonSrc, join(cacheDir, "pkg-common.cjs"));
  }

  // Extract dictionary files
  // pkg reads ../dictionary relative to __dirname (which is cacheDir)
  // So we place it in the parent directory (pkgCliBaseDir/dictionary/)
  const dictionaryDir = join(pkgCliBaseDir, "dictionary");
  mkdirSync(dictionaryDir, { recursive: true });
  for (const file of ["v8-7.8.js", "v8-8.4.js", "v8-12.4.js"]) {
    const src = join(distPkgPath, "pkg-dictionary", file);
    if (existsSync(src)) {
      copyFileSync(src, join(dictionaryDir, file));
    }
  }

  return pkgCliPath;
}

/**
 * Spawn a subprocess and wait for completion.
 */
function spawnAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    verbose?: boolean;
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: options.verbose ? "inherit" : "pipe",
    });

    let stdout = "";
    let stderr = "";

    if (!options.verbose) {
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
    }

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    proc.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message,
      });
    });
  });
}

/**
 * Compile using pkg via subprocess (for compiled binary environment).
 *
 * This function is called when running from a compiled thinkwell binary.
 * It downloads a portable Node.js runtime and uses the bundled pkg CLI
 * to perform the compilation as a subprocess.
 */
async function compileWithPkgSubprocess(
  ctx: BundleContext,
  wrapperPath: string,
  target: Exclude<Target, "host">,
  outputPath: string,
  spinner?: Spinner
): Promise<void> {
  // Ensure portable Node.js is available
  const nodePath = await ensurePortableNode(spinner);

  // Extract pkg CLI from snapshot
  const pkgCliPath = ensurePkgCli();

  const pkgTarget = TARGET_MAP[target];

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Build pkg CLI arguments
  const args = [
    pkgCliPath,
    wrapperPath,
    "--targets",
    pkgTarget,
    "--output",
    outputPath,
    "--options",
    "experimental-transform-types,disable-warning=ExperimentalWarning",
    "--public",
  ];

  // Add assets if specified
  if (ctx.options.include && ctx.options.include.length > 0) {
    for (const pattern of ctx.options.include) {
      args.push("--assets", pattern);
    }
  }

  spinner?.start(`Compiling for ${target}...`);

  const result = await spawnAsync(nodePath, args, {
    cwd: ctx.buildDir,
    env: {
      ...process.env,
      // Set pkg cache path for pkg-fetch downloads
      PKG_CACHE_PATH: join(getCacheDir(), "pkg-cache"),
    },
    verbose: ctx.options.verbose,
  });

  if (result.exitCode !== 0) {
    const errorOutput = result.stderr || result.stdout;
    throw new Error(
      `pkg compilation failed for ${target}.\n\n` +
      `Exit code: ${result.exitCode}\n` +
      (errorOutput ? `Output:\n${errorOutput}` : "")
    );
  }
}

/**
 * Stage 2: Compile with pkg.
 *
 * Uses @yao-pkg/pkg to create a self-contained binary.
 *
 * When running from a compiled thinkwell binary, this function uses a
 * subprocess approach: downloading a portable Node.js runtime and executing
 * the bundled pkg CLI as a child process. This works around pkg's dynamic
 * import limitations in the virtual filesystem.
 *
 * When running from npm/source, this function uses @yao-pkg/pkg programmatically.
 */
async function compileWithPkg(
  ctx: BundleContext,
  wrapperPath: string,
  target: Exclude<Target, "host">,
  outputPath: string,
  spinner?: Spinner
): Promise<void> {
  // When running from a compiled binary, use subprocess approach
  if (isRunningFromCompiledBinary()) {
    await compileWithPkgSubprocess(ctx, wrapperPath, target, outputPath, spinner);
    return;
  }

  // Normal path: use pkg programmatically
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
function log(ctx: BundleContext, message: string): void {
  if (!ctx.options.quiet) {
    console.log(message);
  }
}

/** Create a spinner respecting quiet mode */
function createSpinner(ctx: BundleContext, text: string): Spinner {
  return createSpinnerImpl({
    text,
    isSilent: ctx.options.quiet,
  });
}

/**
 * Run a dry-run build that shows what would be built without actually building.
 */
function runDryRun(ctx: BundleContext): void {
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

  if (ctx.options.external && ctx.options.external.length > 0) {
    console.log(styleText("bold", "External packages (not bundled):"));
    for (const pkg of ctx.options.external) {
      console.log(`  ${pkg}`);
    }
    console.log();
  }

  if (ctx.options.minify) {
    console.log(styleText("bold", "Minification:"), "enabled");
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
export async function runBundle(options: BundleOptions): Promise<void> {
  // Check for project-level dependencies when a package.json exists
  const entryPath = isAbsolute(options.entry)
    ? options.entry
    : resolve(process.cwd(), options.entry);
  const projectRoot = findProjectRoot(dirname(entryPath));
  if (projectRoot && existsSync(entryPath)) {
    const source = readFileSync(entryPath, "utf-8");
    const requireTypescript = hasJsonSchemaMarkers(source);

    const depCheck = await checkDependencies(projectRoot);
    if (hasMissingDeps(depCheck, { requireTypescript })) {
      process.stderr.write(formatMissingDepsError(depCheck, { requireTypescript }) + "\n");
      process.exit(2);
    }
  }

  // Handle watch mode separately
  if (options.watch) {
    await runWatchMode(options, projectRoot);
    return;
  }

  const ctx = initBundleContext(options);
  ctx.projectDir = projectRoot;

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

      await compileWithPkg(ctx, wrapperPath, target, outputPath, spinner);
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
 * Run the build in watch mode, rebuilding on file changes.
 */
async function runWatchMode(options: BundleOptions, projectDir?: string): Promise<void> {
  const ctx = initBundleContext(options);
  ctx.projectDir = projectDir;

  console.log(styleText("bold", `Watching ${ctx.entryBasename} for changes...`));
  console.log(styleText("dim", "Press Ctrl+C to stop.\n"));

  // Track if a build is currently in progress
  let buildInProgress = false;
  let rebuildQueued = false;

  // Debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 100;

  async function doBuild(): Promise<void> {
    if (buildInProgress) {
      rebuildQueued = true;
      return;
    }

    buildInProgress = true;
    rebuildQueued = false;

    const startTime = Date.now();
    console.log(styleText("dim", `[${new Date().toLocaleTimeString()}] Building...`));

    try {
      // Re-initialize context to pick up any config changes
      const freshCtx = initBundleContext(options);

      // Create build directory
      if (existsSync(freshCtx.buildDir)) {
        rmSync(freshCtx.buildDir, { recursive: true });
      }
      mkdirSync(freshCtx.buildDir, { recursive: true });

      // Bundle user script
      const userBundlePath = await bundleUserScript(freshCtx);

      // Copy thinkwell bundles
      copyThinkwellBundles(freshCtx);

      // Generate wrapper
      const wrapperPath = join(freshCtx.buildDir, "wrapper.cjs");
      const wrapperSource = generateWrapperSource(userBundlePath);
      writeFileSync(wrapperPath, wrapperSource);

      // Compile with pkg for each target
      const outputs: string[] = [];
      for (const target of freshCtx.resolvedTargets) {
        const outputPath = getOutputPath(freshCtx, target);
        await compileWithPkg(freshCtx, wrapperPath, target, outputPath);
        outputs.push(outputPath);
      }

      // Clean up build directory
      if (!freshCtx.options.verbose) {
        try {
          rmSync(freshCtx.buildDir, { recursive: true });
        } catch {
          // Ignore cleanup errors
        }
      }

      const elapsed = Date.now() - startTime;
      console.log(styleText("green", `✓ Built in ${elapsed}ms`));
      for (const output of outputs) {
        console.log(styleText("dim", `  ${basename(output)}`));
      }
      console.log();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(styleText("red", `✗ Build failed: ${message}`));
      console.log();
    } finally {
      buildInProgress = false;

      // If a rebuild was queued while building, start another build
      if (rebuildQueued) {
        doBuild();
      }
    }
  }

  function scheduleRebuild(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      doBuild();
    }, DEBOUNCE_MS);
  }

  // Do initial build
  await doBuild();

  // Watch the entry file's directory for changes
  const watchDir = ctx.entryDir;
  const watcher = fsWatch(watchDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;

    // Ignore common non-source files
    if (
      filename.includes("node_modules") ||
      filename.startsWith(".") ||
      filename.endsWith(".d.ts")
    ) {
      return;
    }

    // Only watch TypeScript and JavaScript files
    if (!/\.(ts|tsx|js|jsx|mts|mjs|cts|cjs|json)$/.test(filename)) {
      return;
    }

    if (ctx.options.verbose) {
      console.log(styleText("dim", `  Changed: ${filename}`));
    }

    scheduleRebuild();
  });

  // Handle graceful shutdown
  const cleanup = () => {
    watcher.close();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    console.log("\nStopped watching.");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Show help for the build command.
 */
export function showBundleHelp(): void {
  console.log(`
${cyanBold("thinkwell bundle")} - ${whiteBold("Compile TypeScript scripts into standalone executables")}

${greenBold("Usage:")}
  ${cyanBold("thinkwell bundle")} ${cyan("[options] <entry>")}

${greenBold("Arguments:")}
  ${cyan("entry")}                  TypeScript or JavaScript entry point

${greenBold("Options:")}
  ${cyan("-o, --output")} ${dim("<path>")}    Output file path ${dim("(default: ./<name>-<target>)")}
  ${cyan("-t, --target")} ${dim("<target>")}  Target platform ${dim("(can be specified multiple times)")}
  ${cyan("--include")} ${dim("<glob>")}       Additional files to embed as assets
  ${cyan("-e, --external")} ${dim("<pkg>")}   Exclude package from bundling ${dim("(can be repeated)")}
  ${cyan("-m, --minify")}           Minify the bundled code for smaller output
  ${cyan("-w, --watch")}            Watch for changes and rebuild automatically
  ${cyan("-n, --dry-run")}          Show what would be built without building
  ${cyan("-q, --quiet")}            Suppress all output except errors ${dim("(for CI)")}
  ${cyan("-v, --verbose")}          Show detailed build output
  ${cyan("-h, --help")}             Show this help message

${greenBold("Targets:")}
  ${cyan("host")}                   Current platform ${dim("(default)")}
  ${cyan("darwin-arm64")}           macOS on Apple Silicon
  ${cyan("darwin-x64")}             macOS on Intel
  ${cyan("linux-x64")}              Linux on x64
  ${cyan("linux-arm64")}            Linux on ARM64

${greenBold("Examples:")}
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts")}                     Bundle for current platform
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts -o dist/my-agent")}    Specify output path
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts --target linux-x64")}  Bundle for Linux
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts -t darwin-arm64 -t linux-x64")}  Multi-platform
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts --dry-run")}           Preview bundle without executing
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts -e sqlite3")}          Keep sqlite3 as external
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts --minify")}            Minify for smaller binary
  ${cyanBold("thinkwell bundle")} ${cyan("src/agent.ts --watch")}             Rebuild on file changes

The resulting binary is self-contained and includes:
  - Node.js 24 runtime with TypeScript support
  - All thinkwell packages
  - Your bundled application code

${greenBold("Configuration via package.json:")}
  Add a "thinkwell" key to your package.json to set defaults:

    {
      "thinkwell": {
        "bundle": {
          "output": "dist/my-agent",
          "targets": ["darwin-arm64", "linux-x64"],
          "external": ["sqlite3"],
          "minify": true
        }
      }
    }

  CLI options override package.json settings.

${dim("Note: Binaries are ~70-90 MB due to the embedded Node.js runtime.")}
${dim("      Use --minify to reduce bundle size (though Node.js runtime dominates).")}
`.trim() + "\n");
}
