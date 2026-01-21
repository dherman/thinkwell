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
 *   # With a custom agent command:
 *   PATCHWORK_AGENT_CMD='npx -y @zed-industries/claude-code-acp' npx tsx src/demo.ts
 */


// Default conductor command using Claude Code ACP
import { CLAUDE_CODE } from "thinkwell/connectors";

import inline from "./inline.js";
import zod from './zod.js';
import typebox from './typebox.js';
import generator from './generator.js';
import greeting from './greeting.js';
import unminify from './unminify.js';

const DEMOS: Record<string, () => Promise<void>> = {
  inline,
  zod,
  typebox,
  generator,
  greeting,
  unminify,
};

async function main() {
  const args = process.argv.slice(2);
  const pattern = args[0] || "all";

  if (pattern === "all") {
    // Run all patterns
    for (const demo of [inline, zod, typebox, generator]) {
      await demo();
    }
  } else if (["inline", "zod", "typebox", "generator", "greeting", "unminify"].includes(pattern)) {
    await DEMOS[pattern]();
  } else {
    console.log("Usage: pnpm demo [pattern]");
    console.log("");
    console.log("Patterns:");
    console.log("  inline    - Use schemaOf<T>() with custom tools");
    console.log("  zod       - Use zodSchema() adapter");
    console.log("  typebox   - Use typeboxSchema() adapter");
    console.log("  generator - Use build-time generated schema");
    console.log("  unminify  - JavaScript unminifier using LLM analysis");
    console.log("  greeting  - Generate a simple greeting message using a tool");
    console.log("  all       - Run all patterns (default)");
    console.log("");
    console.log("Environment variables:");
    console.log(`  PATCHWORK_AGENT_CMD - Custom agent command`);
    console.log(`                  (default: ${CLAUDE_CODE})`);
    process.exit(1);
  }

  console.log("\nDemo complete!");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
