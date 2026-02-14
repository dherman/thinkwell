import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateVirtualDeclarations } from "./virtual-declarations";
import type { MarkedType } from "./scanner";

describe("generateVirtualDeclarations", () => {
  it("generates empty content for no types", () => {
    const result = generateVirtualDeclarations(new Map());
    assert.strictEqual(result, "");
  });

  it("generates a namespace declaration for a single type", () => {
    const types = new Map<string, MarkedType[]>([
      ["src/types.ts", [{ name: "Greeting", isExported: false }]],
    ]);
    const result = generateVirtualDeclarations(types);
    assert.ok(result.includes('declare namespace Greeting {'));
    assert.ok(result.includes('SchemaProvider<Greeting>'));
    assert.ok(!result.includes("export declare namespace"));
  });

  it("uses ambient namespace (no export) even for exported types", () => {
    const types = new Map<string, MarkedType[]>([
      ["src/types.ts", [{ name: "Greeting", isExported: true }]],
    ]);
    const result = generateVirtualDeclarations(types);
    assert.ok(result.includes("declare namespace Greeting {"));
    assert.ok(!result.includes("export declare namespace"));
  });

  it("generates declarations for multiple types across files", () => {
    const types = new Map<string, MarkedType[]>([
      ["src/types.ts", [
        { name: "Greeting", isExported: true },
        { name: "Farewell", isExported: true },
      ]],
      ["src/models.ts", [
        { name: "Sentiment", isExported: false },
      ]],
    ]);
    const result = generateVirtualDeclarations(types);
    assert.ok(result.includes("declare namespace Greeting"));
    assert.ok(result.includes("declare namespace Farewell"));
    assert.ok(result.includes("declare namespace Sentiment"));
    assert.ok(result.includes("// From src/types.ts"));
    assert.ok(result.includes("// From src/models.ts"));
  });

  it("skips files with empty type arrays", () => {
    const types = new Map<string, MarkedType[]>([
      ["src/empty.ts", []],
      ["src/types.ts", [{ name: "Greeting", isExported: true }]],
    ]);
    const result = generateVirtualDeclarations(types);
    assert.ok(!result.includes("src/empty.ts"));
    assert.ok(result.includes("src/types.ts"));
  });
});
