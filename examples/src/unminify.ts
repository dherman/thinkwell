/**
 * Example: JavaScript Unminifier using LLM
 *
 * This example demonstrates using thinkwell to unminify JavaScript code
 * through a series of LLM-powered transformations:
 * 1. Pretty-print with Prettier
 * 2. Convert UMD wrapper to ESM default export
 * 3. Extract list of functions
 * 4. Analyze each function to suggest better names
 * 5. Apply renames in a single pass
 *
 * Run with: thinkwell src/unminify.ts
 */

import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";
import * as fs from "fs/promises";
import * as prettier from "prettier";
import pLimit from "p-limit";
import _ from "lodash";

// =============================================================================
// Type Definitions (marked with @JSONSchema for schema generation)
// =============================================================================

/**
 * Result of converting a UMD module to ESM.
 * @JSONSchema
 */
export interface ModuleConversion {
  /** The converted ESM code with default export */
  code: string;
  /** The name of the main exported object/function */
  exportedName: string;
}

/**
 * Information about a function found in the code.
 * @JSONSchema
 */
export interface FunctionInfo {
  /** Current function name (may be minified) */
  name: string;
  /** Function signature including parameters */
  signature: string;
  /** Approximate line number where the function is defined */
  lineNumber: number;
}

/**
 * List of functions extracted from the code.
 * @JSONSchema
 */
export interface FunctionList {
  /** List of all top-level functions in the code */
  functions: FunctionInfo[];
}

/**
 * Analysis result for a single function.
 * @JSONSchema
 */
export interface FunctionAnalysis {
  /** The original minified function name */
  originalName: string;
  /** Suggested descriptive name (camelCase, no underscores unless conventional) */
  suggestedName: string;
  /** Brief description of what the function does */
  purpose: string;
  /** Confidence level in the suggested name */
  confidence: "high" | "medium" | "low";
}

/**
 * Batch of function analyses.
 * @JSONSchema
 */
export interface FunctionAnalysisBatch {
  /** Array of function analyses */
  analyses: FunctionAnalysis[];
}

/**
 * Result of applying renames to code.
 * @JSONSchema
 */
export interface RenamedCode {
  /** The code with all renames applied */
  code: string;
  /** Number of identifiers that were renamed */
  renameCount: number;
}

// =============================================================================
// Step 1: Pretty-print
// =============================================================================

export async function formatCode(code: string): Promise<string> {
  return prettier.format(code, {
    parser: "babel",
    printWidth: 100,
    tabWidth: 2,
    semi: true,
    singleQuote: false,
  });
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const agent = await Agent.connect(process.env.THINKWELL_AGENT_CMD ?? CLAUDE_CODE);

  try {
    // Read the minified input file
    const inputPath = new URL("../data/underscore-umd-min.js", import.meta.url);
    const outputPath = new URL("../data/underscore.js", import.meta.url);

    const startTime = Date.now();

    console.log("=== Unminify Demo ===\n");
    console.log("Reading minified code...");
    const minifiedCode = await fs.readFile(inputPath, "utf-8");
    console.log(`Input: ${minifiedCode.length} characters\n`);

    // -------------------------------------------------------------------------
    // Step 1: Pretty-print
    // -------------------------------------------------------------------------
    console.log("Step 1: Pretty-printing with Prettier...");
    const prettyCode = await formatCode(minifiedCode);
    console.log(`Pretty-printed: ${prettyCode.split("\n").length} lines\n`);

    const step1EndTime = Date.now();

    // -------------------------------------------------------------------------
    // Step 2: Convert UMD to ESM
    // -------------------------------------------------------------------------
    console.log("Step 2: Converting UMD wrapper to ESM...");
    const conversion = await agent
      .think(ModuleConversion.Schema)
      .text(`
        Convert this UMD module to an ESM module with a default export.
        Remove the UMD wrapper boilerplate (the IIFE that checks for exports/define/globalThis).
        Keep all the internal code intact, just change the module format.
        The code should end with a default export of the main library object.

      `)
      .code(prettyCode, "javascript")
      .run();

    console.log(`Exported as: ${conversion.exportedName}`);
    const esmCode = await formatCode(conversion.code);
    console.log(`ESM module: ${esmCode.split("\n").length} lines\n`);

    const step2EndTime = Date.now();

    // -------------------------------------------------------------------------
    // Step 3: Extract function list
    // -------------------------------------------------------------------------
    console.log("Step 3: Extracting function list...");
    const functionList = await agent
      .think(FunctionList.Schema)
      .text(`
        Extract a list of all top-level function declarations and function expressions
        assigned to variables in this code. Include the function name, its signature
        (parameters), and approximate line number. Focus on functions with short
        (1-2 character) names that appear to be minified.

      `)
      .code(esmCode, "javascript")
      .run();

    console.log(`Found ${functionList.functions.length} functions to analyze\n`);

    const step3EndTime = Date.now();

    // -------------------------------------------------------------------------
    // Step 4: Analyze functions in batches (parallel with concurrency limit)
    // -------------------------------------------------------------------------
    console.log("Step 4: Analyzing functions in batches...");
    const renames: Map<string, string> = new Map();

    const limit = pLimit(5);
    const batches = _.chunk(functionList.functions, 30);

    console.log(`  Processing ${batches.length} batches...`);

    const results = await Promise.all(
      batches.map((batch) =>
        limit(async () => {
          const functionListText = batch
            .map((f) => `  - "${f.name}" with signature ${f.signature}`)
            .join("\n");

          return agent
            .think(FunctionAnalysisBatch.Schema)
            .text(`
              Analyze each of the following minified functions and suggest better, more descriptive names.

              IMPORTANT: For each function, the 'originalName' field in your response must be the EXACT
              minified name shown in quotes below (e.g., if the function is listed as "j", use exactly "j"
              as the originalName, not "jj" or any variation).

              Functions to analyze:

              ${functionListText}

              Here is the full code for context:

            `)
            .code(esmCode, "javascript")
            .run();
        })
      )
    );

    // Collect all renames
    for (const batch of results) {
      for (const analysis of batch.analyses) {
        if (analysis.suggestedName !== analysis.originalName) {
          renames.set(analysis.originalName, analysis.suggestedName);
          console.log(`  ${analysis.originalName} -> ${analysis.suggestedName}`);
        }
      }
    }

    console.log(`\nIdentified ${renames.size} renames\n`);

    const step4EndTime = Date.now();

    // -------------------------------------------------------------------------
    // Step 5: Apply renames
    // -------------------------------------------------------------------------
    console.log("Step 5: Applying renames...");
    const renameList = Array.from(renames.entries())
      .map(([from, to]) => `  ${from} -> ${to}`)
      .join("\n");

    const renamed = await agent
      .think(RenamedCode.Schema)
      .text(`
        Apply the following renames to the code. Be careful to only rename
        the function definitions and all their usages, not unrelated identifiers
        that happen to have the same name:

        ${renameList}

        Here is the code:

      `)
      .code(esmCode, "javascript")
      .run();

    const finalCode = await formatCode(renamed.code);
    console.log(`Applied ${renamed.renameCount} renames\n`);

    const step5EndTime = Date.now();

    // -------------------------------------------------------------------------
    // Write output
    // -------------------------------------------------------------------------
    console.log("Writing output...");
    await fs.writeFile(outputPath, finalCode, "utf-8");
    console.log(`Output written to: ${outputPath.pathname}`);
    console.log(`Final size: ${finalCode.length} characters, ${finalCode.split("\n").length} lines`);

    console.log("\n=== Done! ===");

    console.log("\n=== Timing Summary ===");
    console.log(`  Step 1 (Pretty-print):       ${(step1EndTime - startTime) / 1000}s`);
    console.log(`  Step 2 (UMD to ESM):        ${(step2EndTime - step1EndTime) / 1000}s`);
    console.log(`  Step 3 (Extract functions): ${(step3EndTime - step2EndTime) / 1000}s`);
    console.log(`  Step 4 (Analyze functions): ${(step4EndTime - step3EndTime) / 1000}s`);
    console.log(`  Step 5 (Apply renames):     ${(step5EndTime - step4EndTime) / 1000}s`);
    console.log(`  Total time:                 ${(step5EndTime - startTime) / 1000}s`);
  } finally {
    await agent.close();
  }
}

main();
