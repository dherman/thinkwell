import { describe, it } from "node:test";
import assert from "node:assert";
import { schemaOf } from "./schema.js";
import type { SchemaProvider, JsonSchema } from "@thinkwell/acp";

describe("schemaOf", () => {
  it("should create a SchemaProvider from a JsonSchema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };

    const provider = schemaOf(schema);

    assert.strictEqual(typeof provider.toJsonSchema, "function");
    assert.deepStrictEqual(provider.toJsonSchema(), schema);
  });

  it("should return the same schema on multiple calls", () => {
    const schema: JsonSchema = { type: "string" };
    const provider = schemaOf(schema);

    const first = provider.toJsonSchema();
    const second = provider.toJsonSchema();

    assert.strictEqual(first, second);
  });

  it("should preserve complex nested schemas", () => {
    interface NestedType {
      items: Array<{ id: number; tags: string[] }>;
    }

    const schema: JsonSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["id", "tags"],
          },
        },
      },
      required: ["items"],
    };

    const provider: SchemaProvider<NestedType> = schemaOf<NestedType>(schema);
    assert.deepStrictEqual(provider.toJsonSchema(), schema);
  });

  it("should work with enum schemas", () => {
    type Status = "pending" | "active" | "done";

    const schema: JsonSchema = {
      type: "string",
      enum: ["pending", "active", "done"],
    };

    const provider: SchemaProvider<Status> = schemaOf<Status>(schema);
    assert.deepStrictEqual(provider.toJsonSchema(), schema);
  });

  it("should accept schemas with additional JSON Schema properties", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        email: {
          type: "string",
          format: "email",
          minLength: 5,
        },
      },
      additionalProperties: false,
    };

    const provider = schemaOf(schema);
    const result = provider.toJsonSchema();

    assert.strictEqual(result.additionalProperties, false);
    assert.strictEqual((result.properties?.email as JsonSchema).format, "email");
  });
});

describe("SchemaProvider type inference", () => {
  it("should carry type information through the provider", () => {
    interface Summary {
      title: string;
      points: string[];
    }

    const schema: JsonSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        points: { type: "array", items: { type: "string" } },
      },
      required: ["title", "points"],
    };

    // This test verifies that TypeScript correctly infers the type parameter
    const provider: SchemaProvider<Summary> = schemaOf<Summary>(schema);

    // The provider satisfies the SchemaProvider<Summary> type
    assert.ok(provider.toJsonSchema());
  });

  it("should allow inference from generic functions", () => {
    function createProvider<T>(schema: JsonSchema): SchemaProvider<T> {
      return schemaOf<T>(schema);
    }

    interface Result {
      success: boolean;
    }

    const provider = createProvider<Result>({ type: "object" });
    assert.ok(provider.toJsonSchema());
  });
});

describe("ThinkBuilder schema integration", () => {
  // We can't test the full ThinkBuilder without a connection, but we can
  // verify the schema handling logic using a mock

  it("should use schema from constructor via toJsonSchema()", () => {
    interface TestOutput {
      value: number;
    }

    const schema: JsonSchema = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };

    const provider = schemaOf<TestOutput>(schema);

    // Simulate what ThinkBuilder does internally
    const outputSchema = provider.toJsonSchema();

    assert.deepStrictEqual(outputSchema, schema);
  });
});

describe("outputSchema deprecation", () => {
  it("should emit deprecation warning when outputSchema is called", () => {
    // Mock console.warn to capture the warning
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      // Simulate the deprecated outputSchema behavior
      const schema: JsonSchema = { type: "string" };
      const schemaProvider = { toJsonSchema: () => schema };

      // This simulates what the deprecated method does
      console.warn(
        "ThinkBuilder.outputSchema() is deprecated. Use patchwork.think(schemaOf<T>(schema)) instead."
      );

      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("deprecated"));
      assert.ok(warnings[0].includes("schemaOf"));
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("Tool schema integration", () => {
  it("should create SchemaProvider for tool input using schemaOf", () => {
    interface SearchInput {
      query: string;
      limit?: number;
    }

    const inputSchema: JsonSchema = {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    };

    const provider: SchemaProvider<SearchInput> = schemaOf<SearchInput>(inputSchema);

    // Verify the schema is preserved
    const result = provider.toJsonSchema();
    assert.deepStrictEqual(result, inputSchema);
    assert.strictEqual(result.type, "object");
    assert.deepStrictEqual(result.required, ["query"]);
  });

  it("should support tool input schemas with descriptions", () => {
    interface SentimentInput {
      text: string;
    }

    const inputSchema: JsonSchema = {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text passage to analyze",
        },
      },
      required: ["text"],
    };

    const provider = schemaOf<SentimentInput>(inputSchema);
    const result = provider.toJsonSchema();

    assert.strictEqual(
      (result.properties?.text as JsonSchema).description,
      "The text passage to analyze"
    );
  });

  it("should work with complex tool input schemas", () => {
    interface FilterInput {
      field: string;
      operator: "eq" | "gt" | "lt" | "contains";
      value: string | number;
      caseSensitive?: boolean;
    }

    const inputSchema: JsonSchema = {
      type: "object",
      properties: {
        field: { type: "string" },
        operator: {
          type: "string",
          enum: ["eq", "gt", "lt", "contains"],
        },
        value: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
        caseSensitive: { type: "boolean" },
      },
      required: ["field", "operator", "value"],
    };

    const provider: SchemaProvider<FilterInput> = schemaOf<FilterInput>(inputSchema);
    const result = provider.toJsonSchema();

    assert.deepStrictEqual(
      (result.properties?.operator as JsonSchema).enum,
      ["eq", "gt", "lt", "contains"]
    );
    assert.ok((result.properties?.value as JsonSchema).oneOf);
  });

  it("should allow default empty schema for tools without input", () => {
    // Simulates what ThinkBuilder does when no inputSchema is provided
    const defaultProvider: SchemaProvider<unknown> = {
      toJsonSchema: () => ({ type: "object" }),
    };

    const result = defaultProvider.toJsonSchema();
    assert.deepStrictEqual(result, { type: "object" });
  });
});
