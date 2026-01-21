<p>
  <img src="packages/thinkwell/assets/logo.jpg" alt="Thinkwell Logo" width="200">
</p>

A TypeScript library for easy scripting of AI agents. Thinkwell provides a fluent API for blending deterministic code with LLM-powered reasoning.

## Packages

This monorepo contains two packages:

- **[thinkwell](packages/thinkwell)**: High-level API for blending deterministic code with LLM-powered reasoning
- **[@thinkwell/acp](packages/acp)**: Core ACP library providing MCP-over-ACP protocol handling

## Quick Start

```typescript
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

const agent = await Agent.connect(CLAUDE_CODE);

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
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Architecture

See [doc/rfd/mvp.md](doc/rfd/mvp.md) for the design document.
