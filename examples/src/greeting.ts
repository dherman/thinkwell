/**
 * Example: Greeting with Custom Tool
 *
 * This example demonstrates using a simple custom tool with the LLM.
 * The tool provides the current time so the LLM can generate
 * a time-appropriate greeting.
 *
 * Run with: thinkwell src/greeting.ts
 */

import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";

/**
 * A friendly greeting.
 * @JSONSchema
 */
export interface Greeting {
  /** The greeting message */
  message: string;
}

async function main() {
  const agent = await Agent.connect(process.env.THINKWELL_AGENT_CMD ?? CLAUDE_CODE);

  try {
    const greeting = await agent
      .think(Greeting.Schema)
      .text(`
        Use the current_time tool to get the current time, and create a
        friendly greeting message appropriate for that time of day.
      `)

      .tool(
        "current_time",
        "Produces the current date, time, and time zone.",
        async () => {
          const now = new Date();
          return {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            time: now.toLocaleTimeString(),
            date: now.toLocaleDateString(),
          };
        }
      )

      .run();

    console.log(`${greeting.message}`);
  } finally {
    agent.close();
  }
}

main();
