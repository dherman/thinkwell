/**
 * Example: Simple Summarization
 *
 * This example demonstrates a simple prompt-only use case with no tools.
 * The LLM summarizes content and returns structured JSON data.
 *
 * Run with: thinkwell src/summarize.ts
 */

import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";
import * as fs from "fs/promises";

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

async function main() {
  const agent = await Agent.connect(process.env.THINKWELL_AGENT_CMD ?? CLAUDE_CODE);

  try {
    console.log("=== Summarization Example ===\n");

    const content = await fs.readFile(
      new URL("sample.txt", import.meta.url),
      "utf-8"
    );

    console.log("Sending prompt to LLM...\n");

    const summary = await agent
      .think(Summary.Schema)
      .text("Please summarize the following content:\n\n")
      .quote(content)
      .run();

    console.log(`Title: ${summary.title}`);
    console.log(`Word Count: ${summary.wordCount}`);
    console.log("Points:");
    for (const point of summary.points) {
      console.log(`  - ${point}`);
    }
  } finally {
    await agent.close();
  }
}

main();
