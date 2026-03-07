import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import {
  isStandaloneScript,
  getVirtualTypeContent,
  virtualTypePath,
  VIRTUAL_TYPES_PREFIX,
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

describe("virtualTypePath", () => {
  it("constructs virtual paths for thinkwell modules", () => {
    assert.equal(
      virtualTypePath("thinkwell", "index.d.ts"),
      `${VIRTUAL_TYPES_PREFIX}/thinkwell/index.d.ts`,
    );
  });

  it("constructs virtual paths for scoped modules", () => {
    assert.equal(
      virtualTypePath("@thinkwell/acp", "index.d.ts"),
      `${VIRTUAL_TYPES_PREFIX}/@thinkwell/acp/index.d.ts`,
    );
  });

  it("constructs virtual paths for nested files", () => {
    assert.equal(
      virtualTypePath("thinkwell", "agent.d.ts"),
      `${VIRTUAL_TYPES_PREFIX}/thinkwell/agent.d.ts`,
    );
  });
});

describe("getVirtualTypeContent", () => {
  it("returns content for bundled thinkwell index.d.ts", () => {
    const content = getVirtualTypeContent(
      `${VIRTUAL_TYPES_PREFIX}/thinkwell/index.d.ts`,
    );
    assert.ok(content, "should return content for thinkwell/index.d.ts");
    assert.ok(content.includes("export"), "should contain exports");
  });

  it("returns content for bundled @thinkwell/acp index.d.ts", () => {
    const content = getVirtualTypeContent(
      `${VIRTUAL_TYPES_PREFIX}/@thinkwell/acp/index.d.ts`,
    );
    assert.ok(content, "should return content for @thinkwell/acp/index.d.ts");
  });

  it("returns content for bundled @thinkwell/protocol index.d.ts", () => {
    const content = getVirtualTypeContent(
      `${VIRTUAL_TYPES_PREFIX}/@thinkwell/protocol/index.d.ts`,
    );
    assert.ok(content, "should return content for @thinkwell/protocol/index.d.ts");
  });

  it("returns content for non-index bundled files", () => {
    // The thinkwell package should have agent.d.ts
    const content = getVirtualTypeContent(
      `${VIRTUAL_TYPES_PREFIX}/thinkwell/agent.d.ts`,
    );
    assert.ok(content, "should return content for thinkwell/agent.d.ts");
  });

  it("returns undefined for nonexistent virtual files", () => {
    const content = getVirtualTypeContent(
      `${VIRTUAL_TYPES_PREFIX}/thinkwell/nonexistent.d.ts`,
    );
    assert.equal(content, undefined);
  });

  it("returns undefined for non-virtual paths", () => {
    assert.equal(getVirtualTypeContent("/real/path/index.d.ts"), undefined);
  });

  it("returns undefined for unknown modules", () => {
    const content = getVirtualTypeContent(
      `${VIRTUAL_TYPES_PREFIX}/unknown-module/index.d.ts`,
    );
    assert.equal(content, undefined);
  });
});
