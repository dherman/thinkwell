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
 */

import { schemaOf } from "@dherman/patchwork";
import type { JsonSchema, SchemaProvider } from "@dherman/sacp";
import connect from './base-agent.js';
import * as fs from 'fs/promises';

// Define your TypeScript interface
interface Summary {
  title: string;
  points: string[];
  wordCount: number;
}

// Create a SchemaProvider using schemaOf<T>()
// The type parameter links the schema to the TypeScript type
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

// More complex nested example
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

export default async function main() {
  const content = await fs.readFile(new URL("sample.txt", import.meta.url), "utf-8");
  const agent = await connect();

  try {
    console.log("\nSending prompt to LLM...\n");

    const result = await agent
      .think(SummarySchema)
      .text("Please summarize the following content:\n\n")
      .display(content)
      .run();

    console.log(`Title: ${result.title}`);
    console.log(`Word Count: ${result.wordCount}`);
    console.log("Points:");
    for (const point of result.points) {
      console.log(`  • ${point}`);
    }
  } finally {
    agent.close();
  }
}
