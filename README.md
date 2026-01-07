# sacp-ts

Experimental TypeScript port of [sacp-rs](https://github.com/symposium-dev/symposium-acp).

## Packages

This monorepo contains two packages:

- **[@dherman/sacp](packages/sacp)**: Core SACP library providing MCP-over-ACP protocol handling
- **[@dherman/patchwork](packages/patchwork)**: High-level API for blending deterministic code with LLM-powered reasoning

## Quick Start

```typescript
import { connect, schemaOf } from "@dherman/patchwork";

// Connect to an agent via the conductor
const patchwork = await connect(["sacp-conductor", "--agent", "claude"]);

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
const summary = await patchwork
  .think(SummarySchema)
  .text("Summarize this document:")
  .display(documentContents)
  .tool("record", "Record an important item", async (input: { item: string }) => {
    console.log("Recorded:", input.item);
    return { success: true };
  })
  .run();

console.log(summary.title);  // Typed as string
console.log(summary.points); // Typed as string[]

patchwork.close();
```

### Schema Providers

The `schemaOf<T>()` helper creates a `SchemaProvider<T>` from a JSON Schema. This enables type-safe integration with the LLM's structured output:

```typescript
import { schemaOf, type SchemaProvider } from "@dherman/patchwork";

// The type parameter flows through to the result
const schema: SchemaProvider<{ name: string }> = schemaOf({
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
});

const result = await patchwork.think(schema).text("...").run();
// result.name is typed as string
```

For integration with schema libraries like Zod or TypeBox, create an adapter that implements `SchemaProvider<T>`:

```typescript
// Example Zod adapter
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SchemaProvider } from "@dherman/patchwork";

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

const result = await patchwork.think(zodSchema(Summary)).text("...").run();
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

See [doc/rfd/mvp/design.md](doc/rfd/mvp/design.md) for the full design document.
