#!/usr/bin/env bun
/**
 * Build script for creating self-contained thinkwell CLI executables.
 *
 * Uses `bun build --compile` to create native binaries for different platforms.
 * The resulting binaries include the Bun runtime and can run without any
 * external dependencies (except Bun for running user scripts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT_DIR = resolve(dirname(import.meta.path), "..");
const DIST_DIR = resolve(ROOT_DIR, "dist-bin");
const CLI_ENTRY = resolve(ROOT_DIR, "src/cli/main.ts");

// Supported build targets
type Target = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

// Default targets for local builds (macOS only)
// CI builds specify targets explicitly for cross-platform support
const TARGETS: Target[] = ["darwin-arm64", "darwin-x64"];

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

  console.log(`Building ${outputName}...`);

  // Build command
  const cmd = [
    "bun",
    "build",
    "--compile",
    `--target=bun-${target}`,
    `--outfile=${outputPath}`,
    CLI_ENTRY,
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
build-binary.ts - Build self-contained thinkwell CLI executables

Usage:
  bun scripts/build-binary.ts [options] [targets...]

Options:
  --verbose, -v    Show detailed build output
  --help, -h       Show this help message

Targets:
  darwin-arm64     macOS on Apple Silicon (default)
  darwin-x64       macOS on Intel
  linux-x64        Linux on x64
  linux-arm64      Linux on ARM64

Examples:
  bun scripts/build-binary.ts                    Build for darwin-arm64 and darwin-x64
  bun scripts/build-binary.ts darwin-arm64       Build only for Apple Silicon
  bun scripts/build-binary.ts --verbose          Build with detailed output
`);
    process.exit(0);
  }

  // Parse target arguments
  const targetArgs = args.filter(
    (arg) => !arg.startsWith("-")
  ) as Target[];
  const targets = targetArgs.length > 0 ? targetArgs : TARGETS;

  // Validate targets
  const validTargets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
  for (const target of targets) {
    if (!validTargets.includes(target)) {
      console.error(`Error: Invalid target '${target}'`);
      console.error(`Valid targets: ${validTargets.join(", ")}`);
      process.exit(1);
    }
  }

  const version = getVersion();
  console.log(`Building thinkwell v${version}\n`);

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
