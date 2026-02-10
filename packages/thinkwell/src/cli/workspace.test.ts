/**
 * Unit tests for workspace detection and package name resolution.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parsePnpmWorkspaceYaml,
  expandWorkspaceGlobs,
  detectWorkspace,
  resolvePackageName,
  type WorkspaceMember,
} from "./workspace.js";

// ============================================================================
// Helpers
// ============================================================================

function createTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `thinkwell-ws-test-${prefix}-${Date.now()}`);
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

/** Create a minimal package directory with package.json and optional tsconfig.json. */
function createPackage(
  dir: string,
  name: string,
  opts?: { tsconfig?: boolean },
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }, null, 2));
  if (opts?.tsconfig !== false) {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: {} }, null, 2),
    );
  }
}

// ============================================================================
// parsePnpmWorkspaceYaml
// ============================================================================

describe("parsePnpmWorkspaceYaml", () => {
  it("should parse a standard pnpm-workspace.yaml", () => {
    const content = `packages:
  - "packages/*"
  - "examples"
`;
    const patterns = parsePnpmWorkspaceYaml(content);
    assert.deepStrictEqual(patterns, ["packages/*", "examples"]);
  });

  it("should handle unquoted values", () => {
    const content = `packages:
  - packages/*
  - examples
`;
    const patterns = parsePnpmWorkspaceYaml(content);
    assert.deepStrictEqual(patterns, ["packages/*", "examples"]);
  });

  it("should handle single-quoted values", () => {
    const content = `packages:
  - 'packages/*'
`;
    const patterns = parsePnpmWorkspaceYaml(content);
    assert.deepStrictEqual(patterns, ["packages/*"]);
  });

  it("should stop at the next top-level key", () => {
    const content = `packages:
  - "packages/*"
catalog:
  typescript: "^5.7.0"
`;
    const patterns = parsePnpmWorkspaceYaml(content);
    assert.deepStrictEqual(patterns, ["packages/*"]);
  });

  it("should return empty array when no packages key", () => {
    const content = `catalog:
  typescript: "^5.7.0"
`;
    const patterns = parsePnpmWorkspaceYaml(content);
    assert.deepStrictEqual(patterns, []);
  });

  it("should return empty array for empty content", () => {
    assert.deepStrictEqual(parsePnpmWorkspaceYaml(""), []);
  });

  it("should handle negation patterns (include them as-is)", () => {
    const content = `packages:
  - "packages/*"
  - "!packages/internal"
`;
    const patterns = parsePnpmWorkspaceYaml(content);
    assert.deepStrictEqual(patterns, ["packages/*", "!packages/internal"]);
  });
});

// ============================================================================
// expandWorkspaceGlobs
// ============================================================================

describe("expandWorkspaceGlobs", () => {
  let rootDir: string;

  before(() => {
    rootDir = createTmpDir("expand-globs");
    // Create: packages/acp/, packages/protocol/, packages/thinkwell/
    mkdirSync(join(rootDir, "packages/acp"), { recursive: true });
    mkdirSync(join(rootDir, "packages/protocol"), { recursive: true });
    mkdirSync(join(rootDir, "packages/thinkwell"), { recursive: true });
    // Create: examples/
    mkdirSync(join(rootDir, "examples"), { recursive: true });
    // Create a file (not a directory) — should be excluded
    writeFileSync(join(rootDir, "packages/README.md"), "# Packages");
  });

  after(() => {
    cleanup(rootDir);
  });

  it("should expand single-level wildcard", () => {
    const dirs = expandWorkspaceGlobs(rootDir, ["packages/*"]);
    assert.strictEqual(dirs.length, 3);
    const names = dirs.map((d) => d.split("/").pop()).sort();
    assert.deepStrictEqual(names, ["acp", "protocol", "thinkwell"]);
  });

  it("should expand literal directory paths", () => {
    const dirs = expandWorkspaceGlobs(rootDir, ["examples"]);
    assert.strictEqual(dirs.length, 1);
    assert.ok(dirs[0].endsWith("/examples"));
  });

  it("should combine multiple patterns", () => {
    const dirs = expandWorkspaceGlobs(rootDir, ["packages/*", "examples"]);
    assert.strictEqual(dirs.length, 4);
  });

  it("should skip non-existent base directories", () => {
    const dirs = expandWorkspaceGlobs(rootDir, ["nonexistent/*"]);
    assert.strictEqual(dirs.length, 0);
  });

  it("should skip negation patterns", () => {
    const dirs = expandWorkspaceGlobs(rootDir, ["!packages/acp"]);
    assert.strictEqual(dirs.length, 0);
  });
});

// ============================================================================
// detectWorkspace
// ============================================================================

describe("detectWorkspace", () => {
  describe("pnpm workspace", () => {
    let rootDir: string;

    before(() => {
      rootDir = createTmpDir("detect-pnpm");
      writeFileSync(
        join(rootDir, "pnpm-workspace.yaml"),
        `packages:\n  - "packages/*"\n`,
      );
      writeFileSync(
        join(rootDir, "package.json"),
        JSON.stringify({ name: "my-monorepo", private: true }),
      );
      createPackage(join(rootDir, "packages/foo"), "@myorg/foo");
      createPackage(join(rootDir, "packages/bar"), "@myorg/bar");
    });

    after(() => {
      cleanup(rootDir);
    });

    it("should detect pnpm workspace", () => {
      const ws = detectWorkspace(rootDir);
      assert.ok(ws, "Should detect workspace");
      assert.strictEqual(ws.type, "pnpm");
      assert.strictEqual(ws.members.length, 2);
    });

    it("should read package names", () => {
      const ws = detectWorkspace(rootDir)!;
      const names = ws.members.map((m) => m.name).sort();
      assert.deepStrictEqual(names, ["@myorg/bar", "@myorg/foo"]);
    });

    it("should detect tsconfig.json presence", () => {
      const ws = detectWorkspace(rootDir)!;
      for (const member of ws.members) {
        assert.strictEqual(member.hasTsConfig, true);
      }
    });
  });

  describe("npm workspace", () => {
    let rootDir: string;

    before(() => {
      rootDir = createTmpDir("detect-npm");
      writeFileSync(
        join(rootDir, "package.json"),
        JSON.stringify({
          name: "my-monorepo",
          private: true,
          workspaces: ["packages/*"],
        }),
      );
      createPackage(join(rootDir, "packages/alpha"), "alpha");
      createPackage(join(rootDir, "packages/beta"), "beta", { tsconfig: false });
    });

    after(() => {
      cleanup(rootDir);
    });

    it("should detect npm workspace", () => {
      const ws = detectWorkspace(rootDir);
      assert.ok(ws, "Should detect workspace");
      assert.strictEqual(ws.type, "npm");
      assert.strictEqual(ws.members.length, 2);
    });

    it("should detect missing tsconfig.json", () => {
      const ws = detectWorkspace(rootDir)!;
      const beta = ws.members.find((m) => m.name === "beta");
      assert.ok(beta);
      assert.strictEqual(beta.hasTsConfig, false);
    });
  });

  describe("pnpm takes precedence over npm", () => {
    let rootDir: string;

    before(() => {
      rootDir = createTmpDir("detect-precedence");
      writeFileSync(
        join(rootDir, "pnpm-workspace.yaml"),
        `packages:\n  - "packages/*"\n`,
      );
      writeFileSync(
        join(rootDir, "package.json"),
        JSON.stringify({
          name: "my-monorepo",
          private: true,
          workspaces: ["packages/*"],
        }),
      );
      createPackage(join(rootDir, "packages/only"), "only-pkg");
    });

    after(() => {
      cleanup(rootDir);
    });

    it("should prefer pnpm over npm workspaces", () => {
      const ws = detectWorkspace(rootDir);
      assert.ok(ws);
      assert.strictEqual(ws.type, "pnpm");
    });
  });

  describe("no workspace", () => {
    let rootDir: string;

    before(() => {
      rootDir = createTmpDir("detect-none");
      writeFileSync(
        join(rootDir, "package.json"),
        JSON.stringify({ name: "single-pkg", private: true }),
      );
    });

    after(() => {
      cleanup(rootDir);
    });

    it("should return undefined for non-workspace directory", () => {
      const ws = detectWorkspace(rootDir);
      assert.strictEqual(ws, undefined);
    });
  });

  describe("directories without package.json", () => {
    let rootDir: string;

    before(() => {
      rootDir = createTmpDir("detect-no-pkg");
      writeFileSync(
        join(rootDir, "pnpm-workspace.yaml"),
        `packages:\n  - "packages/*"\n`,
      );
      // Create a directory without package.json
      mkdirSync(join(rootDir, "packages/no-pkg"), { recursive: true });
      // Create a directory with package.json
      createPackage(join(rootDir, "packages/has-pkg"), "has-pkg");
    });

    after(() => {
      cleanup(rootDir);
    });

    it("should skip directories without package.json", () => {
      const ws = detectWorkspace(rootDir);
      assert.ok(ws);
      assert.strictEqual(ws.members.length, 1);
      assert.strictEqual(ws.members[0].name, "has-pkg");
    });
  });
});

// ============================================================================
// resolvePackageName
// ============================================================================

describe("resolvePackageName", () => {
  const members: WorkspaceMember[] = [
    { name: "@thinkwell/acp", dir: "/packages/acp", hasTsConfig: true },
    { name: "@thinkwell/protocol", dir: "/packages/protocol", hasTsConfig: true },
    { name: "thinkwell", dir: "/packages/thinkwell", hasTsConfig: true },
  ];

  it("should find exact match on full name", () => {
    const result = resolvePackageName("@thinkwell/acp", members);
    assert.strictEqual(result.kind, "found");
    if (result.kind === "found") {
      assert.strictEqual(result.member.name, "@thinkwell/acp");
    }
  });

  it("should find exact match on unscoped name", () => {
    const result = resolvePackageName("thinkwell", members);
    assert.strictEqual(result.kind, "found");
    if (result.kind === "found") {
      assert.strictEqual(result.member.name, "thinkwell");
    }
  });

  it("should resolve short name for scoped package", () => {
    const result = resolvePackageName("acp", members);
    assert.strictEqual(result.kind, "found");
    if (result.kind === "found") {
      assert.strictEqual(result.member.name, "@thinkwell/acp");
    }
  });

  it("should resolve short name 'protocol'", () => {
    const result = resolvePackageName("protocol", members);
    assert.strictEqual(result.kind, "found");
    if (result.kind === "found") {
      assert.strictEqual(result.member.name, "@thinkwell/protocol");
    }
  });

  it("should detect ambiguous short names", () => {
    const ambiguousMembers: WorkspaceMember[] = [
      { name: "@org-a/utils", dir: "/a/utils", hasTsConfig: true },
      { name: "@org-b/utils", dir: "/b/utils", hasTsConfig: true },
    ];
    const result = resolvePackageName("utils", ambiguousMembers);
    assert.strictEqual(result.kind, "ambiguous");
    if (result.kind === "ambiguous") {
      assert.strictEqual(result.matches.length, 2);
      assert.strictEqual(result.name, "utils");
    }
  });

  it("should report not found with available names", () => {
    const result = resolvePackageName("nonexistent", members);
    assert.strictEqual(result.kind, "not-found");
    if (result.kind === "not-found") {
      assert.strictEqual(result.name, "nonexistent");
      assert.deepStrictEqual(result.available, [
        "@thinkwell/acp",
        "@thinkwell/protocol",
        "thinkwell",
      ]);
    }
  });

  it("should prefer exact match over short-name match", () => {
    // "thinkwell" is both an exact match for the unscoped package
    // and could theoretically be a short-name match — exact should win
    const result = resolvePackageName("thinkwell", members);
    assert.strictEqual(result.kind, "found");
    if (result.kind === "found") {
      assert.strictEqual(result.member.name, "thinkwell");
      assert.strictEqual(result.member.dir, "/packages/thinkwell");
    }
  });
});
