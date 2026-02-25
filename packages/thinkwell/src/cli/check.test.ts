/**
 * Integration tests for `thinkwell check`.
 *
 * Uses test-fixtures/node-ux-project for @JSONSchema tests and creates
 * minimal temporary fixtures for the other scenarios.
 *
 * Skip these tests by setting: SKIP_CHECK_TESTS=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  cpSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const FIXTURE_DIR = resolve(PACKAGE_ROOT, "test-fixtures/node-ux-project");

const SKIP = process.env.SKIP_CHECK_TESTS === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Copy the node-ux-project fixture into a temp directory (with type-stubs → node_modules). */
function copyFixture(prefix: string): string {
  const dest = join(tmpdir(), `thinkwell-check-test-${prefix}-${Date.now()}`);
  cpSync(FIXTURE_DIR, dest, { recursive: true });
  cpSync(join(dest, "type-stubs"), join(dest, "node_modules"), { recursive: true });
  // Symlink the thinkwell package so `thinkwell/build` resolves in explicit-config mode
  symlinkSync(PACKAGE_ROOT, join(dest, "node_modules", "thinkwell"), "dir");
  return dest;
}

/** Create a minimal TypeScript project with no @JSONSchema types. */
function createPlainProject(prefix: string): string {
  const dir = join(tmpdir(), `thinkwell-check-test-${prefix}-${Date.now()}`);
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "plain-project",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { thinkwell: "^0.5.0" },
      devDependencies: { typescript: "^5.7.0" },
    }, null, 2),
  );

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          outDir: "./dist",
          rootDir: "./src",
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "src/index.ts"),
    `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  );

  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Sentinel thrown to halt execution after an intercepted process.exit(). */
class ExitSentinel extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

/**
 * Run `runCheck` in a given directory, intercepting process.exit so it
 * doesn't kill the test runner. Returns the captured exit code and any
 * text written to stderr.
 */
async function runCheckInDir(
  dir: string,
  options: import("./check.js").CheckOptions,
  runCheck: typeof import("./check.js").runCheck,
): Promise<{ exitCode: number | undefined; stderr: string }> {
  const originalExit = process.exit;
  const originalCwd = process.cwd();
  const originalWrite = process.stderr.write;

  let exitCode: number | undefined;
  let stderrOutput = "";

  process.exit = ((code?: number) => {
    exitCode = code;
    throw new ExitSentinel(code ?? 0);
  }) as never;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    process.chdir(dir);
    await runCheck(options);
  } catch (err) {
    if (!(err instanceof ExitSentinel)) throw err;
  } finally {
    process.chdir(originalCwd);
    process.exit = originalExit;
    process.stderr.write = originalWrite;
  }

  return { exitCode, stderr: stderrOutput };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("thinkwell check", { skip: SKIP }, () => {
  let runCheck: typeof import("./check.js").runCheck;
  let parseCheckArgs: typeof import("./check.js").parseCheckArgs;

  before(async () => {
    const mod = await import("./check.js");
    runCheck = mod.runCheck;
    parseCheckArgs = mod.parseCheckArgs;
  });

  // =========================================================================
  // Argument parsing (unit)
  // =========================================================================

  describe("parseCheckArgs", () => {
    it("should parse --package flag", () => {
      const opts = parseCheckArgs(["--package", "foo"]);
      assert.deepStrictEqual(opts.packages, ["foo"]);
    });

    it("should parse -p shorthand", () => {
      const opts = parseCheckArgs(["-p", "foo"]);
      assert.deepStrictEqual(opts.packages, ["foo"]);
    });

    it("should parse multiple --package flags", () => {
      const opts = parseCheckArgs(["-p", "foo", "-p", "bar"]);
      assert.deepStrictEqual(opts.packages, ["foo", "bar"]);
    });

    it("should parse --pretty and --no-pretty", () => {
      assert.strictEqual(parseCheckArgs(["--pretty"]).pretty, true);
      assert.strictEqual(parseCheckArgs(["--no-pretty"]).pretty, false);
    });

    it("should parse empty args", () => {
      const opts = parseCheckArgs([]);
      assert.strictEqual(opts.packages, undefined);
      assert.strictEqual(opts.pretty, undefined);
    });

    it("should throw on unknown option", () => {
      assert.throws(() => parseCheckArgs(["--unknown"]), /Unknown option/);
    });

    it("should throw on positional argument with helpful message", () => {
      assert.throws(() => parseCheckArgs(["mypackage"]), /thinkwell check -p mypackage/);
    });
  });

  // =========================================================================
  // 1. Minimal fixture (no @JSONSchema) — clean check
  // =========================================================================

  describe("minimal project (no @JSONSchema)", () => {
    let projectDir: string;

    before(() => {
      projectDir = createPlainProject("plain");
    });

    after(() => {
      cleanup(projectDir);
    });

    it("should pass type-checking with exit code 0", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        projectDir,
        { pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, undefined, `Expected clean check but got exit code ${exitCode}`);
      assert.ok(stderr.includes("Checking"), "Should print 'Checking ...'");
      assert.ok(stderr.includes("No type errors found"), "Should report no errors");
    });
  });

  // =========================================================================
  // 2. @JSONSchema fixture — clean check
  // =========================================================================

  describe("@JSONSchema project (node-ux-project fixture)", () => {
    let projectDir: string;

    before(() => {
      projectDir = copyFixture("jsonschema");
    });

    after(() => {
      cleanup(projectDir);
    });

    it("should pass type-checking with @JSONSchema types", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        projectDir,
        { pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, undefined, `Expected clean check but got exit code ${exitCode}`);
      assert.ok(stderr.includes("Checking"), "Should print 'Checking ...'");
      assert.ok(stderr.includes("No type errors found"), "Should report no errors");
    });
  });

  // =========================================================================
  // 3. Intentional type error — exit code 1
  // =========================================================================

  describe("type error reporting", () => {
    let projectDir: string;

    before(() => {
      projectDir = createPlainProject("type-error");
      // Inject a file with a type error
      writeFileSync(
        join(projectDir, "src/bad.ts"),
        `export const x: number = "not a number";\n`,
      );
    });

    after(() => {
      cleanup(projectDir);
    });

    it("should exit with code 1 when type errors are present", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        projectDir,
        { pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, 1, "Should exit with code 1 for type errors");
      assert.ok(
        stderr.includes("TS2322") || stderr.includes("not assignable"),
        "Should include the type error diagnostic",
      );
    });
  });

  // =========================================================================
  // 4. Missing dependencies — exit code 2
  // =========================================================================

  describe("dependency checking", () => {
    it("should exit with code 2 when dependencies are missing", async () => {
      // Create a project with package.json but no thinkwell/typescript deps
      const projectDir = join(tmpdir(), `thinkwell-check-test-deps-${Date.now()}`);
      mkdirSync(join(projectDir, "src"), { recursive: true });
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "test-project", dependencies: { lodash: "^4.0.0" } }),
      );
      writeFileSync(
        join(projectDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "ES2022", outDir: "dist", rootDir: "src" },
          include: ["src/**/*"],
        }),
      );
      writeFileSync(join(projectDir, "src/index.ts"), "export const x = 1;\n");

      try {
        const { exitCode, stderr } = await runCheckInDir(
          projectDir,
          { pretty: false },
          runCheck,
        );

        assert.strictEqual(exitCode, 2, "Should exit with code 2 for missing dependencies");
        assert.ok(stderr.includes("thinkwell"), "Error should mention thinkwell");
        assert.ok(stderr.includes("typescript"), "Error should mention typescript");
      } finally {
        cleanup(projectDir);
      }
    });

    it("should proceed when dependencies are declared", async () => {
      const projectDir = createPlainProject("deps-ok");

      try {
        const { exitCode } = await runCheckInDir(
          projectDir,
          { pretty: false },
          runCheck,
        );

        // Should succeed (no exit code) or fail with type errors (code 1), but NOT code 2
        assert.ok(
          exitCode === undefined,
          `Should not exit with code 2; got ${exitCode}`,
        );
      } finally {
        cleanup(projectDir);
      }
    });
  });

  // =========================================================================
  // 5. Missing tsconfig.json — exit code 2
  // =========================================================================

  describe("missing tsconfig.json", () => {
    let emptyDir: string;

    before(() => {
      emptyDir = join(tmpdir(), `thinkwell-check-test-no-config-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
    });

    after(() => {
      cleanup(emptyDir);
    });

    it("should exit with code 2 when tsconfig.json is missing", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        emptyDir,
        { pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, 2, "Should exit with code 2 for config error");
      assert.ok(stderr.includes("Cannot find tsconfig.json"), "Should report missing config");
    });
  });

  // =========================================================================
  // 6. Workspace mode — multiple packages
  // =========================================================================

  describe("workspace mode", () => {
    let workspaceDir: string;

    before(() => {
      workspaceDir = join(tmpdir(), `thinkwell-check-test-workspace-${Date.now()}`);
      mkdirSync(workspaceDir, { recursive: true });

      // Root package.json with npm workspace config
      writeFileSync(
        join(workspaceDir, "package.json"),
        JSON.stringify(
          {
            name: "test-workspace",
            private: true,
            workspaces: ["packages/*"],
            dependencies: { thinkwell: "^0.5.0" },
            devDependencies: { typescript: "^5.7.0" },
          },
          null,
          2,
        ),
      );

      // --- Package A: clean TypeScript ---
      const pkgADir = join(workspaceDir, "packages/pkg-a");
      mkdirSync(join(pkgADir, "src"), { recursive: true });
      writeFileSync(
        join(pkgADir, "package.json"),
        JSON.stringify({ name: "@test/pkg-a", version: "0.0.0" }, null, 2),
      );
      writeFileSync(
        join(pkgADir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              outDir: "./dist",
              rootDir: "./src",
              skipLibCheck: true,
            },
            include: ["src/**/*"],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(pkgADir, "src/index.ts"),
        `export const greeting: string = "hello";\n`,
      );

      // --- Package B: also clean TypeScript ---
      const pkgBDir = join(workspaceDir, "packages/pkg-b");
      mkdirSync(join(pkgBDir, "src"), { recursive: true });
      writeFileSync(
        join(pkgBDir, "package.json"),
        JSON.stringify({ name: "@test/pkg-b", version: "0.0.0" }, null, 2),
      );
      writeFileSync(
        join(pkgBDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              outDir: "./dist",
              rootDir: "./src",
              skipLibCheck: true,
            },
            include: ["src/**/*"],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(pkgBDir, "src/index.ts"),
        `export function double(n: number): number { return n * 2; }\n`,
      );

      // --- Package C: no tsconfig (should be skipped) ---
      const pkgCDir = join(workspaceDir, "packages/pkg-c");
      mkdirSync(pkgCDir, { recursive: true });
      writeFileSync(
        join(pkgCDir, "package.json"),
        JSON.stringify({ name: "@test/pkg-c", version: "0.0.0" }, null, 2),
      );
    });

    after(() => {
      cleanup(workspaceDir);
    });

    it("should check all TypeScript packages and report success", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        workspaceDir,
        { pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, undefined, `Expected clean check but got exit code ${exitCode}`);
      assert.ok(stderr.includes("@test/pkg-a"), "Should list pkg-a");
      assert.ok(stderr.includes("@test/pkg-b"), "Should list pkg-b");
      assert.ok(!stderr.includes("@test/pkg-c"), "Should skip pkg-c (no tsconfig)");
      assert.ok(stderr.includes("All 2 packages passed"), "Should show summary");
    });

    it("should check a single package with --package flag", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        workspaceDir,
        { packages: ["@test/pkg-a"], pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, undefined, `Expected clean check but got exit code ${exitCode}`);
      assert.ok(stderr.includes("@test/pkg-a"), "Should check pkg-a");
      assert.ok(!stderr.includes("@test/pkg-b"), "Should not check pkg-b");
      assert.ok(stderr.includes("All 1 package passed"), "Should show summary for 1 package");
    });

    it("should check a package by short name", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        workspaceDir,
        { packages: ["pkg-b"], pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, undefined, `Expected clean check but got exit code ${exitCode}`);
      assert.ok(stderr.includes("@test/pkg-b"), "Should resolve short name to @test/pkg-b");
    });

    it("should report errors in workspace packages and exit with code 1", async () => {
      // Inject a type error into pkg-b
      writeFileSync(
        join(workspaceDir, "packages/pkg-b/src/bad.ts"),
        `export const oops: number = "not a number";\n`,
      );

      try {
        const { exitCode, stderr } = await runCheckInDir(
          workspaceDir,
          { pretty: false },
          runCheck,
        );

        assert.strictEqual(exitCode, 1, "Should exit with code 1 when a package has errors");
        assert.ok(stderr.includes("@test/pkg-a"), "Should still check pkg-a");
        assert.ok(stderr.includes("ok"), "pkg-a should pass");
        assert.ok(
          stderr.includes("1 of 2 packages had errors"),
          "Should report 1 of 2 packages had errors",
        );
      } finally {
        // Clean up the injected bad file for other tests
        try {
          rmSync(join(workspaceDir, "packages/pkg-b/src/bad.ts"));
        } catch {
          // Ignore
        }
      }
    });

    it("should exit with code 2 for unknown package name", async () => {
      const { exitCode, stderr } = await runCheckInDir(
        workspaceDir,
        { packages: ["nonexistent"], pretty: false },
        runCheck,
      );

      assert.strictEqual(exitCode, 2, "Should exit with code 2 for unknown package");
      assert.ok(stderr.includes("not found"), "Should report package not found");
    });
  });
});
