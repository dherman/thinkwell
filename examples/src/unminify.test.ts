import { describe, it } from "node:test";
import assert from "node:assert";
import * as fs from "fs/promises";
import {
  ModuleConversionSchema,
  FunctionListSchema,
  FunctionAnalysisSchema,
  FunctionAnalysisBatchSchema,
  RenamedCodeSchema,
  formatCode,
} from "./unminify.js";

describe("Unminify Demo", () => {
  describe("ModuleConversionSchema", () => {
    it("should produce valid JSON Schema", () => {
      const schema = ModuleConversionSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties);
      assert.deepStrictEqual(schema.required, ["code", "exportedName"]);
    });

    it("should have correct property types", () => {
      const schema = ModuleConversionSchema.toJsonSchema();
      const props = schema.properties!;

      assert.strictEqual(props.code.type, "string");
      assert.strictEqual(props.exportedName.type, "string");
    });
  });

  describe("FunctionListSchema", () => {
    it("should produce valid JSON Schema", () => {
      const schema = FunctionListSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties);
      assert.deepStrictEqual(schema.required, ["functions"]);
    });

    it("should have array of function info objects", () => {
      const schema = FunctionListSchema.toJsonSchema();
      const functionsSchema = schema.properties?.functions;

      assert.strictEqual(functionsSchema?.type, "array");
      assert.strictEqual(functionsSchema?.items?.type, "object");
      assert.deepStrictEqual(functionsSchema?.items?.required, [
        "name",
        "signature",
        "lineNumber",
      ]);
    });
  });

  describe("FunctionAnalysisSchema", () => {
    it("should produce valid JSON Schema", () => {
      const schema = FunctionAnalysisSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties);
      assert.deepStrictEqual(schema.required, [
        "originalName",
        "suggestedName",
        "purpose",
        "confidence",
      ]);
    });

    it("should have enum for confidence level", () => {
      const schema = FunctionAnalysisSchema.toJsonSchema();
      const confidenceSchema = schema.properties?.confidence;

      assert.deepStrictEqual(confidenceSchema?.enum, ["high", "medium", "low"]);
    });
  });

  describe("FunctionAnalysisBatchSchema", () => {
    it("should produce valid JSON Schema", () => {
      const schema = FunctionAnalysisBatchSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties);
      assert.deepStrictEqual(schema.required, ["analyses"]);
    });

    it("should have array of analysis objects", () => {
      const schema = FunctionAnalysisBatchSchema.toJsonSchema();
      const analysesSchema = schema.properties?.analyses;

      assert.strictEqual(analysesSchema?.type, "array");
      assert.strictEqual(analysesSchema?.items?.type, "object");
      assert.deepStrictEqual(analysesSchema?.items?.required, [
        "originalName",
        "suggestedName",
        "purpose",
        "confidence",
      ]);
    });

    it("should have enum for confidence level in items", () => {
      const schema = FunctionAnalysisBatchSchema.toJsonSchema();
      const confidenceSchema = schema.properties?.analyses?.items?.properties?.confidence;

      assert.deepStrictEqual(confidenceSchema?.enum, ["high", "medium", "low"]);
    });
  });

  describe("RenamedCodeSchema", () => {
    it("should produce valid JSON Schema", () => {
      const schema = RenamedCodeSchema.toJsonSchema();

      assert.strictEqual(schema.type, "object");
      assert.ok(schema.properties);
      assert.deepStrictEqual(schema.required, ["code", "renameCount"]);
    });

    it("should have correct property types", () => {
      const schema = RenamedCodeSchema.toJsonSchema();
      const props = schema.properties!;

      assert.strictEqual(props.code.type, "string");
      assert.strictEqual(props.renameCount.type, "number");
    });
  });

  describe("formatCode", () => {
    it("should format minified JavaScript", async () => {
      const minified = 'function foo(a,b){return a+b}';
      const formatted = await formatCode(minified);

      assert.ok(formatted.includes("\n"));
      assert.ok(formatted.includes("function foo"));
      assert.ok(formatted.includes("return a + b"));
    });

    it("should handle complex expressions", async () => {
      const minified = 'var x=function(n){return n>0?n:-n};';
      const formatted = await formatCode(minified);

      assert.ok(formatted.includes("\n"));
      assert.ok(formatted.includes("function"));
    });
  });

  describe("Input file", () => {
    it("should have underscore-umd-min.js available", async () => {
      const inputPath = new URL("../data/underscore-umd-min.js", import.meta.url);
      const content = await fs.readFile(inputPath, "utf-8");

      assert.ok(content.length > 0);
      assert.ok(content.includes("Underscore.js"));
      assert.ok(content.includes("1.13.7"));
    });
  });
});
