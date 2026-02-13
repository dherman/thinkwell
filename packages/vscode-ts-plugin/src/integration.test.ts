import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTestProject } from "./test-harness";

const PROJECT_DIR = "/test-project";

/**
 * Error codes produced when accessing .Schema on a type without a namespace merge:
 * - 2693: "only refers to a type, but is being used as a value here" (interface has no value)
 * - 2339: "Property 'Schema' does not exist on type 'typeof X'" (class/enum has a value but no Schema)
 */
const SCHEMA_ERROR_CODES = new Set([2339, 2693]);

/** Standard test files for a project with @JSONSchema types. */
function standardFiles() {
  return {
    [path.join(PROJECT_DIR, "src/types.ts")]: [
      '/** @JSONSchema */',
      'export interface Greeting {',
      '  message: string;',
      '}',
      '',
      'export interface Unrelated {',
      '  value: number;',
      '}',
    ].join("\n"),

    [path.join(PROJECT_DIR, "src/main.ts")]: [
      'import { Greeting, Unrelated } from "./types";',
      '',
      'const schema = Greeting.Schema;',
      'const bad = Unrelated.Schema;',
    ].join("\n"),
  };
}

describe("integration: @JSONSchema augmentations", () => {
  describe("completions", () => {
    it("provides Schema completion on @JSONSchema-marked interface", async () => {
      const project = createTestProject(standardFiles(), { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      const mainFile = path.join(PROJECT_DIR, "src/main.ts");
      const completions = project.getCompletionsAt(mainFile, "Greeting.");

      assert.ok(completions, "Should return completions");
      const names = completions.entries.map((e) => e.name);
      assert.ok(names.includes("Schema"), `Expected "Schema" in completions, got: ${names.join(", ")}`);
    });

    it("does not provide Schema completion on unmarked interface", async () => {
      const project = createTestProject(standardFiles(), { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      const mainFile = path.join(PROJECT_DIR, "src/main.ts");
      const completions = project.getCompletionsAt(mainFile, "Unrelated.");

      // Unrelated has no @JSONSchema marker, so Schema should not appear
      if (completions) {
        const names = completions.entries.map((e) => e.name);
        assert.ok(!names.includes("Schema"), `"Schema" should not appear for unmarked types`);
      }
    });

    it("provides Schema completion on @JSONSchema-marked type alias", async () => {
      const files = {
        [path.join(PROJECT_DIR, "src/config.ts")]: [
          '/** @JSONSchema */',
          'export type Config = {',
          '  host: string;',
          '  port: number;',
          '};',
        ].join("\n"),
        [path.join(PROJECT_DIR, "src/use-config.ts")]: [
          'import { Config } from "./config";',
          '',
          'const schema = Config.Schema;',
        ].join("\n"),
      };

      const project = createTestProject(files, { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      const useFile = path.join(PROJECT_DIR, "src/use-config.ts");
      const completions = project.getCompletionsAt(useFile, "Config.");

      assert.ok(completions, "Should return completions");
      const names = completions.entries.map((e) => e.name);
      assert.ok(names.includes("Schema"), `Expected "Schema" in completions, got: ${names.join(", ")}`);
    });
  });

  describe("diagnostics", () => {
    it("produces no errors for Greeting.Schema on a marked type", async () => {
      const project = createTestProject(standardFiles(), { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      const mainFile = path.join(PROJECT_DIR, "src/main.ts");
      const diagnostics = project.getDiagnostics(mainFile);

      const greetingErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Greeting");
      });
      assert.equal(greetingErrors.length, 0, "Should have no errors for @JSONSchema-marked Greeting");
    });

    it("produces errors for Unrelated.Schema on an unmarked type", async () => {
      const project = createTestProject(standardFiles(), { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      const mainFile = path.join(PROJECT_DIR, "src/main.ts");
      const diagnostics = project.getDiagnostics(mainFile);

      const unrelatedErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Unrelated") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.ok(unrelatedErrors.length > 0, "Should report error for Unrelated.Schema");
    });

    it("reports no semantic errors for correct usage of Greeting.Schema", async () => {
      const files = {
        [path.join(PROJECT_DIR, "src/types.ts")]: [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        [path.join(PROJECT_DIR, "src/main.ts")]: [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      const project = createTestProject(files, { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      const mainFile = path.join(PROJECT_DIR, "src/main.ts");
      const diagnostics = project.getDiagnostics(mainFile);

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
        [path.join(PROJECT_DIR, "src/types.ts")]: [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        [path.join(PROJECT_DIR, "src/main.ts")]: [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      const project = createTestProject(files, { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      const mainFile = path.join(PROJECT_DIR, "src/main.ts");
      // Hover over "Schema" in "Greeting.Schema"
      const hoverPos = project.findPosition(mainFile, "Greeting.Schema") + "Greeting.".length;
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
      const typesFile = path.join(PROJECT_DIR, "src/types.ts");
      const mainFile = path.join(PROJECT_DIR, "src/main.ts");

      // Start with NO @JSONSchema marker
      const files = {
        [typesFile]: [
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        [mainFile]: [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      const project = createTestProject(files, { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      // Before: Greeting.Schema should produce an error (2693 for interface without value)
      let diagnostics = project.getDiagnostics(mainFile);
      let schemaErrors = diagnostics.filter((d) => SCHEMA_ERROR_CODES.has(d.code));
      assert.ok(schemaErrors.length > 0, "Should error before adding @JSONSchema");

      // Add the @JSONSchema marker
      project.updateFile(typesFile, [
        '/** @JSONSchema */',
        'export interface Greeting {',
        '  message: string;',
        '}',
      ].join("\n"));

      // Trigger rescan by requesting diagnostics on the types file first
      project.getDiagnostics(typesFile);

      // After: Greeting.Schema should no longer error
      diagnostics = project.getDiagnostics(mainFile);
      schemaErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Greeting") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.equal(schemaErrors.length, 0, "Should not error after adding @JSONSchema");
    });

    it("removes Schema support when @JSONSchema marker is removed", async () => {
      const typesFile = path.join(PROJECT_DIR, "src/types.ts");
      const mainFile = path.join(PROJECT_DIR, "src/main.ts");

      const files = {
        [typesFile]: [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
        ].join("\n"),
        [mainFile]: [
          'import { Greeting } from "./types";',
          '',
          'const schema = Greeting.Schema;',
        ].join("\n"),
      };

      const project = createTestProject(files, { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      // Before: no errors
      let diagnostics = project.getDiagnostics(mainFile);
      let schemaErrors = diagnostics.filter((d) => SCHEMA_ERROR_CODES.has(d.code));
      assert.equal(schemaErrors.length, 0, "Should not error with @JSONSchema marker");

      // Remove the @JSONSchema marker
      project.updateFile(typesFile, [
        'export interface Greeting {',
        '  message: string;',
        '}',
      ].join("\n"));

      // Trigger rescan
      project.getDiagnostics(typesFile);

      // After: Greeting.Schema should produce an error
      diagnostics = project.getDiagnostics(mainFile);
      schemaErrors = diagnostics.filter((d) => SCHEMA_ERROR_CODES.has(d.code));
      assert.ok(schemaErrors.length > 0, "Should error after removing @JSONSchema");
    });

    it("handles adding a second @JSONSchema type to the same file", async () => {
      const typesFile = path.join(PROJECT_DIR, "src/types.ts");
      const mainFile = path.join(PROJECT_DIR, "src/main.ts");

      const files = {
        [typesFile]: [
          '/** @JSONSchema */',
          'export interface Greeting {',
          '  message: string;',
          '}',
          '',
          'export interface Sentiment {',
          '  score: number;',
          '}',
        ].join("\n"),
        [mainFile]: [
          'import { Greeting, Sentiment } from "./types";',
          '',
          'const g = Greeting.Schema;',
          'const s = Sentiment.Schema;',
        ].join("\n"),
      };

      const project = createTestProject(files, { projectDir: PROJECT_DIR });
      await project.waitForInitialScan();

      // Sentiment.Schema should error (not marked yet — produces 2693 for interface)
      let diagnostics = project.getDiagnostics(mainFile);
      let sentimentErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Sentiment") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.ok(sentimentErrors.length > 0, "Should error for unmarked Sentiment");

      // Add @JSONSchema to Sentiment
      project.updateFile(typesFile, [
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
      project.getDiagnostics(typesFile);

      // Both should now work
      diagnostics = project.getDiagnostics(mainFile);
      sentimentErrors = diagnostics.filter((d) => {
        const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
        return msg.includes("Sentiment") && SCHEMA_ERROR_CODES.has(d.code);
      });
      assert.equal(sentimentErrors.length, 0, "Should not error after marking Sentiment with @JSONSchema");
    });
  });
});
