/**
 * Example: Inline Schema with schemaOf<T>() Helper
 *
 * This example demonstrates a minimalist pattern for using SchemaProvider:
 * passing a raw JSON Schema inline with the schemaOf helper.
 *
 * Best for:
 * - Quick prototyping
 * - Simple schemas
 * - When you don't want additional dependencies
 *
 * This file shows two use cases:
 * 1. Simple prompt without tools (summarization)
 * 2. Prompt with a custom tool (sentiment analysis using an npm package)
 */

import { schemaOf } from "@dherman/patchwork";
import type { SchemaProvider } from "@dherman/sacp";
import connect from "./base-agent.js";
import * as fs from "fs/promises";
import Sentiment from "sentiment";

// =============================================================================
// Example 1: Simple summarization (no tools)
// =============================================================================

interface Summary {
  title: string;
  points: string[];
  wordCount: number;
}

export const SummarySchema: SchemaProvider<Summary> = schemaOf<Summary>({
  type: "object",
  properties: {
    title: { type: "string", description: "A brief title for the summary" },
    points: {
      type: "array",
      items: { type: "string" },
      description: "Key points from the content",
    },
    wordCount: {
      type: "number",
      description: "Approximate word count of the original content",
    },
  },
  required: ["title", "points", "wordCount"],
});

// More complex nested example (exported for use in tests)
interface AnalysisResult {
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
  topics: Array<{
    name: string;
    relevance: number;
  }>;
}

export const AnalysisResultSchema: SchemaProvider<AnalysisResult> =
  schemaOf<AnalysisResult>({
    type: "object",
    properties: {
      sentiment: {
        type: "string",
        enum: ["positive", "negative", "neutral"],
        description: "Overall sentiment of the content",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confidence score between 0 and 1",
      },
      topics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            relevance: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["name", "relevance"],
        },
        description: "Topics identified in the content",
      },
    },
    required: ["sentiment", "confidence", "topics"],
  });

// =============================================================================
// Example 2: Document analysis with custom tool
// =============================================================================

// Initialize the sentiment analyzer (from the `sentiment` npm package)
const sentimentAnalyzer = new Sentiment();

interface DocumentAnalysis {
  overallTone: "positive" | "negative" | "mixed" | "neutral";
  sections: Array<{
    title: string;
    sentimentScore: number;
    summary: string;
  }>;
  recommendation: string;
}

const DocumentAnalysisSchema: SchemaProvider<DocumentAnalysis> =
  schemaOf<DocumentAnalysis>({
    type: "object",
    properties: {
      overallTone: {
        type: "string",
        enum: ["positive", "negative", "mixed", "neutral"],
        description: "The overall emotional tone of the document",
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            sentimentScore: { type: "number" },
            summary: { type: "string" },
          },
          required: ["title", "sentimentScore", "summary"],
        },
      },
      recommendation: {
        type: "string",
        description: "A recommendation based on the analysis",
      },
    },
    required: ["overallTone", "sections", "recommendation"],
  });


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

    const summary = await agent
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

    const analysis = await agent
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
        schemaOf<{ text: string }>({
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text passage to analyze",
            },
          },
          required: ["text"],
        }),
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
