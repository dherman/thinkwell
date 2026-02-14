import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import {
  isStandaloneScript,
  resolveModulePath,
  type ThinkwellInstallation,
} from "./standalone-resolver";

/**
 * Create a minimal LanguageServiceHost with in-memory files for testing
 * isStandaloneScript.
 */
function createMockHost(
  files: Record<string, string>,
): ts.LanguageServiceHost {
  return {
    getCompilationSettings: () => ({}),
    getScriptFileNames: () => Object.keys(files),
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      const content = files[fileName];
      if (content !== undefined) {
        return ts.ScriptSnapshot.fromString(content);
      }
      return undefined;
    },
    getCurrentDirectory: () => "/test",
    getDefaultLibFileName: () => "",
  };
}

describe("isStandaloneScript", () => {
  it("returns true for #!/usr/bin/env thinkwell shebang", () => {
    const host = createMockHost({
      "/test/script.ts": '#!/usr/bin/env thinkwell\nimport { open } from "thinkwell";',
    });
    assert.ok(isStandaloneScript("/test/script.ts", host));
  });

  it("returns true for shebang with flags", () => {
    const host = createMockHost({
      "/test/script.ts": "#!/usr/bin/env -S thinkwell --verbose\nconsole.log('hi');",
    });
    assert.ok(isStandaloneScript("/test/script.ts", host));
  });

  it("returns false for files without shebang", () => {
    const host = createMockHost({
      "/test/module.ts": 'import { open } from "thinkwell";\nconsole.log("hi");',
    });
    assert.ok(!isStandaloneScript("/test/module.ts", host));
  });

  it("returns false for different shebang", () => {
    const host = createMockHost({
      "/test/script.ts": "#!/usr/bin/env node\nconsole.log('hi');",
    });
    assert.ok(!isStandaloneScript("/test/script.ts", host));
  });

  it("returns false for nonexistent files", () => {
    const host = createMockHost({});
    assert.ok(!isStandaloneScript("/test/missing.ts", host));
  });
});

describe("resolveModulePath", () => {
  const tmpDir = path.join(
    process.env.TMPDIR ?? "/tmp",
    "thinkwell-resolver-test-" + Date.now(),
  );

  let installation: ThinkwellInstallation;

  before(() => {
    const packageRoot = path.join(tmpDir, "node_modules/thinkwell");
    const nodeModulesDir = path.join(tmpDir, "node_modules");

    installation = { packageRoot, nodeModulesDir };

    // Create fake thinkwell package
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "thinkwell", types: "./dist/index.d.ts" }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist/index.d.ts"),
      "export declare function open(): void;",
    );

    // Create @thinkwell/acp with exports field
    const acpDir = path.join(nodeModulesDir, "@thinkwell/acp");
    fs.mkdirSync(path.join(acpDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(acpDir, "package.json"),
      JSON.stringify({
        name: "@thinkwell/acp",
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
    );
    fs.writeFileSync(
      path.join(acpDir, "dist/index.d.ts"),
      "export declare const ACP: string;",
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves 'thinkwell' to its types entry point", () => {
    const result = resolveModulePath("thinkwell", installation);
    assert.ok(result, "Should resolve thinkwell");
    assert.ok(result.endsWith("dist/index.d.ts"));
  });

  it("resolves '@thinkwell/acp' via exports['.'].types", () => {
    const result = resolveModulePath("@thinkwell/acp", installation);
    assert.ok(result, "Should resolve @thinkwell/acp");
    assert.ok(result.endsWith("dist/index.d.ts"));
  });

  it("returns null for uninstalled packages", () => {
    const result = resolveModulePath("@thinkwell/protocol", installation);
    assert.equal(result, null);
  });
});
