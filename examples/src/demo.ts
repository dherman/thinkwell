#!/usr/bin/env node
/**
 * Runnable Demo Script
 *
 * This script demonstrates the SchemaProvider patterns with a real LLM.
 *
 * Prerequisites:
 * - A conductor binary in your PATH (e.g., sacp-conductor)
 * - An agent configured (e.g., ANTHROPIC_API_KEY environment variable)
 *
 * Usage:
 *   # From the examples directory:
 *   pnpm demo
 *
 *   # Or directly with tsx:
 *   npx tsx src/demo.ts
 *
 *   # With a custom conductor command (supports quoted arguments):
 *   CONDUCTOR_CMD='sacp-conductor agent "npx -y @zed-industries/claude-code-acp"' npx tsx src/demo.ts
 */

import { connect } from "@dherman/patchwork";

/**
 * Parse a shell-style command string into an array of arguments.
 * Handles single quotes, double quotes, and escaped characters.
 */
function parseCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

// Import schema providers from each example
import { SummarySchema as InlineSummarySchema } from "./01-inline-schema.js";
import { zodSchema, SummaryZod } from "./02-zod-adapter.js";
import { typeboxSchema, SummaryTypeBox } from "./03-typebox-adapter.js";
import { SummarySchema as GeneratedSummarySchema } from "./04-types.schemas.generated.js";

// Sample content to summarize
const SAMPLE_CONTENT = `
TypeScript 5.0 introduced a major new feature called decorators, which are now
part of the ECMAScript standard. Decorators provide a way to add metadata and
modify class declarations, methods, properties, and parameters. They use the
@ syntax and can be used for logging, validation, dependency injection, and more.

Another key feature in TypeScript 5.0 is const type parameters, which allow
generic functions to infer more precise literal types. This reduces the need
for "as const" assertions in many cases.

The release also improved performance significantly, with faster type-checking
and reduced memory usage. The team reported up to 10-25% speed improvements
in large codebases.
`;

// Default conductor command using Claude Code ACP
const DEFAULT_CONDUCTOR_CMD =
  'sacp-conductor agent "npx -y @zed-industries/claude-code-acp"';

async function runDemo(pattern: string) {
  // Parse conductor command from environment or use default
  const cmdString = process.env.CONDUCTOR_CMD ?? DEFAULT_CONDUCTOR_CMD;
  const conductorCmd = parseCommand(cmdString);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running demo: ${pattern}`);
  console.log(`Conductor: ${conductorCmd.join(" ")}`);
  console.log("=".repeat(60));

  const patchwork = await connect(conductorCmd);

  try {
    let schema;
    switch (pattern) {
      case "inline":
        console.log("\nUsing: schemaOf<T>() inline schema helper");
        schema = InlineSummarySchema;
        break;
      case "zod":
        console.log("\nUsing: zodSchema() adapter");
        schema = zodSchema(SummaryZod);
        break;
      case "typebox":
        console.log("\nUsing: typeboxSchema() adapter");
        schema = typeboxSchema(SummaryTypeBox);
        break;
      case "generated":
        console.log("\nUsing: Build-time generated schema");
        schema = GeneratedSummarySchema;
        break;
      default:
        throw new Error(`Unknown pattern: ${pattern}`);
    }

    console.log("\nSending prompt to LLM...\n");

    const result = (await patchwork
      .think(schema)
      .text("Please summarize the following content:\n\n")
      .display(SAMPLE_CONTENT)
      .run()) as { title: string; points: string[]; wordCount: number };

    console.log("Result:");
    console.log("-".repeat(40));
    console.log(`Title: ${result.title}`);
    console.log(`Word Count: ${result.wordCount}`);
    console.log("Points:");
    for (const point of result.points) {
      console.log(`  - ${point}`);
    }
    console.log("-".repeat(40));
  } finally {
    patchwork.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const pattern = args[0] || "all";

  console.log("SchemaProvider Demo");
  console.log("===================\n");

  if (pattern === "all") {
    // Run all patterns
    for (const p of ["inline", "zod", "typebox", "generated"]) {
      await runDemo(p);
    }
  } else if (["inline", "zod", "typebox", "generated"].includes(pattern)) {
    await runDemo(pattern);
  } else {
    console.log("Usage: pnpm demo [pattern]");
    console.log("");
    console.log("Patterns:");
    console.log("  inline    - Use schemaOf<T>() inline schema helper");
    console.log("  zod       - Use zodSchema() adapter");
    console.log("  typebox   - Use typeboxSchema() adapter");
    console.log("  generated - Use build-time generated schema");
    console.log("  all       - Run all patterns (default)");
    console.log("");
    console.log("Environment variables:");
    console.log(`  CONDUCTOR_CMD - Custom conductor command`);
    console.log(`                  (default: ${DEFAULT_CONDUCTOR_CMD})`);
    process.exit(1);
  }

  console.log("\nDemo complete!");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
