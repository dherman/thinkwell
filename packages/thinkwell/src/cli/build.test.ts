/**
 * Integration tests for `thinkwell build` (single-pass and watch mode).
 *
 * Uses the test-fixtures/node-ux-project fixture — a minimal TypeScript
 * project with @JSONSchema types, a tsconfig.json, and type stubs for
 * @thinkwell/acp and @thinkwell/protocol.
 *
 * Skip these tests by setting: SKIP_BUILD_TESTS=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const FIXTURE_DIR = resolve(PACKAGE_ROOT, "test-fixtures/node-ux-project");

const SKIP = process.env.SKIP_BUILD_TESTS === "1";

// Helper to create a temp copy of the fixture so tests don't pollute it.
// Copies type-stubs/ into node_modules/ so TypeScript can resolve
// the @thinkwell/acp type-only import that @JSONSchema transformation injects.
function copyFixture(prefix: string): string {
  const dest = join(tmpdir(), `thinkwell-build-test-${prefix}-${Date.now()}`);
  cpSync(FIXTURE_DIR, dest, { recursive: true });
  cpSync(join(dest, "type-stubs"), join(dest, "node_modules"), { recursive: true });
  return dest;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe("thinkwell build", { skip: SKIP }, () => {
  // Import the build module. We import lazily so the skip flag
  // prevents loading TypeScript compiler when tests are skipped.
  let runBuild: typeof import("./build.js").runBuild;
  let parseBuildArgs: typeof import("./build.js").parseBuildArgs;

  before(async () => {
    const buildModule = await import("./build.js");
    runBuild = buildModule.runBuild;
    parseBuildArgs = buildModule.parseBuildArgs;
  });

  describe("parseBuildArgs", () => {
    it("should parse --watch flag", () => {
      const opts = parseBuildArgs(["--watch"]);
      assert.strictEqual(opts.watch, true);
    });

    it("should parse -w flag", () => {
      const opts = parseBuildArgs(["-w"]);
      assert.strictEqual(opts.watch, true);
    });

    it("should parse --watch with --project", () => {
      const opts = parseBuildArgs(["--watch", "-p", "tsconfig.app.json"]);
      assert.strictEqual(opts.watch, true);
      assert.strictEqual(opts.project, "tsconfig.app.json");
    });

    it("should parse empty args", () => {
      const opts = parseBuildArgs([]);
      assert.strictEqual(opts.watch, undefined);
      assert.strictEqual(opts.project, undefined);
    });
  });

  describe("single-pass build", () => {
    let projectDir: string;

    before(() => {
      projectDir = copyFixture("single-pass");
    });

    after(() => {
      cleanup(projectDir);
    });

    it("should compile a project with @JSONSchema types", async () => {
      // Intercept process.exit to capture the exit code instead of dying
      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => { exitCode = code; }) as never;
      const originalCwd = process.cwd();

      try {
        process.chdir(projectDir);
        await runBuild({ quiet: true });
      } finally {
        process.chdir(originalCwd);
        process.exit = originalExit;
      }

      // No exit code means success (process.exit was not called)
      assert.strictEqual(exitCode, undefined, `Build failed with exit code ${exitCode}`);

      // Verify output files were created
      const distDir = join(projectDir, "dist");
      assert.ok(existsSync(distDir), "dist/ directory should exist");
      assert.ok(existsSync(join(distDir, "types.js")), "types.js should be emitted");
      assert.ok(existsSync(join(distDir, "types.d.ts")), "types.d.ts should be emitted");
      assert.ok(existsSync(join(distDir, "main.js")), "main.js should be emitted");
      assert.ok(existsSync(join(distDir, "utils.js")), "utils.js should be emitted");
    });

    it("should produce valid Greeting and Person schemas via namespace merging", async () => {
      const types = await import(pathToFileURL(join(projectDir, "dist/types.js")).href);

      const greetingSchema = types.Greeting.Schema.toJsonSchema();
      assert.strictEqual(greetingSchema.type, "object");
      assert.ok(greetingSchema.properties?.message, "Greeting should have a 'message' property");

      const personSchema = types.Person.Schema.toJsonSchema();
      assert.strictEqual(personSchema.type, "object");
      assert.ok(personSchema.properties?.name, "Person should have a 'name' property");
      assert.ok(personSchema.properties?.age, "Person should have an 'age' property");
    });

    it("should emit namespace declarations in .d.ts", () => {
      const typesDts = readFileSync(join(projectDir, "dist/types.d.ts"), "utf-8");
      for (const name of ["Greeting", "Person", "Choice"]) {
        assert.ok(typesDts.includes(`namespace ${name}`), `Declaration file should contain namespace ${name}`);
      }
    });

    it("should pass through non-@JSONSchema files unchanged", async () => {
      const utilsJs = readFileSync(join(projectDir, "dist/utils.js"), "utf-8");

      // utils.ts has no @JSONSchema markers — it should compile normally
      assert.ok(utilsJs.includes("Hello,"), "utils.js should contain the greet function");
      // Should NOT contain any schema namespace injection
      assert.ok(
        !utilsJs.includes("toJsonSchema"),
        "utils.js should not contain schema injection",
      );
    });

    it("should emit source maps", async () => {
      assert.ok(
        existsSync(join(projectDir, "dist/types.js.map")),
        "types.js.map should exist",
      );
      assert.ok(
        existsSync(join(projectDir, "dist/main.js.map")),
        "main.js.map should exist",
      );
    });

    it("should produce a valid Choice schema with oneOf for the discriminated union", async () => {
      const types = await import(pathToFileURL(join(projectDir, "dist/types.js")).href);
      const schema = types.Choice.Schema.toJsonSchema();

      // Structural verification
      const variants = schema.oneOf ?? schema.anyOf;
      assert.ok(Array.isArray(variants), "Choice schema should have oneOf/anyOf");
      assert.strictEqual(variants.length, 3, "Should have 3 variants (Done | Rename | GiveUp)");

      // Each variant should be fully inlined (no $ref) and have a 'type' discriminant
      for (const variant of variants) {
        assert.ok(!("$ref" in variant), "Variants should be inlined, not $ref");
        assert.ok(variant.properties?.type, "Each variant should have a 'type' discriminant property");
      }
    });
  });

  describe("single-pass build with --project flag", () => {
    let projectDir: string;

    before(() => {
      projectDir = copyFixture("project-flag");
    });

    after(() => {
      cleanup(projectDir);
    });

    it("should accept --project pointing to tsconfig.json", async () => {
      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => { exitCode = code; }) as never;

      try {
        // Run from temp root, not from project dir — use --project to locate tsconfig
        await runBuild({ project: join(projectDir, "tsconfig.json"), quiet: true });
      } finally {
        process.exit = originalExit;
      }

      assert.strictEqual(exitCode, undefined, `Build failed with exit code ${exitCode}`);
      assert.ok(existsSync(join(projectDir, "dist/types.js")), "Should emit output");
    });
  });

  describe("dependency checking", () => {
    /** Sentinel thrown to halt execution after an intercepted process.exit(). */
    class ExitSentinel extends Error {
      code: number;
      constructor(code: number) {
        super(`process.exit(${code})`);
        this.code = code;
      }
    }

    it("should exit with code 2 when dependencies are missing", async () => {
      // Create a project with package.json but no thinkwell/typescript deps
      const projectDir = join(tmpdir(), `thinkwell-build-test-deps-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "test-project", dependencies: { lodash: "^4.0.0" } }),
      );
      writeFileSync(
        join(projectDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { outDir: "dist" } }),
      );

      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new ExitSentinel(code ?? 0);
      }) as never;
      const originalCwd = process.cwd();

      // Capture stderr to verify error message
      let stderrOutput = "";
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        if (typeof chunk === "string") stderrOutput += chunk;
        return true;
      }) as typeof process.stderr.write;

      try {
        process.chdir(projectDir);
        await runBuild({ quiet: true });
      } catch (err) {
        if (!(err instanceof ExitSentinel)) throw err;
      } finally {
        process.chdir(originalCwd);
        process.exit = originalExit;
        process.stderr.write = originalStderrWrite;
        cleanup(projectDir);
      }

      assert.strictEqual(exitCode, 2, "Should exit with code 2 for missing dependencies");
      assert.ok(stderrOutput.includes("thinkwell"), "Error should mention thinkwell");
    });

    it("should proceed when dependencies are declared in package.json", async () => {
      // The fixture has deps declared, so it should not fail on dependency check
      const projectDir = copyFixture("deps-ok");

      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => { exitCode = code; }) as never;
      const originalCwd = process.cwd();

      try {
        process.chdir(projectDir);
        await runBuild({ quiet: true });
      } finally {
        process.chdir(originalCwd);
        process.exit = originalExit;
        cleanup(projectDir);
      }

      // Should succeed (no exit code) or fail with type errors (code 1), but NOT code 2
      assert.ok(
        exitCode === undefined || exitCode === 1,
        `Should not exit with code 2; got ${exitCode}`,
      );
    });
  });

  describe("error reporting", () => {
    let projectDir: string;

    before(() => {
      projectDir = copyFixture("errors");
    });

    after(() => {
      cleanup(projectDir);
    });

    it("should report type errors and exit with code 1", async () => {
      // Write a file with a type error
      writeFileSync(
        join(projectDir, "src/bad.ts"),
        `export const x: number = "not a number";\n`,
      );

      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => { exitCode = code; }) as never;
      const originalCwd = process.cwd();

      try {
        process.chdir(projectDir);
        await runBuild({ quiet: true });
      } finally {
        process.chdir(originalCwd);
        process.exit = originalExit;
      }

      assert.strictEqual(exitCode, 1, "Should exit with code 1 for type errors");
    });

    it("should fail when tsconfig.json is missing", async () => {
      const emptyDir = join(tmpdir(), `thinkwell-build-test-no-config-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => { exitCode = code; }) as never;
      const originalCwd = process.cwd();

      try {
        process.chdir(emptyDir);
        await runBuild({});
      } finally {
        process.chdir(originalCwd);
        process.exit = originalExit;
        cleanup(emptyDir);
      }

      assert.strictEqual(exitCode, 1, "Should exit with code 1 when tsconfig is missing");
    });
  });
});
