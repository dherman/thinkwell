/**
 * Example: JavaScript Unminifier using LLM
 *
 * This example demonstrates using patchwork to unminify JavaScript code
 * through a series of LLM-powered transformations:
 * 1. Pretty-print with Prettier
 * 2. Convert UMD wrapper to ESM default export
 * 3. Extract list of functions
 * 4. Analyze each function to suggest better names
 * 5. Apply renames in a single pass
 *
 * This example uses the types-first approach with @JSONSchema JSDoc tags.
 * Schemas are generated at build time by running: pnpm generate:schemas
 */

import {
  ModuleConversionSchema,
  FunctionListSchema,
  FunctionAnalysisBatchSchema,
  RenamedCodeSchema,
} from "./unminify.schemas.js";
import connect from "./base-agent.js";
import * as fs from "fs/promises";
import * as prettier from "prettier";

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

export default async function main() {
  const agent = await connect();

  try {
    // Read the minified input file
    const inputPath = new URL("../data/underscore-umd-min.js", import.meta.url);
    const outputPath = new URL("../data/underscore.js", import.meta.url);

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

    // -------------------------------------------------------------------------
    // Step 2: Convert UMD to ESM
    // -------------------------------------------------------------------------
    console.log("Step 2: Converting UMD wrapper to ESM...");
    const conversion: ModuleConversion = await agent
      .think(ModuleConversionSchema)
      .text(
        "Convert this UMD module to an ESM module with a default export. " +
          "Remove the UMD wrapper boilerplate (the IIFE that checks for exports/define/globalThis). " +
          "Keep all the internal code intact, just change the module format. " +
          "The code should end with a default export of the main library object.\n\n"
      )
      .display(prettyCode)
      .run();

    console.log(`Exported as: ${conversion.exportedName}`);
    const esmCode = await formatCode(conversion.code);
    console.log(`ESM module: ${esmCode.split("\n").length} lines\n`);

    // -------------------------------------------------------------------------
    // Step 3: Extract function list
    // -------------------------------------------------------------------------
    console.log("Step 3: Extracting function list...");
    const functionList: FunctionList = await agent
      .think(FunctionListSchema)
      .text(
        "Extract a list of all top-level function declarations and function expressions " +
          "assigned to variables in this code. Include the function name, its signature " +
          "(parameters), and approximate line number. Focus on functions with short " +
          "(1-2 character) names that appear to be minified.\n\n"
      )
      .display(esmCode)
      .run();

    console.log(`Found ${functionList.functions.length} functions to analyze\n`);

    // -------------------------------------------------------------------------
    // Step 4: Analyze functions in batches
    // -------------------------------------------------------------------------
    console.log("Step 4: Analyzing functions in batches...");
    const renames: Map<string, string> = new Map();
    const analyzed: Set<string> = new Set();
    const retryCount: Map<string, number> = new Map();
    const CHUNK_SIZE = 30;
    const MAX_RETRIES = 3;

    // Process all functions, tracking which ones still need analysis
    let remaining = [...functionList.functions];
    let batchNum = 0;

    while (remaining.length > 0) {
      batchNum++;
      const chunk = remaining.slice(0, CHUNK_SIZE);
      remaining = remaining.slice(CHUNK_SIZE);

      console.log(
        `  Batch ${batchNum}: analyzing ${chunk.length} functions (${remaining.length} remaining after this batch)...`
      );

      const functionListText = chunk
        .map((f) => `  - "${f.name}" with signature ${f.signature}`)
        .join("\n");

      const batch: FunctionAnalysisBatch = await agent
        .think(FunctionAnalysisBatchSchema)
        .text(
          "Analyze each of the following minified functions and suggest better, more descriptive names.\n\n" +
            "IMPORTANT: For each function, the 'originalName' field in your response must be the EXACT " +
            "minified name shown in quotes below (e.g., if the function is listed as \"j\", use exactly \"j\" " +
            "as the originalName, not \"jj\" or any variation).\n\n" +
            "Functions to analyze:\n" +
            functionListText +
            "\n\nHere is the full code for context:\n\n"
        )
        .display(esmCode)
        .run();

      // Process results and track which functions were analyzed
      for (const analysis of batch.analyses) {
        if (!analyzed.has(analysis.originalName)) {
          analyzed.add(analysis.originalName);
          if (analysis.suggestedName !== analysis.originalName) {
            renames.set(analysis.originalName, analysis.suggestedName);
            console.log(
              `    ${analysis.originalName} → ${analysis.suggestedName} (${analysis.confidence})`
            );
          }
        }
      }

      // Check for any functions that were missed and add them back to remaining (with retry limit)
      const missed = chunk.filter((f) => !analyzed.has(f.name));
      if (missed.length > 0) {
        const toRetry: FunctionInfo[] = [];
        const gaveUp: string[] = [];

        for (const f of missed) {
          const count = (retryCount.get(f.name) ?? 0) + 1;
          retryCount.set(f.name, count);
          if (count < MAX_RETRIES) {
            toRetry.push(f);
          } else {
            gaveUp.push(f.name);
          }
        }

        if (toRetry.length > 0) {
          console.log(
            `    ${toRetry.length} functions missed, will retry: ${toRetry.map((f) => f.name).join(", ")}`
          );
          remaining.push(...toRetry);
        }
        if (gaveUp.length > 0) {
          console.log(
            `    Giving up on ${gaveUp.length} functions after ${MAX_RETRIES} retries: ${gaveUp.join(", ")}`
          );
        }
      }
    }

    console.log(`\nIdentified ${renames.size} renames\n`);

    // -------------------------------------------------------------------------
    // Step 5: Apply renames
    // -------------------------------------------------------------------------
    console.log("Step 5: Applying renames...");
    const renameList = Array.from(renames.entries())
      .map(([from, to]) => `  ${from} → ${to}`)
      .join("\n");

    const renamed: RenamedCode = await agent
      .think(RenamedCodeSchema)
      .text(
        "Apply the following renames to the code. Be careful to only rename " +
          "the function definitions and all their usages, not unrelated identifiers " +
          "that happen to have the same name:\n\n" +
          renameList +
          "\n\nHere is the code:\n\n"
      )
      .display(esmCode)
      .run();

    const finalCode = await formatCode(renamed.code);
    console.log(`Applied ${renamed.renameCount} renames\n`);

    // -------------------------------------------------------------------------
    // Write output
    // -------------------------------------------------------------------------
    console.log("Writing output...");
    await fs.writeFile(outputPath, finalCode, "utf-8");
    console.log(`Output written to: ${outputPath.pathname}`);
    console.log(`Final size: ${finalCode.length} characters, ${finalCode.split("\n").length} lines`);

    console.log("\n=== Done! ===");
  } finally {
    agent.close();
  }
}
