/**
 * Example: Build-time Schema Generation with ts-json-schema-generator
 *
 * This example demonstrates a types-first approach using build-time
 * code generation to create JSON Schemas from TypeScript types.
 *
 * Workflow:
 * 1. Define your types here with JSDoc annotations (including @JSONSchema)
 * 2. Run: pnpm generate:schemas
 * 3. Import generated SchemaProviders from generator.schemas.ts
 *
 * The build tool (@dherman/build-schema-providers) uses ts-json-schema-generator
 * to create a TypeScript module with SchemaProvider<T> exports for each type
 * marked with @JSONSchema.
 *
 * Best for:
 * - Type-first development (TypeScript types are the source of truth)
 * - Large codebases with many types
 * - Teams that prefer to avoid runtime schema libraries
 * - CI/CD pipelines that validate schema freshness
 *
 * JSDoc annotations supported:
 * - @JSONSchema - marks a type for schema generation
 * - @minimum, @maximum - numeric constraints
 * - @default - default values
 * - @format - string formats (email, uuid, uri, date-time, etc.)
 * - @pattern - regex patterns
 * - @minLength, @maxLength - string length constraints
 *
 * This file shows two use cases:
 * 1. Simple prompt without tools (summarization)
 * 2. Prompt with a custom tool (sentiment analysis using an npm package)
 */

import { SummarySchema, DocumentAnalysisSchema, TextPassageSchema } from "./generator.schemas.js";
import * as fs from "fs/promises";
import Sentiment from "sentiment";
import DEFAULT_AGENT_CMD from "./claude-code.json" with { type: "json" };
import { Agent } from "thinkwell";

// =============================================================================
// Type Definitions (marked with @JSONSchema for schema generation)
// =============================================================================

/**
 * A summary of content.
 * @JSONSchema
 */
export interface Summary {
  /** A brief title for the summary */
  title: string;
  /** Key points from the content */
  points: string[];
  /**
   * Approximate word count of the original content
   * @minimum 0
   */
  wordCount: number;
}

/**
 * Result of sentiment analysis.
 * @JSONSchema
 */
export interface AnalysisResult {
  /** Overall sentiment of the content */
  sentiment: "positive" | "negative" | "neutral";
  /**
   * Confidence score between 0 and 1
   * @minimum 0
   * @maximum 1
   */
  confidence: number;
  /** Topics identified in the content */
  topics: Topic[];
}

/**
 * A topic with its relevance score.
 * @JSONSchema
 */
export interface Topic {
  /** The topic name */
  name: string;
  /**
   * Relevance score between 0 and 1
   * @minimum 0
   * @maximum 1
   */
  relevance: number;
}

/**
 * A section of a document with its sentiment analysis.
 * @JSONSchema
 */
export interface DocumentSection {
  /** The section title */
  title: string;
  /** The sentiment score from the analysis tool */
  sentimentScore: number;
  /** A brief summary of the section */
  summary: string;
}

/**
 * Analysis of a document's sentiment and content.
 * @JSONSchema
 */
export interface DocumentAnalysis {
  /** The overall emotional tone of the document */
  overallTone: "positive" | "negative" | "mixed" | "neutral";
  /** Analysis of each section */
  sections: DocumentSection[];
  /** A recommendation based on the analysis */
  recommendation: string;
}

/**
 * A text passage to analyze.
 * @JSONSchema
 */
export interface TextPassage {
  /** The text passage to analyze */
  text: string;
}

// =============================================================================
// Demo Implementation
// =============================================================================

// Initialize the sentiment analyzer (from the `sentiment` npm package)
const sentimentAnalyzer = new Sentiment();

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

    const summary: Summary = await agent
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

    const analysis: DocumentAnalysis = await agent
      .think(DocumentAnalysisSchema)
      .text(`
        Analyze the following customer feedback document.
        Use the sentiment analysis tool to measure the emotional tone of each section,
        then provide an overall analysis with recommendations.

      `)
      .quote(feedback, "feedback")

      // Custom tool: wraps the `sentiment` npm package as an MCP tool
      // Tool input schema generated from TextPassage type
      .tool(
        "analyze_sentiment",
        "Analyze the sentiment of a text passage. Returns a score (positive = good, negative = bad) and comparative score normalized by length.",
        TextPassageSchema,
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
