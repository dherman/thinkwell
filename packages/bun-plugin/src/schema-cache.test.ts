import { describe, test, expect, beforeEach } from "bun:test";
import { SchemaCache } from "./schema-cache.js";
import type { TypeInfo } from "./transform.js";

describe("SchemaCache", () => {
  let cache: SchemaCache;

  beforeEach(() => {
    cache = new SchemaCache();
  });

  test("returns undefined for cache miss", () => {
    const result = cache.get("/path/to/file.ts", 1000);
    expect(result).toBeUndefined();
  });

  test("returns cached entry when mtime matches", () => {
    const types: TypeInfo[] = [{ name: "Test", node: {} as any }];
    const schemas = new Map<string, object>([["Test", { type: "string" }]]);

    cache.set("/path/to/file.ts", 1000, types, schemas);
    const result = cache.get("/path/to/file.ts", 1000);

    expect(result).toBeDefined();
    expect(result!.types).toEqual(types);
    expect(result!.schemas).toEqual(schemas);
  });

  test("returns undefined when mtime differs", () => {
    const types: TypeInfo[] = [{ name: "Test", node: {} as any }];
    const schemas = new Map<string, object>([["Test", { type: "string" }]]);

    cache.set("/path/to/file.ts", 1000, types, schemas);
    const result = cache.get("/path/to/file.ts", 2000);

    expect(result).toBeUndefined();
  });

  test("tracks cache size", () => {
    expect(cache.size).toBe(0);

    cache.set("/file1.ts", 1000, [], new Map());
    expect(cache.size).toBe(1);

    cache.set("/file2.ts", 1000, [], new Map());
    expect(cache.size).toBe(2);
  });

  test("updates existing entry", () => {
    const types1: TypeInfo[] = [{ name: "Old", node: {} as any }];
    const types2: TypeInfo[] = [{ name: "New", node: {} as any }];
    const schemas1 = new Map<string, object>([["Old", { type: "string" }]]);
    const schemas2 = new Map<string, object>([["New", { type: "number" }]]);

    cache.set("/file.ts", 1000, types1, schemas1);
    cache.set("/file.ts", 2000, types2, schemas2);

    expect(cache.size).toBe(1);
    const result = cache.get("/file.ts", 2000);
    expect(result!.types[0].name).toBe("New");
  });

  test("clears all entries", () => {
    cache.set("/file1.ts", 1000, [], new Map());
    cache.set("/file2.ts", 1000, [], new Map());
    expect(cache.size).toBe(2);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("/file1.ts", 1000)).toBeUndefined();
  });
});
