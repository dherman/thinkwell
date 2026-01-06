import { describe, it } from "node:test";
import assert from "node:assert";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  typeboxSchema,
  SummarySchema,
  SummaryTypeBox,
  AnalysisResultSchema,
  ConfigSchema,
  UserProfileSchema,
} from "./typebox.js";

describe("Example 3: TypeBox adapter (typeboxSchema)", () => {
  describe("typeboxSchema adapter", () => {
    it("should convert TypeBox schema to JSON Schema", () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number(),
      });

      const provider = typeboxSchema(schema);
      const jsonSchema = provider.toJsonSchema();

      assert.strictEqual(jsonSchema.type, "object");
      assert.ok(jsonSchema.properties);
      assert.strictEqual(jsonSchema.properties.name.type, "string");
      assert.strictEqual(jsonSchema.properties.age.type, "number");
    });

    it("should return same schema reference on multiple calls", () => {
      const schema = Type.String();
      const provider = typeboxSchema(schema);

      const first = provider.toJsonSchema();
      const second = provider.toJsonSchema();

      // TypeBox schemas are the same reference
      assert.strictEqual(first, second);
    });

    it("should handle TypeBox literals/unions", () => {
      const StatusSchema = Type.Union([
        Type.Literal("pending"),
        Type.Literal("active"),
        Type.Literal("done"),
      ]);

      const provider = typeboxSchema(StatusSchema);
      const jsonSchema = provider.toJsonSchema();

      // TypeBox uses anyOf for unions
      assert.ok(jsonSchema.anyOf);
    });

    it("should handle TypeBox arrays", () => {
      const TagsSchema = Type.Array(Type.String());
      const provider = typeboxSchema(TagsSchema);
      const jsonSchema = provider.toJsonSchema();

      assert.strictEqual(jsonSchema.type, "array");
      assert.strictEqual(jsonSchema.items?.type, "string");
    });

    it("should preserve descriptions", () => {
      const schema = Type.Object({
        name: Type.String({ description: "The user name" }),
      });

      const provider = typeboxSchema(schema);
      const jsonSchema = provider.toJsonSchema();

      assert.strictEqual(
        jsonSchema.properties?.name.description,
        "The user name"
      );
    });
  });

  describe("SummarySchema", () => {
    it("should produce valid JSON Schema from TypeBox", () => {
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

    it("should allow validation with TypeBox Value module", () => {
      const validData = {
        title: "Test Summary",
        points: ["point 1", "point 2"],
        wordCount: 100,
      };

      const isValid = Value.Check(SummaryTypeBox, validData);
      assert.ok(isValid);
    });

    it("should reject invalid data with TypeBox Value module", () => {
      const invalidData = {
        title: "Test",
        points: "not an array",
        wordCount: -5,
      };

      const isValid = Value.Check(SummaryTypeBox, invalidData);
      assert.strictEqual(isValid, false);
    });
  });

  describe("AnalysisResultSchema", () => {
    it("should handle complex nested schemas", () => {
      const schema = AnalysisResultSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties?.sentiment);
      assert.strictEqual(schema.properties?.topics.type, "array");
    });

    it("should use anyOf for union types", () => {
      const schema = AnalysisResultSchema.toJsonSchema();

      // TypeBox represents unions with anyOf
      assert.ok(schema.properties?.sentiment.anyOf);
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

  describe("UserProfileSchema with formats", () => {
    it("should include format specifications", () => {
      const schema = UserProfileSchema.toJsonSchema();

      assert.strictEqual(schema.properties?.id.format, "uuid");
      assert.strictEqual(schema.properties?.email.format, "email");
      assert.strictEqual(schema.properties?.createdAt.format, "date-time");
    });
  });

  describe("Type inference", () => {
    it("should infer correct types from TypeBox schema", () => {
      // This is a compile-time check - if types don't match, TypeScript will error
      const testSchema = Type.Object({
        count: Type.Number(),
        items: Type.Array(Type.String()),
      });

      type Expected = { count: number; items: string[] };
      type Inferred = Static<typeof testSchema>;

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
