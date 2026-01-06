import { describe, it } from "node:test";
import assert from "node:assert";
import { z } from "zod";
import {
  zodSchema,
  SummarySchema,
  SummaryZod,
  AnalysisResultSchema,
  ConfigSchema,
} from "./zod.js";

describe("Example 2: Zod adapter (zodSchema)", () => {
  describe("zodSchema adapter", () => {
    it("should convert simple Zod schema to JSON Schema", () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const provider = zodSchema(schema);
      const jsonSchema = provider.toJsonSchema();

      assert.strictEqual(jsonSchema.type, "object");
      assert.ok(jsonSchema.properties);
      assert.strictEqual(jsonSchema.properties.name.type, "string");
      assert.strictEqual(jsonSchema.properties.age.type, "number");
    });

    it("should cache the JSON Schema for repeated calls", () => {
      const schema = z.string();
      const provider = zodSchema(schema);

      const first = provider.toJsonSchema();
      const second = provider.toJsonSchema();

      assert.strictEqual(first, second);
    });

    it("should handle Zod enums", () => {
      const StatusSchema = z.enum(["pending", "active", "done"]);
      const provider = zodSchema(StatusSchema);
      const jsonSchema = provider.toJsonSchema();

      assert.ok(jsonSchema.enum);
      assert.deepStrictEqual(jsonSchema.enum, ["pending", "active", "done"]);
    });

    it("should handle Zod arrays", () => {
      const TagsSchema = z.array(z.string());
      const provider = zodSchema(TagsSchema);
      const jsonSchema = provider.toJsonSchema();

      assert.strictEqual(jsonSchema.type, "array");
      assert.strictEqual(jsonSchema.items?.type, "string");
    });

    it("should preserve descriptions", () => {
      const schema = z.object({
        name: z.string().describe("The user name"),
      });

      const provider = zodSchema(schema);
      const jsonSchema = provider.toJsonSchema();

      assert.strictEqual(
        jsonSchema.properties?.name.description,
        "The user name"
      );
    });
  });

  describe("SummarySchema", () => {
    it("should produce valid JSON Schema from Zod", () => {
      const schema = SummarySchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties);
    });

    it("should have correct property types", () => {
      const schema = SummarySchema.toJsonSchema();
      const props = schema.properties!;

      assert.strictEqual(props.title.type, "string");
      assert.strictEqual(props.points.type, "array");
      assert.strictEqual(props.wordCount.type, "integer");
    });

    it("should allow validation with original Zod schema", () => {
      const validData = {
        title: "Test Summary",
        points: ["point 1", "point 2"],
        wordCount: 100,
      };

      const result = SummaryZod.safeParse(validData);
      assert.ok(result.success);
    });

    it("should reject invalid data with Zod schema", () => {
      const invalidData = {
        title: "Test",
        points: "not an array",
        wordCount: -5,
      };

      const result = SummaryZod.safeParse(invalidData);
      assert.strictEqual(result.success, false);
    });
  });

  describe("AnalysisResultSchema", () => {
    it("should handle complex nested schemas", () => {
      const schema = AnalysisResultSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties?.sentiment.enum);
      assert.strictEqual(schema.properties?.topics.type, "array");
    });

    it("should include enum values for sentiment", () => {
      const schema = AnalysisResultSchema.toJsonSchema();

      assert.deepStrictEqual(schema.properties?.sentiment.enum, [
        "positive",
        "negative",
        "neutral",
      ]);
    });
  });

  describe("ConfigSchema with optionals", () => {
    it("should handle optional fields", () => {
      const schema = ConfigSchema.toJsonSchema();

      // Optional fields should not be in required array
      const required = schema.required as string[] | undefined;
      if (required) {
        assert.ok(!required.includes("maxTokens"));
        assert.ok(!required.includes("systemPrompt"));
      }
    });

    it("should include default values in schema", () => {
      const schema = ConfigSchema.toJsonSchema();

      assert.strictEqual(schema.properties?.temperature.default, 0.7);
    });
  });

  describe("Type inference", () => {
    it("should infer correct types from Zod schema", () => {
      // This is a compile-time check - if types don't match, TypeScript will error
      const testSchema = z.object({
        count: z.number(),
        items: z.array(z.string()),
      });

      type Expected = { count: number; items: string[] };
      type Inferred = z.infer<typeof testSchema>;

      // Type assertion to verify inference
      const _check: Inferred extends Expected
        ? Expected extends Inferred
          ? true
          : false
        : false = true;

      assert.ok(_check);
    });
  });
});
