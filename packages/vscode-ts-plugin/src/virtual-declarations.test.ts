import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateVirtualDeclarations } from "./virtual-declarations";
import type { MarkedType } from "./scanner";

/**
 * Augmentations file path used consistently across tests.
 * Uses a cache-dir-style path (outside the project tree) to match
 * the real plugin behavior.
 */
const AUGMENTATIONS_PATH = "/cache/thinkwell-plugin/abc123/augmentations.d.ts";

describe("generateVirtualDeclarations", () => {
  it("generates empty content for no types", () => {
    const result = generateVirtualDeclarations(new Map(), AUGMENTATIONS_PATH);
    assert.strictEqual(result, "");
  });

  it("generates a namespace declaration with import() type reference", () => {
    const types = new Map<string, MarkedType[]>([
      ["/project/src/types.ts", [{ name: "Greeting", isExported: false }]],
    ]);
    const result = generateVirtualDeclarations(types, AUGMENTATIONS_PATH);
    assert.ok(result.includes('declare namespace Greeting {'));
    // Relative path traverses from cache dir up to project source
    assert.ok(result.includes('import("../../../project/src/types.js").Greeting'));
    assert.ok(result.includes('import("thinkwell").SchemaProvider'));
    assert.ok(!result.includes("export declare namespace"));
  });

  it("uses ambient namespace (no export) even for exported types", () => {
    const types = new Map<string, MarkedType[]>([
      ["/project/src/types.ts", [{ name: "Greeting", isExported: true }]],
    ]);
    const result = generateVirtualDeclarations(types, AUGMENTATIONS_PATH);
    assert.ok(result.includes("declare namespace Greeting {"));
    assert.ok(!result.includes("export declare namespace"));
  });

  it("generates declarations for multiple types across files", () => {
    const types = new Map<string, MarkedType[]>([
      ["/project/src/types.ts", [
        { name: "Greeting", isExported: true },
        { name: "Farewell", isExported: true },
      ]],
      ["/project/src/models.ts", [
        { name: "Sentiment", isExported: false },
      ]],
    ]);
    const result = generateVirtualDeclarations(types, AUGMENTATIONS_PATH);
    assert.ok(result.includes("declare namespace Greeting"));
    assert.ok(result.includes("declare namespace Farewell"));
    assert.ok(result.includes("declare namespace Sentiment"));
    assert.ok(result.includes('import("../../../project/src/types.js").Greeting'));
    assert.ok(result.includes('import("../../../project/src/types.js").Farewell'));
    assert.ok(result.includes('import("../../../project/src/models.js").Sentiment'));
    assert.ok(result.includes("// From /project/src/types.ts"));
    assert.ok(result.includes("// From /project/src/models.ts"));
  });

  it("skips files with empty type arrays", () => {
    const types = new Map<string, MarkedType[]>([
      ["/project/src/empty.ts", []],
      ["/project/src/types.ts", [{ name: "Greeting", isExported: true }]],
    ]);
    const result = generateVirtualDeclarations(types, AUGMENTATIONS_PATH);
    assert.ok(!result.includes("src/empty.ts"));
    assert.ok(result.includes("/project/src/types.ts"));
  });
});
