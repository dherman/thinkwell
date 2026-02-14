#!/usr/bin/env thinkwell

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
import { Status } from "./util/status.js";

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
    const status = new Status('Thinking...');

    const thoughts = agent
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
      .stream();

    let first = true;
    for await (const thought of thoughts) {
      if (thought.type === 'message') {
        if (first && thought.text.trim() === '') {
          continue;
        } else if (first) {
          status.setMessage(thought.text.trimStart());
          first = false;
        } else {
          status.appendMessage(thought.text);
        }
      }
    }
    const greeting = await thoughts.result;

    status.clear();
    console.log(styleText(["bold", "white"], `✨ ${greeting.message}`));
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    await agent.close();
  }
}

main();
