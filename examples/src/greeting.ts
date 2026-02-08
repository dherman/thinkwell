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
import { styleText } from 'node:util';
import { startSpinner } from "./util/spinner.js";

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
    const stopSpinner = startSpinner('Thinking...');

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
            dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
          };
        }
      )

      .run();

    stopSpinner();
    console.log(styleText(["bold", "white"], `✨ ${greeting.message}`));
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    await agent.close();
  }
}

main();
