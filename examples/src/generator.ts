/**
 * Example: Build-time Schema Generation with ts-json-schema-generator
 *
 * This example demonstrates a types-first approach using build-time
 * code generation to create JSON Schemas from TypeScript types.
 *
 * Workflow:
 * 1. Define your types in generator.types.ts with JSDoc annotations
 * 2. Run: pnpm generate:schemas
 * 3. Import generated SchemaProviders from generator.schemas.ts
 *
 * The generator script (scripts/generate-schemas.ts) uses ts-json-schema-generator
 * to create a TypeScript module with SchemaProvider<T> exports for each type.
 *
 * Best for:
 * - Type-first development (TypeScript types are the source of truth)
 * - Large codebases with many types
 * - Teams that prefer to avoid runtime schema libraries
 * - CI/CD pipelines that validate schema freshness
 *
 * This file shows two use cases:
 * 1. Simple prompt without tools (summarization)
 * 2. Prompt with a custom tool (sentiment analysis using an npm package)
 */

import type { Summary, DocumentAnalysis } from "./generator.types.js";
import { SummarySchema, DocumentAnalysisSchema } from "./generator.schemas.js";
import * as fs from "fs/promises";
import connect from "./base-agent.js";
import Sentiment from "sentiment";

// Initialize the sentiment analyzer (from the `sentiment` npm package)
const sentimentAnalyzer = new Sentiment();

// =============================================================================
// Main: Run both examples
// =============================================================================

export default async function main() {
  const agent = await connect();

  try {
    // -------------------------------------------------------------------------
    // Example 1: Simple summarization
    // -------------------------------------------------------------------------
    console.log("=== Example 1: Simple Summarization ===\n");

    const content = await fs.readFile(
      new URL("sample.txt", import.meta.url),
      "utf-8"
    );

    console.log("Sending prompt to LLM...\n");

    const summary: Summary = await agent
      .think(SummarySchema)
      .text("Please summarize the following content:\n\n")
      .display(content)
      .run();

    console.log(`Title: ${summary.title}`);
    console.log(`Word Count: ${summary.wordCount}`);
    console.log("Points:");
    for (const point of summary.points) {
      console.log(`  - ${point}`);
    }

    // -------------------------------------------------------------------------
    // Example 2: Document analysis with custom tool
    // -------------------------------------------------------------------------
    console.log("\n=== Example 2: Document Analysis with Sentiment Tool ===\n");

    const feedback = await fs.readFile(
      new URL("feedback.txt", import.meta.url),
      "utf-8"
    );

    console.log("Analyzing customer feedback with sentiment tool...\n");

    const analysis: DocumentAnalysis = await agent
      .think(DocumentAnalysisSchema)
      .text(
        "Analyze the following customer feedback document. " +
          "Use the sentiment analysis tool to measure the emotional tone of each section, " +
          "then provide an overall analysis with recommendations.\n\n"
      )
      .text(feedback)

      // Custom tool: wraps the `sentiment` npm package as an MCP tool
      .tool(
        "analyze_sentiment",
        "Analyze the sentiment of a text passage. Returns a score (positive = good, negative = bad) and comparative score normalized by length.",
        async (input: { text: string }) => {
          const result = sentimentAnalyzer.analyze(input.text);
          console.log(
            `  Sentiment: score=${result.score}, comparative=${result.comparative.toFixed(3)}`
          );
          return {
            score: result.score,
            comparative: result.comparative,
            positive: result.positive,
            negative: result.negative,
          };
        },
        {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text passage to analyze",
            },
          },
          required: ["text"],
        }
      )

      .run();

    console.log("\n--- Document Analysis ---\n");
    console.log(`Overall Tone: ${analysis.overallTone}\n`);
    console.log("Sections:");
    for (const section of analysis.sections) {
      const indicator =
        section.sentimentScore > 0
          ? "+"
          : section.sentimentScore < 0
            ? "-"
            : "o";
      console.log(
        `  ${indicator} ${section.title} (score: ${section.sentimentScore})`
      );
      console.log(`    ${section.summary}\n`);
    }
    console.log(`Recommendation: ${analysis.recommendation}`);
  } finally {
    agent.close();
  }
}
