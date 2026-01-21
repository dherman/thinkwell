/**
 * Example: Zod Adapter (zodSchema)
 *
 * This example demonstrates the schema-first pattern using Zod.
 * Define your schema once with Zod and get both TypeScript types
 * and JSON Schema automatically.
 *
 * Best for:
 * - Runtime validation needed
 * - Schema-first development
 * - Teams already using Zod
 *
 * This file shows two use cases:
 * 1. Simple prompt without tools (summarization)
 * 2. Prompt with a custom tool (sentiment analysis using an npm package)
 *
 * Dependencies:
 * - zod
 * - zod-to-json-schema
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SchemaProvider, JsonSchema } from "@thinkwell/acp";
import * as fs from "fs/promises";
import Sentiment from "sentiment";
import { CLAUDE_CODE } from "thinkwell/connectors";
import { Agent } from "thinkwell";

/**
 * Creates a SchemaProvider from a Zod schema.
 *
 * This adapter bridges Zod schemas to the SchemaProvider interface,
 * enabling seamless integration with patchwork.
 *
 * @param schema - A Zod schema describing the expected type
 * @returns A SchemaProvider that produces the equivalent JSON Schema
 *
 * @example
 * ```typescript
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number().int().positive(),
 * });
 *
 * const result = await patchwork
 *   .think(zodSchema(UserSchema))
 *   .text("Extract user info from this text")
 *   .run();
 * ```
 */
export function zodSchema<T>(schema: z.ZodType<T>): SchemaProvider<T> {
  // Cache the converted schema for repeated calls
  let cached: JsonSchema | undefined;

  return {
    toJsonSchema(): JsonSchema {
      if (!cached) {
        cached = zodToJsonSchema(schema) as JsonSchema;
      }
      return cached;
    },
  };
}

// =============================================================================
// Example 1: Simple summarization (no tools)
// =============================================================================

// Define schemas with Zod - types are inferred automatically
export const SummaryZod = z.object({
  title: z.string().describe("A brief title for the summary"),
  points: z.array(z.string()).describe("Key points from the content"),
  wordCount: z
    .number()
    .int()
    .positive()
    .describe("Approximate word count of the original content"),
});

// TypeScript type is inferred from the schema
export type Summary = z.infer<typeof SummaryZod>;

// Create the SchemaProvider
export const SummarySchema: SchemaProvider<Summary> = zodSchema(SummaryZod);

// More complex example with nested objects and enums
export const AnalysisResultZod = z.object({
  sentiment: z
    .enum(["positive", "negative", "neutral"])
    .describe("Overall sentiment of the content"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence score between 0 and 1"),
  topics: z
    .array(
      z.object({
        name: z.string(),
        relevance: z.number().min(0).max(1),
      })
    )
    .describe("Topics identified in the content"),
});

export type AnalysisResult = z.infer<typeof AnalysisResultZod>;

export const AnalysisResultSchema: SchemaProvider<AnalysisResult> =
  zodSchema(AnalysisResultZod);

// =============================================================================
// Example 2: Document analysis with custom tool
// =============================================================================

// Initialize the sentiment analyzer (from the `sentiment` npm package)
const sentimentAnalyzer = new Sentiment();

export const DocumentAnalysisZod = z.object({
  overallTone: z
    .enum(["positive", "negative", "mixed", "neutral"])
    .describe("The overall emotional tone of the document"),
  sections: z.array(
    z.object({
      title: z.string(),
      sentimentScore: z.number(),
      summary: z.string(),
    })
  ),
  recommendation: z.string().describe("A recommendation based on the analysis"),
});

export type DocumentAnalysis = z.infer<typeof DocumentAnalysisZod>;

export const DocumentAnalysisSchema: SchemaProvider<DocumentAnalysis> =
  zodSchema(DocumentAnalysisZod);

// Tool input schema for sentiment analysis
const TextPassage = z.object({
  text: z.string().describe("The text passage to analyze"),
});

// =============================================================================
// Main: Run both examples
// =============================================================================

export default async function main() {
  const agent = await Agent.connect(process.env.PATCHWORK_AGENT_CMD ?? CLAUDE_CODE);

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
      .text(
        "Analyze the following customer feedback document. " +
          "Use the sentiment analysis tool to measure the emotional tone of each section, " +
          "then provide an overall analysis with recommendations.\n\n"
      )
      .quote(feedback, "feedback")

      // Custom tool: wraps the `sentiment` npm package as an MCP tool
      // Tool input schema defined with Zod and converted via zodSchema()
      .tool(
        "analyze_sentiment",
        "Analyze the sentiment of a text passage. Returns a score (positive = good, negative = bad) and comparative score normalized by length.",
        zodSchema(TextPassage),
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
