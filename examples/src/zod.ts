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
 * Dependencies:
 * - zod
 * - zod-to-json-schema
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SchemaProvider, JsonSchema } from "@dherman/sacp";
import * as fs from "fs/promises";
import connect from "./base-agent.js";

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

// Example with optional fields and defaults
export const ConfigZod = z.object({
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().optional(),
  systemPrompt: z.string().optional(),
});

export type Config = z.infer<typeof ConfigZod>;

export const ConfigSchema: SchemaProvider<Config> = zodSchema(ConfigZod);

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
