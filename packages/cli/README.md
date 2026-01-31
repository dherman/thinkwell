# @thinkwell/cli

A CLI for running TypeScript scripts with automatic JSON Schema generation. Zero configuration required.

## Features

- **Run TypeScript directly** - No build step needed
- **Automatic schema generation** - Types marked with `@JSONSchema` get schemas at runtime
- **Shebang support** - Make executable scripts with `#!/usr/bin/env thinkwell`
- **IDE support** - Generate `.d.ts` files for autocomplete
- **Built-in modules** - Use `thinkwell:*` imports for convenience

## Requirements

- [Bun](https://bun.sh) must be installed (the CLI delegates to Bun for execution)

## Installation

```bash
npm install -g @thinkwell/cli
# or
npx @thinkwell/cli script.ts
```

## Usage

### Running Scripts

```bash
# Run a TypeScript file
thinkwell script.ts

# With arguments
thinkwell script.ts --verbose --output result.json

# Explicit run command
thinkwell run script.ts
```

### Shebang Scripts

Create an executable script:

```typescript
#!/usr/bin/env thinkwell
import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";

/** @JSONSchema */
interface Greeting {
  message: string;
}

const agent = await Agent.connect(CLAUDE_CODE);
const greeting = await agent.think(Greeting.Schema).text("Say hello").run();
console.log(greeting.message);
agent.close();
```

Make it executable and run:

```bash
chmod +x script.ts
./script.ts
```

### Generating Type Declarations

For IDE autocomplete support, generate `.thinkwell.d.ts` files:

```bash
# Generate declarations in current directory
thinkwell types

# Generate in a specific directory
thinkwell types src/

# Watch mode - regenerate on file changes
thinkwell types --watch
thinkwell types --watch src/
```

### Help and Version

```bash
thinkwell --help
thinkwell --version
```

## The `thinkwell:*` Import Scheme

The CLI provides built-in module aliases for convenience:

```typescript
// Instead of:
import { Agent } from "@thinkwell/thinkwell";
import { SchemaProvider } from "@thinkwell/acp";

// You can write:
import { Agent } from "thinkwell:agent";
import { SchemaProvider } from "thinkwell:acp";
```

Available modules:

| Import | Resolves To |
|--------|-------------|
| `thinkwell:agent` | `@thinkwell/thinkwell` |
| `thinkwell:acp` | `@thinkwell/acp` |
| `thinkwell:protocol` | `@thinkwell/protocol` |
| `thinkwell:connectors` | `@thinkwell/thinkwell/connectors` |

## How It Works

1. The CLI checks if Bun is installed
2. It delegates to Bun with `@thinkwell/bun-plugin` preloaded
3. The plugin intercepts TypeScript file loads
4. Types marked with `@JSONSchema` get schema namespaces injected
5. Your code runs with `TypeName.Schema` available at runtime

## IDE Setup

The auto-generated `TypeName.Schema` namespaces aren't visible to your IDE by default. To enable autocomplete:

1. **Generate declaration files:**
   ```bash
   thinkwell types
   # or for development:
   thinkwell types --watch
   ```

2. **Update tsconfig.json:**
   ```json
   {
     "include": ["src/**/*.ts", "src/**/*.thinkwell.d.ts"]
   }
   ```

3. **Add to .gitignore:**
   ```
   *.thinkwell.d.ts
   ```

## Example: Complete Script

```typescript
#!/usr/bin/env thinkwell

import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";

/**
 * Analysis result from the AI.
 * @JSONSchema
 */
interface Analysis {
  /** Summary of the content */
  summary: string;
  /** Key topics identified */
  topics: string[];
  /** Sentiment score from -1 to 1 */
  sentiment: number;
}

async function main() {
  const agent = await Agent.connect(CLAUDE_CODE);

  try {
    const content = "TypeScript is a typed superset of JavaScript...";

    const result: Analysis = await agent
      .think(Analysis.Schema)
      .text("Analyze the following content:")
      .quote(content)
      .run();

    console.log("Summary:", result.summary);
    console.log("Topics:", result.topics.join(", "));
    console.log("Sentiment:", result.sentiment);
  } finally {
    agent.close();
  }
}

main();
```

## Troubleshooting

### "Bun is required but not found"

Install Bun from https://bun.sh:

```bash
curl -fsSL https://bun.sh/install | bash
```

### "Script not found"

Ensure the file path is correct. The CLI checks both the provided path and relative to the current directory.

### "Unknown thinkwell module"

You're using an import that doesn't exist. Valid imports are:
- `thinkwell:agent`
- `thinkwell:acp`
- `thinkwell:protocol`
- `thinkwell:connectors`

### IDE doesn't show `TypeName.Schema`

Run `thinkwell types` to generate declaration files, and ensure your `tsconfig.json` includes `**/*.thinkwell.d.ts`.

### Schema generation fails for a type

Check that:
- The type has the `@JSONSchema` JSDoc tag
- The type doesn't use unsupported TypeScript features
- For cross-file types, ensure you have a `tsconfig.json`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DEBUG` | Set to show detailed error stack traces |

## License

MIT
