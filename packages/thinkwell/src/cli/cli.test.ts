/**
 * Integration tests for the thinkwell CLI.
 *
 * These tests verify the CLI functionality for both:
 * - npm distribution (bin/thinkwell)
 * - compiled binary distribution (dist-bin/thinkwell-{platform})
 *
 * Tests cover:
 * - Basic script execution
 * - TypeScript support (type stripping and transformation)
 * - User script imports from node_modules
 * - thinkwell and bundled package imports
 * - @JSONSchema processing
 *
 * Skip these tests by setting: SKIP_CLI_TESTS=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execSync, spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const NPM_BIN = resolve(PACKAGE_ROOT, "bin/thinkwell");
const DIST_BIN_DIR = resolve(PACKAGE_ROOT, "dist-bin");

// Skip CLI tests if requested or if binaries aren't built/stale
const SKIP_CLI = process.env.SKIP_CLI_TESTS === "1";
const SKIP_BINARY = (() => {
  const binaryPath = join(DIST_BIN_DIR, `thinkwell-${getPlatformTarget()}`);
  if (!existsSync(binaryPath)) return "binary not found";
  // Check if the binary's version matches package.json to detect stale builds
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

// Strip ANSI escape codes from a string.
// node --test can cause util.inspect to colorize values in child processes
// even when stdout is piped and NO_COLOR is set.
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[\d+m/g, "");
}

// Helper to run a command and capture output (both stdout and stderr)
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

// Helper to run thinkwell via npm distribution with transform-types flag
// Required for @JSONSchema tests (which generate namespace declarations)
function runThinkwellWithTransform(
  scriptPath: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): { stdout: string; stderr: string; code: number } {
  return run(
    "node",
    ["--experimental-transform-types", NPM_BIN, scriptPath, ...args],
    options
  );
}

// Helper to create a temporary test directory
function createTestDir(prefix: string): string {
  const testDir = join(tmpdir(), `thinkwell-test-${prefix}-${Date.now()}`);
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

describe("CLI integration tests", { skip: SKIP_CLI }, () => {
  describe("npm distribution (bin/thinkwell)", () => {
    it("should show help with --help flag", () => {
      const result = run("node", [NPM_BIN, "--help"]);
      assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}`);
      assert.ok(result.stdout.includes("thinkwell"), "Help should mention thinkwell");
      assert.ok(result.stdout.includes("Usage:"), "Help should include usage section");
    });

    it("should show version with --version flag", async () => {
      const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
      const result = run("node", [NPM_BIN, "--version"]);
      assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}`);
      assert.ok(
        result.stdout.includes(packageJson.version),
        `Version should include ${packageJson.version}`
      );
    });

    it("should show help with no arguments", () => {
      const result = run("node", [NPM_BIN]);
      assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}`);
      assert.ok(result.stdout.includes("Usage:"), "Should show usage");
    });

    it("should error on non-existent script", () => {
      const result = run("node", [NPM_BIN, "nonexistent.ts"]);
      assert.notStrictEqual(result.code, 0, "Should fail for non-existent script");
      assert.ok(
        result.stderr.includes("not found") || result.stderr.includes("Error"),
        "Should report file not found"
      );
    });
  });

  describe("compiled binary distribution", { skip: SKIP_BINARY }, () => {
    const binaryPath = getBinaryPath();

    it("should show help with --help flag", () => {
      const result = run(binaryPath, ["--help"]);
      assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}`);
      assert.ok(result.stdout.includes("thinkwell"), "Help should mention thinkwell");
      assert.ok(result.stdout.includes("Usage:"), "Help should include usage section");
    });

    it("should show version with --version flag", () => {
      const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
      const result = run(binaryPath, ["--version"]);
      assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}`);
      assert.ok(
        result.stdout.includes(packageJson.version),
        `Version should include ${packageJson.version}`
      );
    });

    it("should error on non-existent script", () => {
      const result = run(binaryPath, ["nonexistent.ts"]);
      assert.notStrictEqual(result.code, 0, "Should fail for non-existent script");
    });
  });

  describe("TypeScript script execution", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("typescript");
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should execute basic TypeScript with type annotations", () => {
      const script = `
const greeting: string = "Hello, TypeScript!";
const count: number = 42;
console.log(greeting);
console.log("Count:", count);
`;
      const scriptPath = join(testDir, "basic.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Hello, TypeScript!"), "Should output greeting");
      assert.ok(result.stdout.includes("Count: 42"), "Should output count");
    });

    it("should execute TypeScript with interfaces", () => {
      const script = `
interface Person {
  name: string;
  age: number;
}

const user: Person = { name: "Alice", age: 30 };
console.log("User:", JSON.stringify(user));
`;
      const scriptPath = join(testDir, "interface.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes('"name":"Alice"'), "Should output user object");
    });

    it("should execute TypeScript with generics", () => {
      const script = `
function identity<T>(value: T): T {
  return value;
}

class Box<T> {
  private value: T;
  constructor(value: T) { this.value = value; }
  get(): T { return this.value; }
}

const str = identity("hello");
const box = new Box(42);
console.log("Identity:", str);
console.log("Box:", box.get());
`;
      const scriptPath = join(testDir, "generics.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Identity: hello"), "Should output identity result");
      assert.ok(result.stdout.includes("Box: 42"), "Should output box value");
    });

    it("should execute TypeScript with type-only imports", () => {
      const script = `
import type { Stats } from "node:fs";
import { statSync } from "node:fs";

type FileInfo = { size: number };
const stats: Stats = statSync(process.argv[1]);
const info: FileInfo = { size: stats.size };
console.log("File size:", info.size);
`;
      const scriptPath = join(testDir, "type-imports.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("File size:"), "Should output file size");
    });
  });

  describe("thinkwell imports", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("thinkwell-imports");
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should resolve thinkwell package imports", () => {
      const script = `
import { open, schemaOf } from "thinkwell";
console.log("open:", typeof open === "function");
console.log("schemaOf:", typeof schemaOf === "function");
`;
      const scriptPath = join(testDir, "thinkwell-pkg.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("open: true"), "open should be available");
      assert.ok(result.stdout.includes("schemaOf: true"), "schemaOf should be available");
    });

    it("should resolve @thinkwell/acp imports", () => {
      const script = `
import { JsonSchema } from "@thinkwell/acp";
const schema: JsonSchema = { type: "string" };
console.log("Schema type:", schema.type);
`;
      const scriptPath = join(testDir, "thinkwell-acp.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Schema type: string"), "Should resolve @thinkwell/acp");
    });
  });

  describe("@JSONSchema processing", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("jsonschema");
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should generate schema for @JSONSchema-marked interface", () => {
      const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface Person {
  /** The person's name */
  name: string;
  /** The person's age */
  age: number;
}

// Access schema via Person.Schema (namespace merging)
const schema = Person.Schema.toJsonSchema();
console.log("Schema type:", schema.type);
console.log("Has name property:", "name" in (schema.properties ?? {}));
console.log("Has age property:", "age" in (schema.properties ?? {}));
console.log("Required fields:", JSON.stringify(schema.required));
`;
      const scriptPath = join(testDir, "jsonschema-basic.ts");
      writeFileSync(scriptPath, script);

      // @JSONSchema generates namespace declarations, which require --experimental-transform-types
      const result = runThinkwellWithTransform(scriptPath);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Schema type: object"), "Schema should be object type");
      assert.ok(result.stdout.includes("Has name property: true"), "Schema should have name");
      assert.ok(result.stdout.includes("Has age property: true"), "Schema should have age");
    });

    it("should work with schemaOf for @JSONSchema types", () => {
      const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface SearchResult {
  title: string;
  url: string;
  score: number;
}

// Access schema via SearchResult.Schema (namespace merging)
// schemaOf() is for manually-defined schemas; @JSONSchema uses .Schema
const schema = SearchResult.Schema.toJsonSchema();

console.log("Has title:", "title" in (schema.properties ?? {}));
console.log("Has url:", "url" in (schema.properties ?? {}));
console.log("Has score:", "score" in (schema.properties ?? {}));
`;
      const scriptPath = join(testDir, "jsonschema-schemaof.ts");
      writeFileSync(scriptPath, script);

      // @JSONSchema generates namespace declarations, which require --experimental-transform-types
      const result = runThinkwellWithTransform(scriptPath);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Has title: true"), "Schema should have title");
      assert.ok(result.stdout.includes("Has url: true"), "Schema should have url");
      assert.ok(result.stdout.includes("Has score: true"), "Schema should have score");
    });

    it("should handle complex @JSONSchema types with nested objects", () => {
      const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface Address {
  street: string;
  city: string;
  zip: string;
}

/** @JSONSchema */
export interface Customer {
  id: number;
  name: string;
  address: Address;
  tags: string[];
}

// Access schema via Customer.Schema (namespace merging)
const schema = Customer.Schema.toJsonSchema();
console.log("Has address:", "address" in (schema.properties ?? {}));
console.log("Has tags:", "tags" in (schema.properties ?? {}));
`;
      const scriptPath = join(testDir, "jsonschema-nested.ts");
      writeFileSync(scriptPath, script);

      // @JSONSchema generates namespace declarations, which require --experimental-transform-types
      const result = runThinkwellWithTransform(scriptPath);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Has address: true"), "Should have nested address");
      assert.ok(result.stdout.includes("Has tags: true"), "Should have tags array");
    });
  });

  describe("ESM script execution", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("esm");
      // Create package.json with type: module
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({ type: "module" }, null, 2)
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should execute ESM JavaScript with import statements", () => {
      const script = `
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
console.log("Package type:", pkg.type);
`;
      const scriptPath = join(testDir, "esm-script.js");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath], { cwd: testDir });
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Package type: module"), "Should execute ESM");
    });

    it("should execute ESM TypeScript", () => {
      const script = `
import { readFileSync } from "node:fs";

interface Config {
  type: string;
}

const data: string = readFileSync("./package.json", "utf-8");
const config: Config = JSON.parse(data);
console.log("Config type:", config.type);
`;
      const scriptPath = join(testDir, "esm-ts.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath], { cwd: testDir });
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Config type: module"), "Should execute ESM TypeScript");
    });
  });

  describe("node_modules imports", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("node-modules");
      // Create a minimal package.json
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({ name: "test-project", type: "module" }, null, 2)
      );
      // Create a simple local module in node_modules
      const localModuleDir = join(testDir, "node_modules", "local-test-module");
      mkdirSync(localModuleDir, { recursive: true });
      writeFileSync(
        join(localModuleDir, "package.json"),
        JSON.stringify({ name: "local-test-module", main: "index.js", type: "module" }, null, 2)
      );
      writeFileSync(
        join(localModuleDir, "index.js"),
        `export function greet(name) { return "Hello, " + name + "!"; }`
      );
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should resolve imports from local node_modules", () => {
      const script = `
import { greet } from "local-test-module";
console.log(greet("World"));
`;
      const scriptPath = join(testDir, "use-local.js");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath], { cwd: testDir });
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Hello, World!"), "Should resolve local module");
    });

    it("should resolve TypeScript imports from local node_modules", () => {
      const script = `
import { greet } from "local-test-module";

const name: string = "TypeScript";
const message: string = greet(name);
console.log(message);
`;
      const scriptPath = join(testDir, "use-local.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath], { cwd: testDir });
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes("Hello, TypeScript!"), "Should resolve with TypeScript");
    });
  });

  describe("script arguments", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("args");
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should pass arguments to user scripts", () => {
      const script = `
const args = process.argv.slice(2);
console.log("Args:", JSON.stringify(args));
`;
      const scriptPath = join(testDir, "args.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath, "--flag", "value", "positional"]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('["--flag","value","positional"]'),
        "Should pass all arguments"
      );
    });

    it("should work with run subcommand and arguments", () => {
      const script = `
const args = process.argv.slice(2);
console.log("Args:", JSON.stringify(args));
`;
      const scriptPath = join(testDir, "run-args.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, "run", scriptPath, "arg1", "arg2"]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(result.stdout.includes('["arg1","arg2"]'), "Should pass arguments after script");
    });
  });

  describe("shebang support", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("shebang");
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should strip shebang from scripts", () => {
      const script = `#!/usr/bin/env thinkwell
const msg: string = "Shebang stripped successfully";
console.log(msg);
`;
      const scriptPath = join(testDir, "shebang.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("Shebang stripped successfully"),
        "Should execute with shebang"
      );
    });
  });

  describe("error handling", { skip: SKIP_CLI }, () => {
    let testDir: string;

    before(() => {
      testDir = createTestDir("errors");
    });

    after(() => {
      cleanupTestDir(testDir);
    });

    it("should report syntax errors in scripts", () => {
      const script = `
const x: string = "unclosed string
console.log(x);
`;
      const scriptPath = join(testDir, "syntax-error.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.notStrictEqual(result.code, 0, "Should fail on syntax error");
    });

    it("should report runtime errors with stack traces", () => {
      const script = `
function throwError(): never {
  throw new Error("Test runtime error");
}
throwError();
`;
      const scriptPath = join(testDir, "runtime-error.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.notStrictEqual(result.code, 0, "Should fail on runtime error");
      assert.ok(
        result.stderr.includes("Test runtime error") || result.stdout.includes("Test runtime error"),
        "Should show error message"
      );
    });

    it("should report missing module errors", () => {
      const script = `
import { something } from "nonexistent-module-12345";
console.log(something);
`;
      const scriptPath = join(testDir, "missing-module.ts");
      writeFileSync(scriptPath, script);

      const result = run("node", [NPM_BIN, scriptPath]);
      assert.notStrictEqual(result.code, 0, "Should fail on missing module");
    });
  });
});

describe("compiled binary tests", { skip: SKIP_CLI || SKIP_BINARY }, () => {
  const binaryPath = getBinaryPath();
  let testDir: string;

  before(() => {
    testDir = createTestDir("pkg-binary");
  });

  after(() => {
    cleanupTestDir(testDir);
  });

  it("should execute TypeScript scripts", () => {
    const script = `
const greeting: string = "Hello from compiled binary!";
console.log(greeting);
`;
    const scriptPath = join(testDir, "basic.ts");
    writeFileSync(scriptPath, script);

    const result = run(binaryPath, [scriptPath]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("Hello from compiled binary!"), "Should execute TypeScript");
  });

  it("should resolve thinkwell imports", () => {
    const script = `
import { open, schemaOf } from "thinkwell";
console.log("open:", typeof open === "function");
console.log("schemaOf:", typeof schemaOf === "function");
`;
    const scriptPath = join(testDir, "thinkwell.ts");
    writeFileSync(scriptPath, script);

    const result = run(binaryPath, [scriptPath]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("open: true"), "Should have open");
    assert.ok(result.stdout.includes("schemaOf: true"), "Should have schemaOf");
  });

  it("should process @JSONSchema types", () => {
    const script = `
import { schemaOf } from "thinkwell";

/** @JSONSchema */
export interface Item {
  name: string;
  count: number;
}

// Access schema via Item.Schema (namespace merging)
const schema = Item.Schema.toJsonSchema();
console.log("Schema type:", schema.type);
`;
    const scriptPath = join(testDir, "jsonschema.ts");
    writeFileSync(scriptPath, script);

    const result = run(binaryPath, [scriptPath]);
    assert.strictEqual(result.code, 0, `Exit code should be 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("Schema type: object"), "Should generate schema");
  });
});

// =============================================================================
// Binary tests for thinkwell check command
// =============================================================================

const FIXTURE_DIR = resolve(PACKAGE_ROOT, "test-fixtures/node-ux-project");

/**
 * Copy the node-ux-project fixture into a temp directory.
 * Also copies type-stubs/ into node_modules/ so TypeScript can resolve
 * the @thinkwell/acp type-only import that @JSONSchema transformation injects.
 */
function copyFixture(prefix: string): string {
  const dest = join(tmpdir(), `thinkwell-cli-test-${prefix}-${Date.now()}`);
  cpSync(FIXTURE_DIR, dest, { recursive: true });
  cpSync(join(dest, "type-stubs"), join(dest, "node_modules"), { recursive: true });
  return dest;
}

/**
 * Create a minimal TypeScript project for testing.
 */
function createMinimalProject(prefix: string): string {
  const dir = join(tmpdir(), `thinkwell-cli-test-${prefix}-${Date.now()}`);
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-project",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: {
        thinkwell: "^0.5.0",
      },
      devDependencies: {
        typescript: "^5.7.0",
      },
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

describe("thinkwell check (binary)", { skip: SKIP_CLI || SKIP_BINARY }, () => {
  const binaryPath = getBinaryPath();

  it("should show help with check --help", () => {
    const result = run(binaryPath, ["check", "--help"]);
    assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}`);
    assert.ok(result.stdout.includes("thinkwell check"), "Help should mention check command");
    assert.ok(result.stdout.includes("Type-check"), "Help should describe type-checking");
  });

  describe("clean TypeScript project", () => {
    let projectDir: string;

    before(() => {
      projectDir = createMinimalProject("check-clean");
    });

    after(() => {
      cleanupTestDir(projectDir);
    });

    it("should pass type-checking with exit code 0", () => {
      const result = run(binaryPath, ["check"], { cwd: projectDir });
      assert.strictEqual(result.code, 0, `Expected clean check but got exit code ${result.code}: ${result.stderr}`);
      assert.ok(
        result.stderr.includes("No type errors") || result.stderr.includes("Checking"),
        "Should report checking status",
      );
    });
  });

  describe("@JSONSchema project", () => {
    let projectDir: string;

    before(() => {
      projectDir = copyFixture("check-jsonschema");
    });

    after(() => {
      cleanupTestDir(projectDir);
    });

    it("should pass type-checking with @JSONSchema types", () => {
      const result = run(binaryPath, ["check"], { cwd: projectDir });
      assert.strictEqual(result.code, 0, `Expected clean check but got exit code ${result.code}: ${result.stderr}`);
      assert.ok(
        result.stderr.includes("No type errors") || result.stderr.includes("Checking"),
        "Should report checking status",
      );
    });
  });

  describe("project with type errors", () => {
    let projectDir: string;

    before(() => {
      projectDir = createMinimalProject("check-errors");
      // Inject a file with a type error
      writeFileSync(
        join(projectDir, "src/bad.ts"),
        `export const x: number = "not a number";\n`,
      );
    });

    after(() => {
      cleanupTestDir(projectDir);
    });

    it("should exit with code 1 when type errors are present", () => {
      const result = run(binaryPath, ["check"], { cwd: projectDir });
      assert.strictEqual(result.code, 1, "Should exit with code 1 for type errors");
      assert.ok(
        result.stderr.includes("TS2322") || result.stderr.includes("not assignable"),
        "Should include the type error diagnostic",
      );
    });
  });

  describe("missing tsconfig.json", () => {
    let emptyDir: string;

    before(() => {
      emptyDir = join(tmpdir(), `thinkwell-cli-test-check-no-config-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
    });

    after(() => {
      cleanupTestDir(emptyDir);
    });

    it("should exit with code 2 when tsconfig.json is missing", () => {
      const result = run(binaryPath, ["check"], { cwd: emptyDir });
      assert.strictEqual(result.code, 2, "Should exit with code 2 for config error");
      assert.ok(result.stderr.includes("Cannot find tsconfig.json"), "Should report missing config");
    });
  });
});

// =============================================================================
// Binary tests for thinkwell build command
// =============================================================================

describe("thinkwell build (binary)", { skip: SKIP_CLI || SKIP_BINARY }, () => {
  const binaryPath = getBinaryPath();

  it("should show help with build --help", () => {
    const result = run(binaryPath, ["build", "--help"]);
    assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}`);
    assert.ok(result.stdout.includes("thinkwell build"), "Help should mention build command");
    assert.ok(result.stdout.includes("Compile"), "Help should describe compilation");
  });

  describe("compile @JSONSchema project", () => {
    let projectDir: string;

    before(() => {
      projectDir = copyFixture("build-jsonschema");
    });

    after(() => {
      cleanupTestDir(projectDir);
    });

    it("should compile project with @JSONSchema types", () => {
      const result = run(binaryPath, ["build"], { cwd: projectDir, timeout: 60000 });
      assert.strictEqual(result.code, 0, `Build failed with exit code ${result.code}: ${result.stderr}`);

      // Verify output files were created
      const distDir = join(projectDir, "dist");
      assert.ok(existsSync(distDir), "dist/ directory should exist");
      assert.ok(existsSync(join(distDir, "types.js")), "types.js should be emitted");
      assert.ok(existsSync(join(distDir, "types.d.ts")), "types.d.ts should be emitted");
      assert.ok(existsSync(join(distDir, "main.js")), "main.js should be emitted");
    });

    it("should inject @JSONSchema namespace declarations in emitted JS", () => {
      const typesJs = readFileSync(join(projectDir, "dist/types.js"), "utf-8");

      // The transformation should have injected namespace declarations
      assert.ok(
        typesJs.includes("Greeting.Schema") || typesJs.includes("Greeting["),
        "Emitted types.js should contain Greeting schema namespace",
      );
    });

    it("should emit declaration files with namespace merging", () => {
      const typesDts = readFileSync(join(projectDir, "dist/types.d.ts"), "utf-8");

      assert.ok(
        typesDts.includes("namespace Greeting"),
        "Declaration file should contain Greeting namespace",
      );
    });
  });

  describe("project with type errors", () => {
    let projectDir: string;

    before(() => {
      projectDir = createMinimalProject("build-errors");
      // Inject a file with a type error
      writeFileSync(
        join(projectDir, "src/bad.ts"),
        `export const x: number = "not a number";\n`,
      );
    });

    after(() => {
      cleanupTestDir(projectDir);
    });

    it("should exit with code 1 when type errors are present", () => {
      const result = run(binaryPath, ["build"], { cwd: projectDir, timeout: 60000 });
      assert.strictEqual(result.code, 1, "Should exit with code 1 for type errors");
    });
  });

  describe("missing tsconfig.json", () => {
    let emptyDir: string;

    before(() => {
      emptyDir = join(tmpdir(), `thinkwell-cli-test-build-no-config-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
    });

    after(() => {
      cleanupTestDir(emptyDir);
    });

    it("should exit with code 1 when tsconfig.json is missing", () => {
      const result = run(binaryPath, ["build"], { cwd: emptyDir, timeout: 60000 });
      assert.strictEqual(result.code, 1, "Should exit with code 1 for missing config");
      assert.ok(result.stderr.includes("Cannot find"), "Should report missing config");
    });
  });
});
