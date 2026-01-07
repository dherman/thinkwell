import { describe, it } from "node:test";
import assert from "node:assert";
import { SummarySchema, AnalysisResultSchema } from "./inline.js";

describe("Example 1: Inline schema with schemaOf<T>()", () => {
  describe("SummarySchema", () => {
    it("should produce valid JSON Schema", () => {
      const schema = SummarySchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties);
      assert.deepStrictEqual(schema.required, ["title", "points", "wordCount"]);
    });

    it("should have correct property types", () => {
      const schema = SummarySchema.toJsonSchema();
      const props = schema.properties!;

      assert.strictEqual(props.title.type, "string");
      assert.strictEqual(props.points.type, "array");
      assert.strictEqual(props.points.items?.type, "string");
      assert.strictEqual(props.wordCount.type, "number");
    });

    it("should include descriptions", () => {
      const schema = SummarySchema.toJsonSchema();
      const props = schema.properties!;

      assert.ok(props.title.description);
      assert.ok(props.points.description);
      assert.ok(props.wordCount.description);
    });
  });

  describe("AnalysisResultSchema", () => {
    it("should produce valid JSON Schema with enum", () => {
      const schema = AnalysisResultSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.deepStrictEqual(schema.properties?.sentiment.enum, [
        "positive",
        "negative",
        "neutral",
      ]);
    });

    it("should have nested object schema for topics", () => {
      const schema = AnalysisResultSchema.toJsonSchema();
      const topicsSchema = schema.properties?.topics;

      assert.strictEqual(topicsSchema?.type, "array");
      assert.strictEqual(topicsSchema?.items?.type, "object");
      assert.deepStrictEqual(topicsSchema?.items?.required, [
        "name",
        "relevance",
      ]);
    });

    it("should include numeric constraints", () => {
      const schema = AnalysisResultSchema.toJsonSchema();

      assert.strictEqual(schema.properties?.confidence.minimum, 0);
      assert.strictEqual(schema.properties?.confidence.maximum, 1);
    });
  });

  describe("Type inference", () => {
    it("should return same schema reference on multiple calls", () => {
      const first = SummarySchema.toJsonSchema();
      const second = SummarySchema.toJsonSchema();

      assert.strictEqual(first, second);
    });
  });
});
