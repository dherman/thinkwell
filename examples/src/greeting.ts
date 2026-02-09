/**
 * Example: Greeting with Custom Tool
 *
 * This example demonstrates using a simple custom tool with the LLM.
 * The tool provides the current time so the LLM can generate
 * a time-appropriate greeting.
 *
 * Run with: thinkwell src/greeting.ts
 */

import { open } from "thinkwell";
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
  const agent = await open('claude');

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
  } finally {
    agent.close();
  }
}

main();
