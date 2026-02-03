#!/usr/bin/env tsx
/**
 * Build script for creating self-contained thinkwell CLI executables using pkg.
 *
 * Uses `@yao-pkg/pkg` to create native binaries for different platforms.
 * The resulting binaries include Node.js 24 with --experimental-transform-types
 * enabled, allowing execution of TypeScript user scripts including namespace
 * declarations (required for @JSONSchema support).
 *
 * Unlike the Bun-based build, pkg binaries can properly resolve external
 * npm packages from the user's node_modules at runtime.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const DIST_DIR = resolve(ROOT_DIR, "dist-bin");
// Use the CommonJS entry point directly (not compiled from TypeScript)
// pkg works best with CommonJS, so we use a .cjs file
const CLI_ENTRY = resolve(ROOT_DIR, "src/cli/main-pkg.cjs");

// Supported build targets (pkg uses different naming than Bun)
type Target = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

// Map our target names to pkg target names
const TARGET_MAP: Record<Target, string> = {
  "darwin-arm64": "node24-macos-arm64",
  "darwin-x64": "node24-macos-x64",
  "linux-x64": "node24-linux-x64",
  "linux-arm64": "node24-linux-arm64",
};

// Default targets for local builds (macOS only)
// CI builds specify targets explicitly for cross-platform support
const DEFAULT_TARGETS: Target[] = ["darwin-arm64", "darwin-x64"];

interface BuildOptions {
  targets?: Target[];
  verbose?: boolean;
}

function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(ROOT_DIR, "package.json"), "utf-8")
  );
  return packageJson.version;
}

function ensureDistDir(): void {
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }
}

function buildTarget(target: Target, version: string, verbose: boolean): void {
  const outputName = `thinkwell-${target}`;
  const outputPath = resolve(DIST_DIR, outputName);
  const pkgTarget = TARGET_MAP[target];

  console.log(`Building ${outputName}...`);

  // Build command using pkg
  // --options experimental-transform-types enables full TypeScript support including
  // namespace declarations (required for @JSONSchema-generated code)
  // --options disable-warning=ExperimentalWarning suppresses the noisy warning
  // --public includes source files instead of bytecode (required for ESM modules)
  // --config points to package.json for asset configuration
  const cmd = [
    "npx",
    "pkg",
    CLI_ENTRY,
    `--targets=${pkgTarget}`,
    "--options=experimental-transform-types,disable-warning=ExperimentalWarning",
    "--public",
    `--output=${outputPath}`,
    `--config=${resolve(ROOT_DIR, "package.json")}`,
  ];

  if (verbose) {
    console.log(`  Command: ${cmd.join(" ")}`);
  }

  try {
    execSync(cmd.join(" "), {
      cwd: ROOT_DIR,
      stdio: verbose ? "inherit" : "pipe",
      env: {
        ...process.env,
        // Ensure we use the workspace dependencies
        NODE_PATH: resolve(ROOT_DIR, "node_modules"),
      },
    });
    console.log(`  ✓ Built: ${outputPath}`);
  } catch (error) {
    console.error(`  ✗ Failed to build ${target}`);
    if (error instanceof Error && "stderr" in error) {
      console.error((error as any).stderr?.toString());
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const helpRequested = args.includes("--help") || args.includes("-h");

  if (helpRequested) {
    console.log(`
build-binary-pkg.ts - Build self-contained thinkwell CLI executables using pkg

Usage:
  tsx scripts/build-binary-pkg.ts [options] [targets...]

Options:
  --verbose, -v    Show detailed build output
  --help, -h       Show this help message

Targets:
  darwin-arm64     macOS on Apple Silicon (default)
  darwin-x64       macOS on Intel
  linux-x64        Linux on x64
  linux-arm64      Linux on ARM64

Examples:
  tsx scripts/build-binary-pkg.ts                    Build for darwin-arm64 and darwin-x64
  tsx scripts/build-binary-pkg.ts darwin-arm64       Build only for Apple Silicon
  tsx scripts/build-binary-pkg.ts --verbose          Build with detailed output

Note: This script requires the TypeScript build to be run first (pnpm build).
      The pkg binary uses Node 24 with --experimental-transform-types for native TS.
`);
    process.exit(0);
  }

  // Parse target arguments
  const targetArgs = args.filter(
    (arg) => !arg.startsWith("-")
  ) as Target[];
  const targets = targetArgs.length > 0 ? targetArgs : DEFAULT_TARGETS;

  // Validate targets
  const validTargets = Object.keys(TARGET_MAP);
  for (const target of targets) {
    if (!validTargets.includes(target)) {
      console.error(`Error: Invalid target '${target}'`);
      console.error(`Valid targets: ${validTargets.join(", ")}`);
      process.exit(1);
    }
  }

  const version = getVersion();
  console.log(`Building thinkwell v${version} with pkg\n`);

  // Ensure the CLI entry point exists
  if (!existsSync(CLI_ENTRY)) {
    console.error(`Error: CLI entry point not found: ${CLI_ENTRY}`);
    console.error("Run 'pnpm build' first to compile TypeScript sources.");
    process.exit(1);
  }

  ensureDistDir();

  let failed = 0;
  for (const target of targets) {
    try {
      buildTarget(target, version, verbose);
    } catch {
      failed++;
    }
  }

  console.log("");
  if (failed > 0) {
    console.log(`Build completed with ${failed} failure(s).`);
    process.exit(1);
  } else {
    console.log(`Build completed successfully!`);
    console.log(`Binaries are in: ${DIST_DIR}`);
  }
}

main().catch((error) => {
  console.error("Build failed:", error.message);
  process.exit(1);
});
