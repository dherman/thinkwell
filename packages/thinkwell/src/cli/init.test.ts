/**
 * Tests for the `thinkwell init` command.
 *
 * @see doc/rfd/explicit-config.md for the design
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, "../../bin/thinkwell");

// ============================================================================
// Test Helpers
// ============================================================================

function runThinkwellInit(
  cwd: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [binPath, "init", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function createTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================================================================
// Tests
// ============================================================================

describe("thinkwell init", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("thinkwell-init-test");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("help", () => {
    it("should show help with --help flag", () => {
      const { status, stdout } = runThinkwellInit(tempDir, ["--help"]);
      assert.strictEqual(status, 0);
      assert.match(stdout, /thinkwell init/);
      assert.match(stdout, /Initialize thinkwell/);
      assert.match(stdout, /--yes/);
    });

    it("should show help with -h flag", () => {
      const { status, stdout } = runThinkwellInit(tempDir, ["-h"]);
      assert.strictEqual(status, 0);
      assert.match(stdout, /thinkwell init/);
    });
  });

  describe("no package.json", () => {
    it("should create package.json when none exists", () => {
      const { status, stdout } = runThinkwellInit(tempDir, ["--yes"]);
      assert.strictEqual(status, 0);
      assert.match(stdout, /No package\.json found\. Creating one/);
      assert.match(stdout, /Created package\.json/);

      // Verify package.json was created
      const pkgPath = join(tempDir, "package.json");
      assert.ok(existsSync(pkgPath), "package.json should be created");

      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      assert.strictEqual(pkg.type, "module");
    });
  });

  describe("dependencies already present", () => {
    it("should report success when all deps are present", () => {
      // Create package.json with both deps
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: {
            thinkwell: "^0.5.0",
          },
          devDependencies: {
            typescript: "^5.7.0",
          },
        }),
      );

      const { status, stdout } = runThinkwellInit(tempDir, ["--yes"]);
      assert.strictEqual(status, 0);
      assert.match(stdout, /All required dependencies are already installed/);
    });
  });

  describe("package manager detection", () => {
    it("should detect pnpm from pnpm-lock.yaml", () => {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");

      const { stdout } = runThinkwellInit(tempDir, ["--yes"]);
      // Will fail to install (no pnpm or packages), but should show pnpm as detected
      assert.match(stdout, /Detected package manager: pnpm/);
    });

    it("should detect npm from package-lock.json", () => {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(
        join(tempDir, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3 }),
      );

      // Test that init detects npm
      const { stdout } = runThinkwellInit(tempDir, ["--yes"]);
      // Will fail to install (no npm packages), but should show npm as detected
      assert.match(stdout, /Detected package manager: npm/);
    });

    it("should detect yarn from yarn.lock", () => {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tempDir, "yarn.lock"), "# yarn lockfile\n");

      const { stdout } = runThinkwellInit(tempDir, ["--yes"]);
      assert.match(stdout, /Detected package manager: yarn/);
    });
  });

  describe("missing dependencies display", () => {
    it("should list missing thinkwell dependency", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "test",
          devDependencies: { typescript: "^5.7.0" },
        }),
      );

      // Don't use --yes so we can check what would be displayed
      // Use a non-TTY environment (default in spawnSync)
      const { stderr, stdout } = runThinkwellInit(tempDir);

      // Should exit with error since non-TTY without --yes
      assert.match(stdout, /Missing dependencies/);
      assert.match(stdout, /thinkwell/);
      assert.match(stderr, /Cannot prompt for confirmation in non-interactive mode/);
    });

    it("should list missing typescript dependency", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "test",
          dependencies: { thinkwell: "^0.5.0" },
        }),
      );

      const { stdout, stderr } = runThinkwellInit(tempDir);
      assert.match(stdout, /Missing dependencies/);
      assert.match(stdout, /typescript/);
      assert.match(stdout, /devDependency/);
      assert.match(stderr, /Cannot prompt for confirmation/);
    });

    it("should list both missing dependencies", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "test" }),
      );

      const { stdout } = runThinkwellInit(tempDir);
      assert.match(stdout, /Missing dependencies/);
      assert.match(stdout, /thinkwell/);
      assert.match(stdout, /typescript/);
    });
  });

  describe("non-interactive mode", () => {
    it("should require --yes in non-TTY environment", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "test" }),
      );

      const { status, stderr } = runThinkwellInit(tempDir);
      assert.strictEqual(status, 2);
      assert.match(stderr, /Cannot prompt for confirmation in non-interactive mode/);
      assert.match(stderr, /thinkwell init --yes/);
    });
  });
});

describe("thinkwell new", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("thinkwell-new-test");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runThinkwellNew(
    cwd: string,
    args: string[] = [],
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [binPath, "new", ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    return {
      status: result.status ?? 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }

  it("should show help with --help flag", () => {
    const { status, stdout } = runThinkwellNew(tempDir, ["--help"]);
    assert.strictEqual(status, 0);
    assert.match(stdout, /thinkwell new/);
    assert.match(stdout, /Create a new thinkwell project/);
  });

  it("should require project name argument", () => {
    const { status, stderr } = runThinkwellNew(tempDir, []);
    assert.strictEqual(status, 1);
    assert.match(stderr, /Project name is required/);
    assert.match(stderr, /thinkwell init/);
  });

  it("should create project files", () => {
    const projectDir = join(tempDir, "test-project");
    const { status } = runThinkwellNew(tempDir, ["test-project"]);

    assert.strictEqual(status, 0);
    assert.ok(existsSync(join(projectDir, "package.json")));
    assert.ok(existsSync(join(projectDir, "tsconfig.json")));
    assert.ok(existsSync(join(projectDir, "src/main.ts")));
    assert.ok(existsSync(join(projectDir, ".gitignore")));
  });

  it("should mention thinkwell init in help", () => {
    const { stdout } = runThinkwellNew(tempDir, ["--help"]);
    assert.match(stdout, /thinkwell init/);
  });
});
