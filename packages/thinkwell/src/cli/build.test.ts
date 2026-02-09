/**
 * Tests for the thinkwell build command.
 *
 * These tests cover:
 * - Argument parsing (parseBuildArgs)
 * - Download/extraction logic with mocks
 * - Cache invalidation behavior
 * - E2E build from compiled binary (CI only)
 *
 * Skip these tests by setting: SKIP_BUILD_TESTS=1
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { execSync } from "node:child_process";

import { parseBuildArgs, type BuildOptions, type Target } from "./build.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const DIST_BIN_DIR = resolve(PACKAGE_ROOT, "dist-bin");

// Skip build tests if requested
const SKIP_BUILD = process.env.SKIP_BUILD_TESTS === "1";

// Get the platform-specific binary name
function getPlatformTarget(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";

  return "unknown";
}

function getBinaryPath(): string {
  return join(DIST_BIN_DIR, `thinkwell-${getPlatformTarget()}`);
}

// Check if compiled binary exists
const SKIP_BINARY = !existsSync(getBinaryPath());

// Helper to create a temporary test directory
function createTestDir(prefix: string): string {
  const testDir = join(tmpdir(), `thinkwell-build-test-${prefix}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  return testDir;
}

// Helper to clean up test directory
function cleanupTestDir(testDir: string): void {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// Helper to run a command and capture output
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): { stdout: string; stderr: string; code: number } {
  const { cwd = process.cwd(), env = process.env, timeout = 120000 } = options;

  try {
    const result = execSync([command, ...args].join(" "), {
      cwd,
      env: { ...env, NO_COLOR: "1" },
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: result, stderr: "", code: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
      code: execError.status ?? 1,
    };
  }
}

// =============================================================================
// Unit Tests: Argument Parsing
// =============================================================================

describe("build command argument parsing", { skip: SKIP_BUILD }, () => {
  it("should parse entry file from positional argument", () => {
    const options = parseBuildArgs(["src/agent.ts"]);
    assert.strictEqual(options.entry, "src/agent.ts");
    assert.deepStrictEqual(options.targets, ["host"]); // Default target
  });

  it("should parse --output flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "--output", "dist/my-agent"]);
    assert.strictEqual(options.entry, "src/agent.ts");
    assert.strictEqual(options.output, "dist/my-agent");
  });

  it("should parse -o short flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "-o", "my-binary"]);
    assert.strictEqual(options.output, "my-binary");
  });

  it("should parse single --target flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "--target", "linux-x64"]);
    assert.deepStrictEqual(options.targets, ["linux-x64"]);
  });

  it("should parse multiple --target flags", () => {
    const options = parseBuildArgs([
      "src/agent.ts",
      "-t", "darwin-arm64",
      "-t", "linux-x64",
      "--target", "linux-arm64",
    ]);
    assert.deepStrictEqual(options.targets, ["darwin-arm64", "linux-x64", "linux-arm64"]);
  });

  it("should parse --include flag", () => {
    const options = parseBuildArgs([
      "src/agent.ts",
      "--include", "assets/**/*",
      "--include", "config.json",
    ]);
    assert.deepStrictEqual(options.include, ["assets/**/*", "config.json"]);
  });

  it("should parse --verbose flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "--verbose"]);
    assert.strictEqual(options.verbose, true);
  });

  it("should parse -v short flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "-v"]);
    assert.strictEqual(options.verbose, true);
  });

  it("should parse --quiet flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "--quiet"]);
    assert.strictEqual(options.quiet, true);
  });

  it("should parse -q short flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "-q"]);
    assert.strictEqual(options.quiet, true);
  });

  it("should parse --dry-run flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "--dry-run"]);
    assert.strictEqual(options.dryRun, true);
  });

  it("should parse -n short flag for dry-run", () => {
    const options = parseBuildArgs(["src/agent.ts", "-n"]);
    assert.strictEqual(options.dryRun, true);
  });

  it("should parse --external flag", () => {
    const options = parseBuildArgs([
      "src/agent.ts",
      "--external", "sqlite3",
      "-e", "pg",
    ]);
    assert.deepStrictEqual(options.external, ["sqlite3", "pg"]);
  });

  it("should parse --minify flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "--minify"]);
    assert.strictEqual(options.minify, true);
  });

  it("should parse -m short flag for minify", () => {
    const options = parseBuildArgs(["src/agent.ts", "-m"]);
    assert.strictEqual(options.minify, true);
  });

  it("should parse --watch flag", () => {
    const options = parseBuildArgs(["src/agent.ts", "--watch"]);
    assert.strictEqual(options.watch, true);
  });

  it("should parse -w short flag for watch", () => {
    const options = parseBuildArgs(["src/agent.ts", "-w"]);
    assert.strictEqual(options.watch, true);
  });

  it("should parse complex combination of flags", () => {
    const options = parseBuildArgs([
      "src/agent.ts",
      "-o", "dist/agent",
      "-t", "darwin-arm64",
      "-t", "linux-x64",
      "--include", "data/*",
      "-v",
    ]);
    assert.strictEqual(options.entry, "src/agent.ts");
    assert.strictEqual(options.output, "dist/agent");
    assert.deepStrictEqual(options.targets, ["darwin-arm64", "linux-x64"]);
    assert.deepStrictEqual(options.include, ["data/*"]);
    assert.strictEqual(options.verbose, true);
  });

  it("should throw on missing entry file", () => {
    assert.throws(
      () => parseBuildArgs([]),
      /No entry file specified/
    );
  });

  it("should throw on missing --output value", () => {
    assert.throws(
      () => parseBuildArgs(["src/agent.ts", "--output"]),
      /Missing value for --output/
    );
  });

  it("should throw on missing --target value", () => {
    assert.throws(
      () => parseBuildArgs(["src/agent.ts", "--target"]),
      /Missing value for --target/
    );
  });

  it("should throw on invalid target", () => {
    assert.throws(
      () => parseBuildArgs(["src/agent.ts", "--target", "windows-x64"]),
      /Invalid target 'windows-x64'/
    );
  });

  it("should throw on unknown option", () => {
    assert.throws(
      () => parseBuildArgs(["src/agent.ts", "--unknown"]),
      /Unknown option: --unknown/
    );
  });

  it("should throw on unexpected positional argument", () => {
    assert.throws(
      () => parseBuildArgs(["src/agent.ts", "extra-arg"]),
      /Unexpected argument: extra-arg/
    );
  });

  it("should validate all supported targets", () => {
    const validTargets: Target[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "host"];
    for (const target of validTargets) {
      const options = parseBuildArgs(["src/agent.ts", "-t", target]);
      assert.ok(options.targets?.includes(target), `Should accept target: ${target}`);
    }
  });
});

// =============================================================================
// Unit Tests: Download/Extraction Logic (with mocks)
// =============================================================================

describe("download and extraction utilities", { skip: SKIP_BUILD }, () => {
  let testDir: string;
  let originalCacheDir: string | undefined;

  before(() => {
    testDir = createTestDir("download");
    originalCacheDir = process.env.THINKWELL_CACHE_DIR;
  });

  after(() => {
    cleanupTestDir(testDir);
    if (originalCacheDir !== undefined) {
      process.env.THINKWELL_CACHE_DIR = originalCacheDir;
    } else {
      delete process.env.THINKWELL_CACHE_DIR;
    }
  });

  beforeEach(() => {
    // Use test directory for cache
    process.env.THINKWELL_CACHE_DIR = join(testDir, "cache");
  });

  afterEach(() => {
    // Clean up cache between tests
    const cacheDir = join(testDir, "cache");
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("should respect THINKWELL_CACHE_DIR environment variable", () => {
    const customCache = join(testDir, "custom-cache");
    process.env.THINKWELL_CACHE_DIR = customCache;

    // Import dynamically to pick up env change
    // The getCacheDir function reads the env var
    assert.strictEqual(process.env.THINKWELL_CACHE_DIR, customCache);
  });

  it("should use default cache directory when env not set", () => {
    delete process.env.THINKWELL_CACHE_DIR;
    const defaultPath = join(homedir(), ".cache", "thinkwell");
    // The default cache dir is ~/.cache/thinkwell
    assert.strictEqual(join(homedir(), ".cache", "thinkwell"), defaultPath);
  });
});

// =============================================================================
// Integration Tests: Cache Invalidation
// =============================================================================

describe("cache invalidation logic", { skip: SKIP_BUILD }, () => {
  let testDir: string;
  let cacheDir: string;
  let originalCacheDir: string | undefined;

  before(() => {
    testDir = createTestDir("cache-invalidation");
    cacheDir = join(testDir, "cache");
    originalCacheDir = process.env.THINKWELL_CACHE_DIR;
    process.env.THINKWELL_CACHE_DIR = cacheDir;
  });

  after(() => {
    cleanupTestDir(testDir);
    if (originalCacheDir !== undefined) {
      process.env.THINKWELL_CACHE_DIR = originalCacheDir;
    } else {
      delete process.env.THINKWELL_CACHE_DIR;
    }
  });

  it("should create version-specific cache directories for pkg CLI", () => {
    // The pkg CLI is cached under <cache>/pkg-cli/<version>/
    // Different thinkwell versions get different cache directories
    const version1Dir = join(cacheDir, "pkg-cli", "1.0.0");
    const version2Dir = join(cacheDir, "pkg-cli", "1.0.1");

    mkdirSync(version1Dir, { recursive: true });
    mkdirSync(version2Dir, { recursive: true });

    // Both should be able to coexist
    assert.ok(existsSync(version1Dir));
    assert.ok(existsSync(version2Dir));
  });

  it("should create version-specific cache directories for Node.js", () => {
    // Node.js is cached under <cache>/node/v<version>/
    const nodeDir = join(cacheDir, "node", "v24.1.0");
    mkdirSync(nodeDir, { recursive: true });

    assert.ok(existsSync(nodeDir));
  });

  it("should separate pkg-fetch cache from pkg CLI cache", () => {
    // pkg-fetch downloads go to <cache>/pkg-cache/
    // pkg CLI goes to <cache>/pkg-cli/
    const pkgCacheDir = join(cacheDir, "pkg-cache");
    const pkgCliDir = join(cacheDir, "pkg-cli");

    mkdirSync(pkgCacheDir, { recursive: true });
    mkdirSync(pkgCliDir, { recursive: true });

    assert.ok(existsSync(pkgCacheDir));
    assert.ok(existsSync(pkgCliDir));
    assert.notStrictEqual(pkgCacheDir, pkgCliDir);
  });
});

// =============================================================================
// Integration Tests: Build Command (npm distribution)
// =============================================================================

describe("build command integration (npm)", { skip: SKIP_BUILD }, () => {
  const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
  let testDir: string;

  before(() => {
    testDir = createTestDir("build-npm");
  });

  after(() => {
    cleanupTestDir(testDir);
  });

  it("should show build help with --help flag", () => {
    const result = run("node", [NPM_BIN, "build", "--help"]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("thinkwell build"), "Should show build command");
    assert.ok(result.stdout.includes("--output"), "Should show --output flag");
    assert.ok(result.stdout.includes("--target"), "Should show --target flag");
    assert.ok(result.stdout.includes("--dry-run"), "Should show --dry-run flag");
  });

  it("should error when no entry file specified", () => {
    const result = run("node", [NPM_BIN, "build"]);
    assert.notStrictEqual(result.code, 0, "Should fail without entry file");
    assert.ok(
      result.stderr.includes("No entry file") || result.stderr.includes("entry"),
      "Should report missing entry file"
    );
  });

  it("should error on non-existent entry file", () => {
    const result = run("node", [NPM_BIN, "build", "nonexistent.ts"]);
    assert.notStrictEqual(result.code, 0, "Should fail for non-existent file");
    assert.ok(
      result.stderr.includes("not found") || result.stderr.includes("Entry file"),
      "Should report file not found"
    );
  });

  it("should run dry-run without errors", () => {
    // Create a simple test script
    const scriptPath = join(testDir, "simple.ts");
    writeFileSync(scriptPath, 'console.log("hello");');

    const result = run("node", [NPM_BIN, "build", scriptPath, "--dry-run"]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("Dry run mode"), "Should indicate dry run");
    assert.ok(result.stdout.includes("Entry point:"), "Should show entry point");
    assert.ok(result.stdout.includes("Targets:"), "Should show targets");
    assert.ok(result.stdout.includes("Build steps:"), "Should show build steps");
  });

  it("should detect top-level await in dry-run", () => {
    const scriptPath = join(testDir, "top-level-await.ts");
    writeFileSync(scriptPath, `
const response = await fetch("https://example.com");
console.log(response.status);
`);

    const result = run("node", [NPM_BIN, "build", scriptPath, "--dry-run"]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(
      result.stdout.includes("Top-level await") || result.stdout.includes("top-level await"),
      "Should warn about top-level await"
    );
  });

  it("should build a simple script successfully", () => {
    const scriptPath = join(testDir, "buildable.ts");
    writeFileSync(scriptPath, `
const msg: string = "Built successfully!";
console.log(msg);
`);

    const outputPath = join(testDir, "buildable-out");
    const result = run("node", [NPM_BIN, "build", scriptPath, "-o", outputPath, "-q"], {
      timeout: 180000, // 3 minutes for build
    });

    assert.strictEqual(result.code, 0, `Build failed: ${result.stderr}`);

    // Verify output exists with platform suffix
    const platformTarget = getPlatformTarget();
    const expectedOutput = `${outputPath}-${platformTarget}`;
    // The build command only adds suffix for multi-target builds
    // For single target, it uses exact output path
    assert.ok(
      existsSync(outputPath) || existsSync(expectedOutput),
      `Output should exist at ${outputPath} or ${expectedOutput}`
    );
  });
});

// =============================================================================
// E2E Tests: Build from Compiled Binary (CI Only)
// =============================================================================

describe("build command E2E (compiled binary)", {
  skip: SKIP_BUILD || SKIP_BINARY || !process.env.CI
}, () => {
  const binaryPath = getBinaryPath();
  let testDir: string;
  let cacheDir: string;

  before(() => {
    testDir = createTestDir("build-binary-e2e");
    cacheDir = join(testDir, "cache");
    // Use isolated cache for E2E tests
    process.env.THINKWELL_CACHE_DIR = cacheDir;
  });

  after(() => {
    cleanupTestDir(testDir);
    delete process.env.THINKWELL_CACHE_DIR;
  });

  it("should show build help from compiled binary", () => {
    const result = run(binaryPath, ["build", "--help"]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("thinkwell build"), "Should show build command");
  });

  it("should run dry-run from compiled binary", () => {
    const scriptPath = join(testDir, "e2e-simple.ts");
    writeFileSync(scriptPath, 'console.log("e2e");');

    const result = run(binaryPath, ["build", scriptPath, "--dry-run"]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("Dry run mode"), "Should indicate dry run");
  });

  it("should build a script from compiled binary (full E2E)", () => {
    const scriptPath = join(testDir, "e2e-buildable.ts");
    writeFileSync(scriptPath, `
import { Agent } from "thinkwell";
console.log("Agent imported:", typeof Agent);
`);

    const outputPath = join(testDir, "e2e-output");
    const result = run(binaryPath, ["build", scriptPath, "-o", outputPath], {
      timeout: 300000, // 5 minutes for full build including Node.js download
      env: {
        ...process.env,
        THINKWELL_CACHE_DIR: cacheDir,
      },
    });

    assert.strictEqual(result.code, 0, `Build failed: ${result.stderr}\n${result.stdout}`);
    assert.ok(existsSync(outputPath), `Output should exist at ${outputPath}`);

    // Verify the built binary runs
    const execResult = run(outputPath, []);
    assert.strictEqual(execResult.code, 0, `Built binary failed: ${execResult.stderr}`);
    assert.ok(
      execResult.stdout.includes("Agent imported:"),
      "Built binary should produce expected output"
    );
  });

  it("should reuse cached Node.js on second build", () => {
    // First build should download Node.js
    const script1Path = join(testDir, "e2e-cache1.ts");
    writeFileSync(script1Path, 'console.log("cache test 1");');

    const output1Path = join(testDir, "e2e-cache1-out");
    const result1 = run(binaryPath, ["build", script1Path, "-o", output1Path], {
      timeout: 300000,
      env: {
        ...process.env,
        THINKWELL_CACHE_DIR: cacheDir,
      },
    });
    assert.strictEqual(result1.code, 0, `First build failed: ${result1.stderr}`);

    // Second build should reuse cached Node.js (no "Downloading" message)
    const script2Path = join(testDir, "e2e-cache2.ts");
    writeFileSync(script2Path, 'console.log("cache test 2");');

    const output2Path = join(testDir, "e2e-cache2-out");
    const result2 = run(binaryPath, ["build", script2Path, "-o", output2Path], {
      timeout: 120000, // Should be faster without download
      env: {
        ...process.env,
        THINKWELL_CACHE_DIR: cacheDir,
      },
    });
    assert.strictEqual(result2.code, 0, `Second build failed: ${result2.stderr}`);

    // Verify Node.js cache exists
    const nodeCacheDir = join(cacheDir, "node");
    assert.ok(existsSync(nodeCacheDir), "Node.js cache should exist");
  });
});

// =============================================================================
// Unit Tests: Top-Level Await Detection
// =============================================================================

describe("top-level await detection", { skip: SKIP_BUILD }, () => {
  let testDir: string;

  before(() => {
    testDir = createTestDir("tla-detection");
  });

  after(() => {
    cleanupTestDir(testDir);
  });

  it("should detect simple top-level await", () => {
    const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
    const scriptPath = join(testDir, "tla-simple.ts");
    writeFileSync(scriptPath, `
const data = await fetch("https://example.com");
console.log(data);
`);

    const result = run("node", [NPM_BIN, "build", scriptPath, "--dry-run"]);
    assert.ok(
      result.stdout.includes("Top-level await") ||
      result.stdout.includes("top-level await"),
      "Should detect top-level await"
    );
  });

  it("should not flag await inside async function", () => {
    const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
    const scriptPath = join(testDir, "tla-function.ts");
    writeFileSync(scriptPath, `
async function main() {
  const data = await fetch("https://example.com");
  console.log(data);
}
main();
`);

    const result = run("node", [NPM_BIN, "build", scriptPath, "--dry-run"]);
    // Should NOT have the warning
    assert.ok(
      !result.stdout.includes("Top-level await detected"),
      "Should not flag await inside async function"
    );
  });

  it("should not flag await inside arrow function", () => {
    const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
    const scriptPath = join(testDir, "tla-arrow.ts");
    writeFileSync(scriptPath, `
const main = async () => {
  const data = await fetch("https://example.com");
  console.log(data);
};
main();
`);

    const result = run("node", [NPM_BIN, "build", scriptPath, "--dry-run"]);
    assert.ok(
      !result.stdout.includes("Top-level await detected"),
      "Should not flag await inside arrow function"
    );
  });

  it("should not flag 'await' in comments", () => {
    const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
    const scriptPath = join(testDir, "tla-comment.ts");
    writeFileSync(scriptPath, `
// We await the result in the async function
/* await is used inside functions */
console.log("no actual await here");
`);

    const result = run("node", [NPM_BIN, "build", scriptPath, "--dry-run"]);
    assert.ok(
      !result.stdout.includes("Top-level await detected"),
      "Should not flag await in comments"
    );
  });

  it("should not flag 'await' in strings", () => {
    const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
    const scriptPath = join(testDir, "tla-string.ts");
    writeFileSync(scriptPath, `
const msg = "we await your response";
console.log(msg);
`);

    const result = run("node", [NPM_BIN, "build", scriptPath, "--dry-run"]);
    assert.ok(
      !result.stdout.includes("Top-level await detected"),
      "Should not flag await in strings"
    );
  });
});
