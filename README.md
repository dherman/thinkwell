<p>
  <img src="packages/thinkwell/assets/wordmark.png" alt="Thinkwell Logo" width="200">
</p>

A TypeScript library for easy scripting of AI agents. Thinkwell provides a fluent API for blending deterministic code with LLM-powered reasoning.

## Installation

**Homebrew** (macOS/Linux — self-contained, no dependencies):
```bash
brew install dherman/thinkwell/thinkwell
```

**npm** (requires Node.js 24+):
```bash
npm install -D thinkwell
```

**Try without installing:**
```bash
npx thinkwell init my-project
```

See the [Installation Guide](doc/installation.md) for more options including CI/CD setup.

## Packages

This monorepo contains the following packages:

- **[thinkwell](packages/thinkwell)**: High-level API for blending deterministic code with LLM-powered reasoning
- **[@thinkwell/acp](packages/acp)**: Core ACP library providing MCP-over-ACP protocol handling
- **[@thinkwell/protocol](packages/protocol)**: Protocol definitions and types
- **[@thinkwell/conductor](packages/conductor)**: Conductor for orchestrating agent workflows

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

## Thinkwell CLI

The `thinkwell` CLI provides a zero-configuration experience for running TypeScript scripts with automatic schema generation:

```bash
# Run a script - schemas are generated automatically
thinkwell script.ts

# Or use a shebang
#!/usr/bin/env thinkwell
```

Scripts use standard npm imports:

```typescript
#!/usr/bin/env thinkwell
import { open } from "thinkwell";

/** @JSONSchema */
interface Greeting {
  message: string;
}

const agent = await open('claude');
const greeting = await agent.think(Greeting.Schema).text("Say hello").run();
console.log(greeting.message);
```

### IDE Support

To get IDE autocomplete for auto-generated `TypeName.Schema` namespaces:

1. Generate declaration files:
   ```bash
   thinkwell types          # One-time generation
   thinkwell types --watch  # Watch mode for development
   ```

2. Add `.thinkwell.d.ts` files to your tsconfig.json:
   ```json
   {
     "include": ["src/**/*.ts", "src/**/*.thinkwell.d.ts"]
   }
   ```

3. Add to `.gitignore`:
   ```
   *.thinkwell.d.ts
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
