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
 */

import { Summary } from './generator.types.js';
import { SummarySchema } from './generator.schemas.js';
import * as fs from 'fs/promises';
import connect from './base-agent.js';

export default async function main() {
  const content = await fs.readFile(new URL("sample.txt", import.meta.url), "utf-8");
  const agent = await connect();

  try {
    console.log("\nSending prompt to LLM...\n");

    const result: Summary = await agent
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
