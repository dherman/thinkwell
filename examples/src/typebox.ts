/**
 * Example 3: TypeBox Adapter (typeboxSchema)
 *
 * This example demonstrates the schema-first pattern using TypeBox.
 * TypeBox schemas are already valid JSON Schema, making the adapter trivial.
 *
 * Best for:
 * - Performance-critical applications (TypeBox is very fast)
 * - When you want schemas that are directly JSON Schema compatible
 * - When you need ajv integration
 *
 * Dependencies:
 * - @sinclair/typebox
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { SchemaProvider, JsonSchema } from "@dherman/sacp";
import * as fs from "fs/promises";
import connect from "./base-agent.js";

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

// Example with optional fields
export const ConfigTypeBox = Type.Object({
  temperature: Type.Number({ minimum: 0, maximum: 2, default: 0.7 }),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  systemPrompt: Type.Optional(Type.String()),
});

export type Config = Static<typeof ConfigTypeBox>;

export const ConfigSchema: SchemaProvider<Config> = typeboxSchema(ConfigTypeBox);

// Example demonstrating TypeBox's built-in JSON Schema formats
export const UserProfileTypeBox = Type.Object({
  id: Type.String({ format: "uuid" }),
  email: Type.String({ format: "email" }),
  website: Type.Optional(Type.String({ format: "uri" })),
  createdAt: Type.String({ format: "date-time" }),
});

export type UserProfile = Static<typeof UserProfileTypeBox>;

export const UserProfileSchema: SchemaProvider<UserProfile> =
  typeboxSchema(UserProfileTypeBox);


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
