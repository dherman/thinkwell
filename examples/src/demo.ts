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


// Default conductor command using Claude Code ACP
const DEFAULT_CONDUCTOR_CMD =
  'sacp-conductor agent "npx -y @zed-industries/claude-code-acp"';

import inline from "./inline.js";
import zod from './zod.js';
import typebox from './typebox.js';
import generator from './generator.js';

const DEMOS: Record<string, () => Promise<void>> = {
  inline,
  zod,
  typebox,
  generator,
};

async function main() {
  const args = process.argv.slice(2);
  const pattern = args[0] || "all";

  console.log("SchemaProvider Demo");
  console.log("===================\n");

  if (pattern === "all") {
    // Run all patterns
    for (const demo of [inline, zod, typebox, generator]) {
      await demo();
    }
  } else if (["inline", "zod", "typebox", "generator"].includes(pattern)) {
    await DEMOS[pattern]();
  } else {
    console.log("Usage: pnpm demo [pattern]");
    console.log("");
    console.log("Patterns:");
    console.log("  inline    - Use schemaOf<T>() inline schema helper");
    console.log("  zod       - Use zodSchema() adapter");
    console.log("  typebox   - Use typeboxSchema() adapter");
    console.log("  generator - Use build-time generated schema");
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
