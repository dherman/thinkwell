<p align="center">
  <img src="packages/thinkwell/assets/logo.jpg" alt="Thinkwell Logo" width="200">
</p>

# thinkwell

A TypeScript library for blending deterministic code with LLM-powered reasoning.

## Packages

This monorepo contains two packages:

- **[@thinkwell/acp](packages/acp)**: Core ACP library providing MCP-over-ACP protocol handling
- **[thinkwell](packages/thinkwell)**: High-level API for blending deterministic code with LLM-powered reasoning

## Quick Start

```typescript
import { Agent, schemaOf } from "thinkwell";

// Connect to an agent
const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");

// Define your output type and schema
interface Summary {
  title: string;
  points: string[];
}

const SummarySchema = schemaOf<Summary>({
  type: "object",
  properties: {
    title: { type: "string" },
    points: { type: "array", items: { type: "string" } },
  },
  required: ["title", "points"],
});

// Use the think() API to compose prompts with tools
const summary = await agent
  .think(SummarySchema)
  .text("Summarize this document:")
  .quote(documentContents)
  .tool("record", "Record an important item", async (input: { item: string }) => {
    console.log("Recorded:", input.item);
    return { success: true };
  })
  .run();

console.log(summary.title);  // Typed as string
console.log(summary.points); // Typed as string[]

agent.close();
```

### Schema Providers

The `schemaOf<T>()` helper creates a `SchemaProvider<T>` from a JSON Schema. This enables type-safe integration with the LLM's structured output:

```typescript
import { schemaOf, type SchemaProvider } from "thinkwell";

// The type parameter flows through to the result
const schema: SchemaProvider<{ name: string }> = schemaOf({
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
});

const result = await agent.think(schema).text("...").run();
// result.name is typed as string
```

For integration with schema libraries like Zod or TypeBox, create an adapter that implements `SchemaProvider<T>`:

```typescript
// Example Zod adapter
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SchemaProvider } from "thinkwell";

function zodSchema<T>(schema: z.ZodType<T>): SchemaProvider<T> {
  return {
    toJsonSchema: () => zodToJsonSchema(schema),
  };
}

// Usage
const Summary = z.object({
  title: z.string(),
  points: z.array(z.string()),
});

const result = await agent.think(zodSchema(Summary)).text("...").run();
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
