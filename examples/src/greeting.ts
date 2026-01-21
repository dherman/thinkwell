import { CLAUDE_CODE } from "thinkwell/connectors";
import { Agent } from "thinkwell";
import { GreetingSchema } from "./greeting.schemas.js";

/**
 * A friendly greeting.
 * @JSONSchema
 */
export interface Greeting {
  /** The greeting message */
  message: string;
}

export default async function main() {
  const agent = await Agent.connect(process.env.PATCHWORK_AGENT_CMD ?? CLAUDE_CODE);

  try {
    const greeting: Greeting = await agent
      .think(GreetingSchema)
      .text(`
        Use the current_time tool to get the current time, and create a friendly
        greeting message appropriate for that time of day.
      `)

      .tool(
        "current_time",
        "Produces the current date, time, and time zone.",
        async () => {
          const now = new Date();
          return {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            time: now.toLocaleTimeString,
            date: now.toLocaleDateString(),
          };
        }
      )

      .run();

    console.log(`✨ ${greeting.message}`);
  } finally {
    agent.close();
  }
}
