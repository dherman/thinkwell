/**
 * Example: TypeBox Adapter (typeboxSchema)
 *
 * This example demonstrates the schema-first pattern using TypeBox.
 * TypeBox schemas are already valid JSON Schema, making the adapter trivial.
 *
 * Best for:
 * - Performance-critical applications (TypeBox is very fast)
 * - When you want schemas that are directly JSON Schema compatible
 * - When you need ajv integration
 *
 * This file shows two use cases:
 * 1. Simple prompt without tools (summarization)
 * 2. Prompt with a custom tool (sentiment analysis using an npm package)
 *
 * Dependencies:
 * - @sinclair/typebox
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { SchemaProvider, JsonSchema } from "@thinkwell/acp";
import * as fs from "fs/promises";
import Sentiment from "sentiment";
import DEFAULT_AGENT_CMD from "./claude-code.json" with { type: "json" };
import { Agent } from "thinkwell";

/**
 * Creates a SchemaProvider from a TypeBox schema.
 *
 * TypeBox schemas are already JSON Schema compliant, so this adapter
 * simply casts the schema to our JsonSchema type.
 *
 * @param schema - A TypeBox schema describing the expected type
 * @returns A SchemaProvider that returns the TypeBox schema as JsonSchema
 *
 * @example
 * ```typescript
 * const UserSchema = Type.Object({
 *   name: Type.String(),
 *   age: Type.Integer({ minimum: 0 }),
 * });
 *
 * const result = await patchwork
 *   .think(typeboxSchema(UserSchema))
 *   .text("Extract user info from this text")
 *   .run();
 * ```
 */
export function typeboxSchema<T extends TSchema>(
  schema: T
): SchemaProvider<Static<T>> {
  return {
    toJsonSchema(): JsonSchema {
      // TypeBox schemas are already valid JSON Schema
      return schema as unknown as JsonSchema;
    },
  };
}

// =============================================================================
// Example 1: Simple summarization (no tools)
// =============================================================================

// Define schemas with TypeBox - types are inferred automatically
export const SummaryTypeBox = Type.Object({
  title: Type.String({ description: "A brief title for the summary" }),
  points: Type.Array(Type.String(), {
    description: "Key points from the content",
  }),
  wordCount: Type.Integer({
    minimum: 0,
    description: "Approximate word count of the original content",
  }),
});

// TypeScript type is inferred from the schema
export type Summary = Static<typeof SummaryTypeBox>;

// Create the SchemaProvider
export const SummarySchema: SchemaProvider<Summary> =
  typeboxSchema(SummaryTypeBox);

// More complex example with unions and optional fields
export const AnalysisResultTypeBox = Type.Object({
  sentiment: Type.Union(
    [Type.Literal("positive"), Type.Literal("negative"), Type.Literal("neutral")],
    { description: "Overall sentiment of the content" }
  ),
  confidence: Type.Number({
    minimum: 0,
    maximum: 1,
    description: "Confidence score between 0 and 1",
  }),
  topics: Type.Array(
    Type.Object({
      name: Type.String(),
      relevance: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    { description: "Topics identified in the content" }
  ),
});

export type AnalysisResult = Static<typeof AnalysisResultTypeBox>;

export const AnalysisResultSchema: SchemaProvider<AnalysisResult> =
  typeboxSchema(AnalysisResultTypeBox);

// =============================================================================
// Example 2: Document analysis with custom tool
// =============================================================================

// Initialize the sentiment analyzer (from the `sentiment` npm package)
const sentimentAnalyzer = new Sentiment();

export const DocumentAnalysisTypeBox = Type.Object({
  overallTone: Type.Union(
    [
      Type.Literal("positive"),
      Type.Literal("negative"),
      Type.Literal("mixed"),
      Type.Literal("neutral"),
    ],
    { description: "The overall emotional tone of the document" }
  ),
  sections: Type.Array(
    Type.Object({
      title: Type.String(),
      sentimentScore: Type.Number(),
      summary: Type.String(),
    })
  ),
  recommendation: Type.String({
    description: "A recommendation based on the analysis",
  }),
});

export type DocumentAnalysis = Static<typeof DocumentAnalysisTypeBox>;

export const DocumentAnalysisSchema: SchemaProvider<DocumentAnalysis> =
  typeboxSchema(DocumentAnalysisTypeBox);

// Tool input schema for sentiment analysis
const TextPassageTypeBox = Type.Object({
  text: Type.String({ description: "The text passage to analyze" }),
});

// =============================================================================
// Main: Run both examples
// =============================================================================

export default async function main() {
  const agent = await Agent.connect(process.env.PATCHWORK_AGENT_CMD ?? DEFAULT_AGENT_CMD);

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

    const summary = await agent
      .think(SummarySchema)
      .text("Please summarize the following content:\n\n")
      .quote(content)
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

    const analysis = await agent
      .think(DocumentAnalysisSchema)
      .text(`
        Analyze the following customer feedback document.
        Use the sentiment analysis tool to measure the emotional tone of each section,
        then provide an overall analysis with recommendations.

      `)
      .quote(feedback, "feedback")

      // Custom tool: wraps the `sentiment` npm package as an MCP tool
      // Tool input schema defined with TypeBox and converted via typeboxSchema()
      .tool(
        "analyze_sentiment",
        "Analyze the sentiment of a text passage. Returns a score (positive = good, negative = bad) and comparative score normalized by length.",
        typeboxSchema(TextPassageTypeBox),
        async (passage) => {
          const result = sentimentAnalyzer.analyze(passage.text);
          console.log(
            `  Sentiment: score=${result.score}, comparative=${result.comparative.toFixed(3)}`
          );
          return {
            score: result.score,
            comparative: result.comparative,
            positive: result.positive,
            negative: result.negative,
          };
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
