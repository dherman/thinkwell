/**
 * Unit tests for package manager detection.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectPackageManager,
  parsePackageManagerField,
  type PackageManager,
} from "./package-manager.js";

// ============================================================================
// Helpers
// ============================================================================

function createTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `thinkwell-pm-test-${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// parsePackageManagerField
// ============================================================================

describe("parsePackageManagerField", () => {
  it("should parse pnpm@version", () => {
    assert.strictEqual(parsePackageManagerField("pnpm@9.0.0"), "pnpm");
    assert.strictEqual(parsePackageManagerField("pnpm@8.15.0"), "pnpm");
  });

  it("should parse npm@version", () => {
    assert.strictEqual(parsePackageManagerField("npm@10.0.0"), "npm");
    assert.strictEqual(parsePackageManagerField("npm@9.8.1"), "npm");
  });

  it("should parse yarn@version", () => {
    assert.strictEqual(parsePackageManagerField("yarn@4.0.0"), "yarn");
    assert.strictEqual(parsePackageManagerField("yarn@1.22.19"), "yarn");
  });

  it("should handle name without version", () => {
    assert.strictEqual(parsePackageManagerField("pnpm"), "pnpm");
    assert.strictEqual(parsePackageManagerField("npm"), "npm");
    assert.strictEqual(parsePackageManagerField("yarn"), "yarn");
  });

  it("should return null for unknown package managers", () => {
    assert.strictEqual(parsePackageManagerField("bun@1.0.0"), null);
    assert.strictEqual(parsePackageManagerField("deno@1.0.0"), null);
  });

  it("should return null for non-string values", () => {
    assert.strictEqual(parsePackageManagerField(null), null);
    assert.strictEqual(parsePackageManagerField(undefined), null);
    assert.strictEqual(parsePackageManagerField(123), null);
    assert.strictEqual(parsePackageManagerField({ name: "pnpm" }), null);
  });

  it("should return null for empty string", () => {
    assert.strictEqual(parsePackageManagerField(""), null);
  });

  it("should handle version with corepack hash", () => {
    // Corepack can add a hash suffix: pnpm@9.0.0+sha256.abc123
    // The @ before version means we still extract "pnpm"
    assert.strictEqual(
      parsePackageManagerField("pnpm@9.0.0+sha256.abc123"),
      "pnpm",
    );
  });
});

// ============================================================================
// detectPackageManager - lockfile detection
// ============================================================================

describe("detectPackageManager", () => {
  describe("lockfile detection", () => {
    describe("pnpm-lock.yaml", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("pnpm-lock");
        writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test" }),
        );
      });

      after(() => cleanup(dir));

      it("should detect pnpm from pnpm-lock.yaml", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "pnpm");
        assert.strictEqual(result.lockfile, "pnpm-lock.yaml");
      });
    });

    describe("yarn.lock", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("yarn-lock");
        writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test" }),
        );
      });

      after(() => cleanup(dir));

      it("should detect yarn from yarn.lock", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "yarn");
        assert.strictEqual(result.lockfile, "yarn.lock");
      });
    });

    describe("package-lock.json", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("npm-lock");
        writeFileSync(
          join(dir, "package-lock.json"),
          JSON.stringify({ lockfileVersion: 3 }),
        );
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test" }),
        );
      });

      after(() => cleanup(dir));

      it("should detect npm from package-lock.json", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "npm");
        assert.strictEqual(result.lockfile, "package-lock.json");
      });
    });
  });

  describe("lockfile priority", () => {
    describe("pnpm takes precedence over yarn", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("pnpm-over-yarn");
        writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
        writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test" }),
        );
      });

      after(() => cleanup(dir));

      it("should prefer pnpm-lock.yaml over yarn.lock", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "pnpm");
        assert.strictEqual(result.lockfile, "pnpm-lock.yaml");
      });
    });

    describe("yarn takes precedence over npm", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("yarn-over-npm");
        writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
        writeFileSync(
          join(dir, "package-lock.json"),
          JSON.stringify({ lockfileVersion: 3 }),
        );
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test" }),
        );
      });

      after(() => cleanup(dir));

      it("should prefer yarn.lock over package-lock.json", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "yarn");
        assert.strictEqual(result.lockfile, "yarn.lock");
      });
    });
  });

  describe("packageManager field fallback", () => {
    describe("no lockfile, has packageManager field", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("pm-field");
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "test",
            packageManager: "pnpm@9.15.0",
          }),
        );
      });

      after(() => cleanup(dir));

      it("should detect from packageManager field when no lockfile", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "pnpm");
        assert.strictEqual(result.lockfile, null);
      });
    });

    describe("lockfile takes precedence over packageManager field", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("lockfile-over-field");
        writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "test",
            packageManager: "pnpm@9.15.0", // Says pnpm but has yarn.lock
          }),
        );
      });

      after(() => cleanup(dir));

      it("should prefer lockfile over packageManager field", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "yarn");
        assert.strictEqual(result.lockfile, "yarn.lock");
      });
    });
  });

  describe("default to npm", () => {
    describe("no lockfile, no packageManager field", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("default-npm");
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "test" }),
        );
      });

      after(() => cleanup(dir));

      it("should default to npm", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "npm");
        assert.strictEqual(result.lockfile, null);
      });
    });

    describe("no package.json at all", () => {
      let dir: string;

      before(() => {
        dir = createTmpDir("no-pkg-json");
      });

      after(() => cleanup(dir));

      it("should default to npm when no package.json exists", () => {
        const result = detectPackageManager(dir);
        assert.strictEqual(result.name, "npm");
        assert.strictEqual(result.lockfile, null);
      });
    });
  });
});

// ============================================================================
// Command generation
// ============================================================================

describe("PackageManagerInfo commands", () => {
  describe("addCommand", () => {
    it("should generate correct pnpm add commands", () => {
      const dir = createTmpDir("cmd-pnpm");
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

      const pm = detectPackageManager(dir);
      assert.strictEqual(pm.addCommand("thinkwell"), "pnpm add thinkwell");
      assert.strictEqual(
        pm.addCommand("typescript", true),
        "pnpm add -D typescript",
      );
      assert.strictEqual(
        pm.addCommand("thinkwell@^0.5.0"),
        "pnpm add thinkwell@^0.5.0",
      );

      cleanup(dir);
    });

    it("should generate correct npm install commands", () => {
      const dir = createTmpDir("cmd-npm");
      writeFileSync(
        join(dir, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3 }),
      );

      const pm = detectPackageManager(dir);
      assert.strictEqual(pm.addCommand("thinkwell"), "npm install thinkwell");
      assert.strictEqual(
        pm.addCommand("typescript", true),
        "npm install -D typescript",
      );

      cleanup(dir);
    });

    it("should generate correct yarn add commands", () => {
      const dir = createTmpDir("cmd-yarn");
      writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");

      const pm = detectPackageManager(dir);
      assert.strictEqual(pm.addCommand("thinkwell"), "yarn add thinkwell");
      assert.strictEqual(
        pm.addCommand("typescript", true),
        "yarn add -D typescript",
      );

      cleanup(dir);
    });
  });

  describe("whyCommand", () => {
    it("should generate correct pnpm why command", () => {
      const dir = createTmpDir("why-pnpm");
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

      const pm = detectPackageManager(dir);
      assert.deepStrictEqual(pm.whyCommand("thinkwell"), [
        "pnpm",
        "why",
        "thinkwell",
        "--json",
      ]);

      cleanup(dir);
    });

    it("should generate correct npm why command", () => {
      const dir = createTmpDir("why-npm");
      writeFileSync(
        join(dir, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3 }),
      );

      const pm = detectPackageManager(dir);
      assert.deepStrictEqual(pm.whyCommand("thinkwell"), [
        "npm",
        "why",
        "thinkwell",
        "--json",
      ]);

      cleanup(dir);
    });

    it("should generate correct yarn why command", () => {
      const dir = createTmpDir("why-yarn");
      writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");

      const pm = detectPackageManager(dir);
      assert.deepStrictEqual(pm.whyCommand("thinkwell"), [
        "yarn",
        "why",
        "thinkwell",
        "--json",
      ]);

      cleanup(dir);
    });
  });
});
