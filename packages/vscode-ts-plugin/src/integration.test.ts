import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTestProject, type TestProject } from "./test-harness";

/**
 * Error codes produced when accessing .Schema on a type without a namespace merge:
 * - 2693: "only refers to a type, but is being used as a value here" (interface has no value)
 * - 2339: "Property 'Schema' does not exist on type 'typeof X'" (class/enum has a value but no Schema)
 */
const SCHEMA_ERROR_CODES = new Set([2339, 2693]);

/** Standard test files for a project with @JSONSchema types. */
function standardFiles() {
  return {
    "src/types.ts": [
      '/** @JSONSchema */',
      'export interface Greeting {',
      '  message: string;',
      '}',
      '',
      'export interface Unrelated {',
      '  value: number;',
      '}',
    ].join("\n"),

    "src/main.ts": [
      'import { Greeting, Unrelated } from "./types";',
      '',
      'const schema = Greeting.Schema;',
      'const bad = Unrelated.Schema;',
    ].join("\n"),
  };
}

describe("integration: @JSONSchema augmentations", () => {
  let project: TestProject;

  afterEach(() => {
    project?.cleanup();
  });

  describe("completions", () => {
    it("provides Schema completion on @JSONSchema-marked interface", async () => {
      project = createTestProject(standardFiles());
      await project.waitForInitialScan();

      // Trigger initial scan via diagnostics before requesting completions
      project.getDiagnostics("src/main.ts");

      const completions = project.getCompletionsAt("src/main.ts", "Greeting.");

      assert.ok(completions, "Should return completions");
      const names = completions.entries.map((e) => e.name);
      assert.ok(names.includes("Schema"), `Expected "Schema" in completions, got: ${names.join(", ")}`);
    });

    it("does not provide Schema completion on unmarked interface", async () => {
      project = createTestProject(standardFiles());
      await project.waitForInitialScan();

      // Trigger initial scan via diagnostics before requesting completions
      project.getDiagnostics("src/main.ts");

      const completions = project.getCompletionsAt("src/main.ts", "Unrelated.");

      // Unrelated has no @JSONSchema marker, so Schema should not appear
      if (completions) {
        const names = completions.entries.map((e) => e.name);
        assert.ok(!names.includes("Schema"), `"Schema" should not appear for unmarked types`);
      }
    });

    it("provides Schema completion on @JSONSchema-marked type alias", async () => {
      const files = {
        "src/config.ts": [
          '/** @JSONSchema */',
          'export type Config = {',
          '  host: string;',
          '  port: number;',
          '};',
        ].join("\n"),
        "src/use-config.ts": [
          'import { Config } from "./config";',
          '',
          'const schema = Config.Schema;',
        ].join("\n"),
      };

      project = createTestProject(files);
      await project.waitForInitialScan();

      // Trigger initial scan via diagnostics before requesting completions
      project.getDiagnostics("src/use-config.ts");

      const completions = project.getCompletionsAt("src/use-config.ts", "Config.");

      assert.ok(completions, "Should return completions");
      const names = completions.entries.map((e) => e.name);
      assert.ok(names.includes("Schema"), `Expected "Schema" in completions, got: ${names.join(", ")}`);
    });
  });

  describe("diagnostics", () => {
    it("produces no errors for Greeting.Schema on a marked type", async () => {
      project = createTestProject(standardFiles());
      await project.waitForInitialScan();

      const diagnostics = project.getDiagnostics("src/main.ts");

      const greetingErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Greeting");
      });
      assert.equal(greetingErrors.length, 0, "Should have no errors for @JSONSchema-marked Greeting");
    });

    it("produces errors for Unrelated.Schema on an unmarked type", async () => {
      project = createTestProject(standardFiles());
      await project.waitForInitialScan();

      const diagnostics = project.getDiagnostics("src/main.ts");

      const unrelatedErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Unrelated") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.ok(unrelatedErrors.length > 0, "Should report error for Unrelated.Schema");
    });

    it("reports no semantic errors for correct usage of Greeting.Schema", async () => {
      const files = {
        "src/types.ts": [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        "src/main.ts": [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      project = createTestProject(files);
      await project.waitForInitialScan();

      const diagnostics = project.getDiagnostics("src/main.ts");

      const relevantErrors = diagnostics.filter((d) => SCHEMA_ERROR_CODES.has(d.code));
      assert.equal(
        relevantErrors.length, 0,
        `Expected no schema-related errors, got: ${relevantErrors.map(d => `[${d.code}] ${typeof d.messageText === "string" ? d.messageText : d.messageText.messageText}`).join("; ")}`,
      );
    });
  });

  describe("hover", () => {
    it("shows SchemaProvider type info on hover over Greeting.Schema", async () => {
      const files = {
        "src/types.ts": [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        "src/main.ts": [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      project = createTestProject(files);
      await project.waitForInitialScan();

      // Trigger initial scan via diagnostics before requesting hover
      project.getDiagnostics("src/main.ts");

      const mainFile = path.join(project.projectDir, "src/main.ts");
      // Hover over "Schema" in "Greeting.Schema"
      const hoverPos = project.findPosition("src/main.ts", "Greeting.Schema") + "Greeting.".length;
      const info = project.ls.getQuickInfoAtPosition(mainFile, hoverPos);

      assert.ok(info, "Should return hover info for Schema");
      const displayText = info.displayParts?.map((p) => p.text).join("") ?? "";
      assert.ok(
        displayText.includes("SchemaProvider"),
        `Expected hover to mention SchemaProvider, got: ${displayText}`,
      );
    });
  });

  describe("incremental updates", () => {
    it("adds Schema support when @JSONSchema marker is added", async () => {
      // Start with NO @JSONSchema marker
      const files = {
        "src/types.ts": [
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        "src/main.ts": [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      project = createTestProject(files);
      await project.waitForInitialScan();

      // Before: Greeting.Schema should produce an error (2693 for interface without value)
      let diagnostics = project.getDiagnostics("src/main.ts");
      let schemaErrors = diagnostics.filter((d) => SCHEMA_ERROR_CODES.has(d.code));
      assert.ok(schemaErrors.length > 0, "Should error before adding @JSONSchema");

      // Add the @JSONSchema marker
      project.updateFile("src/types.ts", [
        '/** @JSONSchema */',
        'export interface Greeting {',
        '  message: string;',
        '}',
      ].join("\n"));

      // Trigger rescan by requesting diagnostics on the types file first
      project.getDiagnostics("src/types.ts");

      // After: Greeting.Schema should no longer error
      diagnostics = project.getDiagnostics("src/main.ts");
      schemaErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Greeting") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.equal(schemaErrors.length, 0, "Should not error after adding @JSONSchema");
    });

    it("removes Schema support when @JSONSchema marker is removed", async () => {
      const files = {
        "src/types.ts": [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        "src/main.ts": [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      project = createTestProject(files);
      await project.waitForInitialScan();

      // Before: no errors
      let diagnostics = project.getDiagnostics("src/main.ts");
      let schemaErrors = diagnostics.filter((d) => SCHEMA_ERROR_CODES.has(d.code));
      assert.equal(schemaErrors.length, 0, "Should not error with @JSONSchema marker");

      // Remove the @JSONSchema marker
      project.updateFile("src/types.ts", [
        'export interface Greeting {',
        '  message: string;',
        '}',
      ].join("\n"));

      // Trigger rescan
      project.getDiagnostics("src/types.ts");

      // After: Greeting.Schema should produce an error
      diagnostics = project.getDiagnostics("src/main.ts");
      schemaErrors = diagnostics.filter((d) => SCHEMA_ERROR_CODES.has(d.code));
      assert.ok(schemaErrors.length > 0, "Should error after removing @JSONSchema");
    });

    it("handles adding a second @JSONSchema type to the same file", async () => {
      const files = {
        "src/types.ts": [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
          '',
          'export interface Sentiment {',
          '  score: number;',
          '}',
        ].join("\n"),
        "src/main.ts": [
          'import { Greeting, Sentiment } from "./types";',
          '',
          'const g = Greeting.Schema;',
          'const s = Sentiment.Schema;',
        ].join("\n"),
      };

      project = createTestProject(files);
      await project.waitForInitialScan();

      // Sentiment.Schema should error (not marked yet — produces 2693 for interface)
      let diagnostics = project.getDiagnostics("src/main.ts");
      let sentimentErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Sentiment") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.ok(sentimentErrors.length > 0, "Should error for unmarked Sentiment");

      // Add @JSONSchema to Sentiment
      project.updateFile("src/types.ts", [
        '/** @JSONSchema */',
        'export interface Greeting {',
        '  message: string;',
        '}',
        '',
        '/** @JSONSchema */',
        'export interface Sentiment {',
        '  score: number;',
        '}',
      ].join("\n"));

      // Trigger rescan
      project.getDiagnostics("src/types.ts");

      // Both should now work
      diagnostics = project.getDiagnostics("src/main.ts");
      sentimentErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Sentiment") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.equal(sentimentErrors.length, 0, "Should not error after marking Sentiment with @JSONSchema");
    });
  });

  describe("type inference", () => {
    it("correctly infers properties that reference other @JSONSchema types", async () => {
      const files = {
        "src/types.ts": [
          '/** @JSONSchema */',
          'export interface FunctionInfo {',
          '  name: string;',
          '  signature: string;',
          '}',
          '',
          '/** @JSONSchema */',
          'export interface FunctionList {',
          '  functions: FunctionInfo[];',
          '}',
        ].join("\n"),
        "src/main.ts": [
          'import { think } from "thinkwell";',
          'import { FunctionList } from "./types";',
          '',
          'async function main() {',
          '  const result = await think(FunctionList.Schema);',
          '  const names: string[] = result.functions.map((f: any) => f.name);',
          '}',
        ].join("\n"),
      };

      project = createTestProject(files);
      await project.waitForInitialScan();

      const diagnostics = project.getDiagnostics("src/main.ts");

      // Should have no schema errors and no type errors
      const relevantErrors = diagnostics.filter((d) => {
        // Ignore errors about missing return values, unused variables, etc.
        // Focus on schema-related (2339, 2693) and type inference (7006, 18046) errors
        return SCHEMA_ERROR_CODES.has(d.code) || d.code === 7006 || d.code === 18046;
      });
      assert.equal(
        relevantErrors.length, 0,
        `Expected no type inference errors, got: ${relevantErrors.map(d => `[${d.code}] ${typeof d.messageText === "string" ? d.messageText : d.messageText.messageText}`).join("; ")}`,
      );
    });
  });
});
