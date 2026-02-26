#!/usr/bin/env thinkwell

/**
 * Example: JavaScript Unminifier using LLM
 *
 * This example demonstrates using thinkwell to unminify JavaScript code
 * through a mix of LLM-powered analysis and deterministic transformations:
 * 1. Pretty-print with Prettier
 * 2. Convert UMD wrapper to ESM default export (deterministic, ast-grep)
 * 3. Extract list of functions (LLM)
 * 4. Analyze each function to suggest better names (LLM, parallel batches)
 * 5. Apply renames with Babel's scope-aware renaming (deterministic)
 *
 * Requires: ast-grep installed and in PATH (https://ast-grep.github.io)
 * Run with: thinkwell src/unminify.ts
 */

import { open } from "thinkwell";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as prettier from "prettier";
import pLimit from "p-limit";
import _ from "lodash";
import { parse as babelParse } from "@babel/parser";
import { generate } from "@babel/generator";
import { default as _traverse } from "@babel/traverse";

// @babel/traverse has a double-default due to CJS→ESM interop
const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;

// =============================================================================
// Type Definitions (marked with @JSONSchema for schema generation)
// =============================================================================

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
  const agent = await open('claude');

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
    // Step 2: Convert UMD to ESM (deterministic — ast-grep)
    // -------------------------------------------------------------------------
    console.log("Step 2: Converting UMD wrapper to ESM...");

    // Use ast-grep to strip the UMD wrapper and add a default export.
    // Pattern matches: !(function(n, r) { ... })(this, function() { BODY return RET; });
    const tmpFile = path.join(os.tmpdir(), `unminify-${Date.now()}.js`);
    await fs.writeFile(tmpFile, prettyCode);
    await new Promise<void>((resolve, reject) => {
      execFile("ast-grep", [
        "run",
        "--pattern", "!($IIFE)(this, function () { $$$BODY return $RET; })",
        "--rewrite", "$$$BODY\nexport default $RET;",
        "--lang", "js",
        "--update-all",
        tmpFile,
      ], (err) => err ? reject(err) : resolve());
    });

    const esmCode = await formatCode(await fs.readFile(tmpFile, "utf-8"));
    await fs.unlink(tmpFile).catch(() => {});

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
        }
      }
    }

    // Deduplicate suggested names: since batches run in parallel, different
    // minified functions may independently get the same suggested name. The
    // first occurrence keeps the clean name; subsequent duplicates get a
    // numeric suffix (e.g. toArray, toArray2, toArray3). A production tool
    // could do something more sophisticated (e.g. a second LLM pass to
    // disambiguate), but this keeps the demo simple.
    const nameCount = new Map<string, number>();
    for (const [orig, suggested] of renames) {
      const count = (nameCount.get(suggested) ?? 0) + 1;
      nameCount.set(suggested, count);
      if (count > 1) {
        renames.set(orig, `${suggested}${count}`);
      }
    }

    for (const [orig, suggested] of renames) {
      console.log(`  ${orig} -> ${suggested}`);
    }

    console.log(`\nIdentified ${renames.size} renames\n`);

    const step4EndTime = Date.now();

    // -------------------------------------------------------------------------
    // Step 5: Apply renames (deterministic — Babel scope-aware renaming)
    // -------------------------------------------------------------------------
    console.log("Step 5: Applying renames with Babel...");
    const ast = babelParse(esmCode, { sourceType: "module", plugins: [] });
    let renameCount = 0;

    traverse(ast, {
      Program(path: any) {
        for (const [oldName, newName] of renames) {
          if (path.scope.getBinding(oldName)) {
            path.scope.rename(oldName, newName);
            renameCount++;
          }
        }
      },
    });

    const renamedCode = generate(ast, { retainLines: false, comments: true }).code;
    const finalCode = await formatCode(renamedCode);
    console.log(`Applied ${renameCount} renames\n`);

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
    console.log(`  Step 1 (Pretty-print):      ${(step1EndTime - startTime) / 1000}s`);
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
