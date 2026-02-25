/**
 * Integration tests for project-config-aware behavior.
 *
 * These tests verify the "explicit config" feature where the CLI detects
 * a project with its own package.json and either:
 * - Uses bundled modules (zero-config, no package.json)
 * - Errors with guidance when package.json exists but deps are missing
 * - Resolves from node_modules when deps are present
 *
 * The `run` tests require the compiled binary (main.cjs has the explicit-config
 * logic; bin/thinkwell does not). The `bundle` dep-gating test can use the npm
 * distribution since bundle.ts has its own dependency checking.
 *
 * Skip these tests by setting: SKIP_CLI_TESTS=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync, symlinkSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
const DIST_BIN_DIR = resolve(PACKAGE_ROOT, "dist-bin");

// Skip CLI tests if requested
const SKIP_CLI = process.env.SKIP_CLI_TESTS === "1";
const SKIP_BINARY = (() => {
  const binaryPath = join(DIST_BIN_DIR, `thinkwell-${getPlatformTarget()}`);
  if (!existsSync(binaryPath)) return "binary not found";
  try {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
    const result = execSync(`${binaryPath} --version`, { encoding: "utf-8", timeout: 10000 });
    if (!result.includes(packageJson.version)) {
      return `binary is stale (expected ${packageJson.version}, run pnpm build:binary to update)`;
    }
  } catch {
    return "binary failed to execute";
  }
  return false;
})();

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

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[\d+m/g, "");
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): { stdout: string; stderr: string; code: number } {
  const { cwd = process.cwd(), env = process.env, timeout = 30000 } = options;
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0", NODE_DISABLE_COLORS: "1" },
    timeout,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: stripAnsi(result.stdout ?? ""),
    stderr: stripAnsi(result.stderr ?? ""),
    code: result.status ?? 1,
  };
}

function createTestDir(prefix: string): string {
  const testDir = join(tmpdir(), `thinkwell-test-project-config-${prefix}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  return testDir;
}

function cleanupTestDir(testDir: string): void {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// Test 1: run with no package.json uses bundled modules (zero-config)
// =============================================================================

describe("project config: run with no package.json (zero-config)", {
  skip: SKIP_CLI || SKIP_BINARY,
}, () => {
  const binaryPath = getBinaryPath();
  let testDir: string;

  before(() => {
    testDir = createTestDir("no-pkg");
  });

  after(() => {
    cleanupTestDir(testDir);
  });

  it("should resolve thinkwell imports from bundled modules", () => {
    const script = `
import { open, schemaOf } from "thinkwell";
console.log("open:", typeof open === "function");
console.log("schemaOf:", typeof schemaOf === "function");
`;
    const scriptPath = join(testDir, "zero-config.ts");
    writeFileSync(scriptPath, script);

    // No package.json in testDir → zero-config path
    const result = run(binaryPath, [scriptPath]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("open: true"), "open should be available from bundled modules");
    assert.ok(result.stdout.includes("schemaOf: true"), "schemaOf should be available from bundled modules");
  });

  it("should resolve @thinkwell/acp imports from bundled modules", () => {
    const script = `
import { JsonSchema } from "@thinkwell/acp";
const schema: JsonSchema = { type: "string" };
console.log("Schema type:", schema.type);
`;
    const scriptPath = join(testDir, "zero-config-acp.ts");
    writeFileSync(scriptPath, script);

    const result = run(binaryPath, [scriptPath]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("Schema type: string"), "Should resolve @thinkwell/acp from bundled");
  });
});

// =============================================================================
// Test 2: run with package.json missing thinkwell dep errors with guidance
// =============================================================================

describe("project config: run with package.json missing deps", {
  skip: SKIP_CLI || SKIP_BINARY,
}, () => {
  const binaryPath = getBinaryPath();

  describe("missing thinkwell dependency", () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("missing-thinkwell");
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: {
            lodash: "^4.0.0",
          },
        }, null, 2),
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should exit with code 2 and show remediation guidance", () => {
      const script = `
import { open } from "thinkwell";
console.log(open);
`;
      const scriptPath = join(testDir, "script.ts");
      writeFileSync(scriptPath, script);

      const result = run(binaryPath, [scriptPath]);
      assert.strictEqual(result.code, 2, `Expected exit code 2, got ${result.code}`);
      assert.ok(
        result.stderr.includes("thinkwell"),
        "Error should mention thinkwell",
      );
      assert.ok(
        result.stderr.includes("thinkwell init") || result.stderr.includes("add thinkwell"),
        "Error should include remediation guidance",
      );
    });
  });

  describe("missing thinkwell and typescript (with @JSONSchema)", () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("missing-both");
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: {},
        }, null, 2),
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should error about both missing deps when @JSONSchema is used", () => {
      const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface Greeting {
  message: string;
}

console.log(Greeting.Schema.toJsonSchema());
`;
      const scriptPath = join(testDir, "schema-script.ts");
      writeFileSync(scriptPath, script);

      const result = run(binaryPath, [scriptPath]);
      assert.strictEqual(result.code, 2, `Expected exit code 2, got ${result.code}`);
      assert.ok(result.stderr.includes("thinkwell"), "Error should mention thinkwell");
      assert.ok(result.stderr.includes("typescript"), "Error should mention typescript");
    });
  });

  describe("has thinkwell but missing typescript (with @JSONSchema)", () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("missing-ts");
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: {
            thinkwell: "^0.5.0",
          },
        }, null, 2),
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should error about missing typescript when @JSONSchema is used", () => {
      const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface Greeting {
  message: string;
}

console.log(Greeting.Schema.toJsonSchema());
`;
      const scriptPath = join(testDir, "schema-no-ts.ts");
      writeFileSync(scriptPath, script);

      const result = run(binaryPath, [scriptPath]);
      assert.strictEqual(result.code, 2, `Expected exit code 2, got ${result.code}`);
      assert.ok(result.stderr.includes("typescript"), "Error should mention typescript");
    });
  });

  describe("has thinkwell, missing typescript but no @JSONSchema", () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("ts-not-required");
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: {
            thinkwell: "^0.5.0",
          },
        }, null, 2),
      );
      // Create a minimal node_modules/thinkwell so the loader can resolve it
      const thinkwellDir = join(testDir, "node_modules/thinkwell");
      mkdirSync(thinkwellDir, { recursive: true });
      writeFileSync(
        join(thinkwellDir, "package.json"),
        JSON.stringify({ name: "thinkwell", main: "index.js", version: "0.5.0" }),
      );
      writeFileSync(
        join(thinkwellDir, "index.js"),
        `module.exports = { open: function() { return "mock"; }, schemaOf: function() { return {}; } };`,
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should NOT error about typescript when no @JSONSchema is used", () => {
      const script = `
import { open } from "thinkwell";
console.log("open:", typeof open === "function");
`;
      const scriptPath = join(testDir, "no-schema.ts");
      writeFileSync(scriptPath, script);

      const result = run(binaryPath, [scriptPath]);
      // Should succeed (or at least not exit code 2 for missing deps)
      assert.notStrictEqual(result.code, 2, "Should not fail with dep error when typescript not required");
    });
  });
});

// =============================================================================
// Test 3: run with package.json and deps resolves from node_modules
// =============================================================================

describe("project config: run with deps resolves from node_modules", {
  skip: SKIP_CLI || SKIP_BINARY,
}, () => {
  const binaryPath = getBinaryPath();
  let testDir: string;

  before(() => {
    testDir = createTestDir("explicit-config");
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        dependencies: {
          thinkwell: "^0.5.0",
        },
        devDependencies: {
          typescript: "^5.7.0",
        },
      }, null, 2),
    );

    // Create a mock thinkwell module in node_modules with a distinct marker
    // so we can verify it's resolved from node_modules, not bundled
    const thinkwellDir = join(testDir, "node_modules/thinkwell");
    mkdirSync(thinkwellDir, { recursive: true });
    writeFileSync(
      join(thinkwellDir, "package.json"),
      JSON.stringify({ name: "thinkwell", main: "index.js", version: "0.5.0" }),
    );
    writeFileSync(
      join(thinkwellDir, "index.js"),
      `module.exports = {
  open: function() { return "from-node-modules"; },
  schemaOf: function() { return {}; },
  __source: "node_modules",
};`,
    );
  });

  after(() => {
    cleanupTestDir(testDir);
  });

  it("should resolve thinkwell from node_modules (not bundled)", () => {
    const script = `
import { open } from "thinkwell";
const result = open();
console.log("result:", result);
`;
    const scriptPath = join(testDir, "explicit.ts");
    writeFileSync(scriptPath, script);

    const result = run(binaryPath, [scriptPath]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    // The mock returns "from-node-modules" — the bundled version would return something else
    assert.ok(
      result.stdout.includes("result: from-node-modules"),
      `Should resolve from node_modules, got: ${result.stdout}`,
    );
  });

  it("should expose __source marker from node_modules version", () => {
    const script = `
const thinkwell = require("thinkwell");
console.log("source:", thinkwell.__source);
`;
    const scriptPath = join(testDir, "explicit-source.js");
    writeFileSync(scriptPath, script);

    const result = run(binaryPath, [scriptPath]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(
      result.stdout.includes("source: node_modules"),
      `Should use node_modules version, got: ${result.stdout}`,
    );
  });
});

// =============================================================================
// Test 4: bundle with package.json missing deps errors with guidance
// =============================================================================

describe("project config: bundle with missing deps", {
  skip: SKIP_CLI || process.env.SKIP_BUILD_TESTS === "1",
}, () => {
  describe("missing thinkwell dependency", () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("bundle-missing-deps");
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: {
            lodash: "^4.0.0",
          },
        }, null, 2),
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should exit with code 2 and show remediation guidance", () => {
      const script = `
import { open } from "thinkwell";
console.log(open);
`;
      const scriptPath = join(testDir, "agent.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, "bundle", scriptPath, "--dry-run"]);
      assert.strictEqual(result.code, 2, `Expected exit code 2, got ${result.code}: stdout=${result.stdout} stderr=${result.stderr}`);
      assert.ok(
        result.stderr.includes("thinkwell"),
        "Error should mention thinkwell",
      );
      assert.ok(
        result.stderr.includes("thinkwell init") || result.stderr.includes("add thinkwell"),
        "Error should include remediation guidance",
      );
    });
  });

  describe("missing typescript with @JSONSchema", () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("bundle-missing-ts");
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: {
            thinkwell: "^0.5.0",
          },
        }, null, 2),
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should error about missing typescript when @JSONSchema is used", () => {
      const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface Config {
  name: string;
}

console.log(Config.Schema.toJsonSchema());
`;
      const scriptPath = join(testDir, "schema-agent.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, "bundle", scriptPath, "--dry-run"]);
      assert.strictEqual(result.code, 2, `Expected exit code 2, got ${result.code}: stderr=${result.stderr}`);
      assert.ok(result.stderr.includes("typescript"), "Error should mention typescript");
    });
  });

  describe("no package.json — no dep error", () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("bundle-no-pkg");
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should not error about dependencies when no package.json exists", () => {
      const script = `console.log("hello");`;
      const scriptPath = join(testDir, "simple.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, "bundle", scriptPath, "--dry-run"]);
      // Should NOT exit with code 2 (dependency error).
      // It may still fail for other reasons (e.g., missing dist-pkg in dev),
      // but the key assertion is that dependency gating doesn't trigger.
      assert.notStrictEqual(result.code, 2, `Should not fail with dep error: ${result.stderr}`);
      assert.ok(
        !result.stderr.includes("missing required dependencies"),
        "Should not show missing deps error",
      );
    });
  });
});

// =============================================================================
// Test 5: @JSONSchema processing uses project-local TS when available
// =============================================================================

describe("project config: @JSONSchema with project-local resolution", {
  skip: SKIP_CLI || SKIP_BINARY,
}, () => {
  const binaryPath = getBinaryPath();
  const FIXTURE_DIR = resolve(PACKAGE_ROOT, "test-fixtures/node-ux-project");

  describe("project with thinkwell and typescript deps", () => {
    let projectDir: string;

    before(() => {
      // Copy the node-ux-project fixture which has @JSONSchema types
      projectDir = join(tmpdir(), `thinkwell-test-project-config-jsonschema-${Date.now()}`);
      cpSync(FIXTURE_DIR, projectDir, { recursive: true });
      // Copy type-stubs into node_modules so TypeScript can resolve @thinkwell/acp
      cpSync(join(projectDir, "type-stubs"), join(projectDir, "node_modules"), { recursive: true });

      // Also need thinkwell in node_modules for the explicit-config path.
      // Copy the bundled thinkwell package so imports resolve.
      const thinkwellModDir = join(projectDir, "node_modules/thinkwell");
      mkdirSync(thinkwellModDir, { recursive: true });

      // Use the real thinkwell dist-pkg as the mock node_modules entry
      const distPkgPath = resolve(PACKAGE_ROOT, "dist-pkg/thinkwell.cjs");
      if (existsSync(distPkgPath)) {
        writeFileSync(
          join(thinkwellModDir, "package.json"),
          JSON.stringify({
            name: "thinkwell",
            main: "index.cjs",
            version: "0.5.0",
            exports: {
              ".": { default: "./index.cjs" },
              "./build": { default: "./build.cjs" },
            },
          }),
        );
        cpSync(distPkgPath, join(thinkwellModDir, "index.cjs"));

        // Provide the build API subpath so @JSONSchema processing resolves
        // generateSchemas via thinkwell/build (project-local path).
        // This is a minimal CJS implementation of the build API contract.
        writeFileSync(
          join(thinkwellModDir, "build.cjs"),
          [
            `const path = require("path");`,
            `const fs = require("fs");`,
            `const { createGenerator } = require("ts-json-schema-generator");`,
            `function findTsConfig(dir) {`,
            `  while (true) {`,
            `    const p = path.join(dir, "tsconfig.json");`,
            `    if (fs.existsSync(p)) return p;`,
            `    const parent = path.dirname(dir);`,
            `    if (parent === dir) return undefined;`,
            `    dir = parent;`,
            `  }`,
            `}`,
            `function inlineRefs(obj, defs) {`,
            `  if (obj === null || typeof obj !== "object") return obj;`,
            `  if (Array.isArray(obj)) return obj.map(i => inlineRefs(i, defs));`,
            `  if (typeof obj["$ref"] === "string") {`,
            `    const m = obj["$ref"].match(/^#\\/definitions\\/(.+)$/);`,
            `    if (m && defs[m[1]]) return inlineRefs(defs[m[1]], defs);`,
            `  }`,
            `  const r = {};`,
            `  for (const [k, v] of Object.entries(obj)) r[k] = inlineRefs(v, defs);`,
            `  return r;`,
            `}`,
            `exports.generateSchemas = function(filePath, typeNames) {`,
            `  const schemas = new Map();`,
            `  if (!typeNames.length) return schemas;`,
            `  const tsconfig = findTsConfig(path.dirname(filePath));`,
            `  const gen = createGenerator({ path: filePath, ...(tsconfig && { tsconfig }), skipTypeCheck: true, encodeRefs: false });`,
            `  for (const name of typeNames) {`,
            `    const s = gen.createSchema(name);`,
            `    const defs = s.definitions || {};`,
            `    let r = defs[name] || s;`,
            `    r = inlineRefs(r, defs);`,
            `    if (typeof r === "object" && r !== null) { const c = { ...r }; delete c["$schema"]; delete c["definitions"]; schemas.set(name, c); }`,
            `    else schemas.set(name, r);`,
            `  }`,
            `  return schemas;`,
            `};`,
          ].join("\n"),
        );
      }

      // Symlink ts-json-schema-generator from the workspace so that the
      // mock thinkwell/build can resolve it without a full npm install.
      const tsjsgSource = resolve(PACKAGE_ROOT, "node_modules/ts-json-schema-generator");
      const tsjsgTarget = join(projectDir, "node_modules/ts-json-schema-generator");
      if (existsSync(tsjsgSource) && !existsSync(tsjsgTarget)) {
        symlinkSync(tsjsgSource, tsjsgTarget);
      }
    });

    after(() => {
      cleanupTestDir(projectDir);
    });

    it("should process @JSONSchema types in explicit-config mode", () => {
      // The fixture has src/types.ts with @JSONSchema interfaces.
      // Write a script that imports and uses them.
      const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface TestItem {
  name: string;
  count: number;
}

const schema = TestItem.Schema.toJsonSchema();
console.log("Schema type:", schema.type);
console.log("Has name:", "name" in (schema.properties ?? {}));
console.log("Has count:", "count" in (schema.properties ?? {}));
`;
      const scriptPath = join(projectDir, "src/test-schema.ts");
      writeFileSync(scriptPath, script);

      const result = run(binaryPath, [scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Schema type: object"), "Should generate object schema");
      assert.ok(result.stdout.includes("Has name: true"), "Schema should have name property");
      assert.ok(result.stdout.includes("Has count: true"), "Schema should have count property");
    });
  });
});
