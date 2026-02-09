<p>
  <img src="https://raw.githubusercontent.com/dherman/thinkwell/refs/heads/main/packages/thinkwell/assets/wordmark.png" alt="Thinkwell Logo" width="200">
</p>

A TypeScript library for easy scripting of AI agents. Thinkwell provides a fluent API for blending deterministic code with LLM-powered reasoning.

## Quick Start

```typescript
import { open } from "thinkwell";

/**
 * A friendly greeting.
 * @JSONSchema
 */
export interface Greeting {
  /** The greeting message */
  message: string;
}

const agent = await open('claude');

try {
  const greeting: Greeting = await agent
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

  console.log(`✨ ${greeting.message}`);
} finally {
  agent.close();
}
```

## License

MIT
