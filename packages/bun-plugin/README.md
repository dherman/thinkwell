# @thinkwell/bun-plugin

A Bun plugin for automatic JSON Schema generation from TypeScript types marked with `@JSONSchema`.

## Features

- **Zero configuration** - Just add `@JSONSchema` to your types
- **Automatic schema injection** - Schemas are available as `TypeName.Schema` at runtime
- **Cross-file type resolution** - Imported types are fully resolved
- **IDE support** - Generate `.d.ts` files for autocomplete
- **Fast** - Caches TypeScript program for ~60x speedup on subsequent files

## Installation

```bash
npm install @thinkwell/bun-plugin
# or
bun add @thinkwell/bun-plugin
```

## Usage

### With Bun Preload

Add to your `bunfig.toml`:

```toml
preload = ["@thinkwell/bun-plugin"]
```

Or run directly:

```bash
bun --preload @thinkwell/bun-plugin script.ts
```

### With thinkwell CLI (Recommended)

The easiest way to use this plugin is through the `@thinkwell/cli` package:

```bash
npx thinkwell script.ts
```

## Marking Types for Schema Generation

Add the `@JSONSchema` JSDoc tag to any interface, type alias, enum, or class:

```typescript
/**
 * A user profile.
 * @JSONSchema
 */
export interface User {
  /** The user's unique identifier */
  id: string;
  /** The user's display name */
  name: string;
  /** @minimum 0 */
  age: number;
}

// At runtime, User.Schema is available:
console.log(User.Schema.toJsonSchema());
// Output: { type: "object", properties: { id: { type: "string" }, ... } }
```

### Supported JSDoc Annotations

The plugin uses [ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator) under the hood, which supports:

| Annotation | Description | Example |
|------------|-------------|---------|
| `@minimum` | Minimum numeric value | `@minimum 0` |
| `@maximum` | Maximum numeric value | `@maximum 100` |
| `@minLength` | Minimum string length | `@minLength 1` |
| `@maxLength` | Maximum string length | `@maxLength 255` |
| `@pattern` | Regex pattern for strings | `@pattern ^[a-z]+$` |
| `@format` | String format | `@format email` |
| `@default` | Default value | `@default "hello"` |

### Supported Type Constructs

- Interfaces and type aliases
- Enums (string and numeric)
- Union types (`"a" | "b"`)
- Intersection types (`A & B`)
- Arrays (`string[]`, `Array<T>`)
- Tuples (`[string, number]`)
- Optional properties (`name?: string`)
- Nested objects
- Generic types (with concrete type arguments)
- Imported types from other files

## Cross-File Type Resolution

Types imported from other files are automatically resolved:

```typescript
// types.ts
/** @JSONSchema */
export interface Address {
  street: string;
  city: string;
}

// user.ts
import { Address } from "./types.js";

/** @JSONSchema */
export interface User {
  name: string;
  address: Address;  // Fully resolved in the schema
}
```

For cross-file resolution to work, ensure you have a `tsconfig.json` in your project root.

## IDE Support

The plugin generates schemas at runtime, but your IDE doesn't know about the injected `TypeName.Schema` namespaces. To get autocomplete:

### 1. Generate Declaration Files

```bash
# One-time generation
npx thinkwell types

# Watch mode for development
npx thinkwell types --watch

# Specify directory
npx thinkwell types src/
```

This creates `.thinkwell.d.ts` files next to your source files.

### 2. Update tsconfig.json

```json
{
  "include": ["src/**/*.ts", "src/**/*.thinkwell.d.ts"]
}
```

### 3. Add to .gitignore

```
*.thinkwell.d.ts
```

## The `thinkwell:*` Import Scheme

When using the thinkwell CLI, you can use special imports:

```typescript
import { Agent } from "thinkwell:agent";
import { SchemaProvider } from "thinkwell:acp";
import { CLAUDE_CODE } from "thinkwell:connectors";
```

Available modules:
- `thinkwell:agent` → `@thinkwell/thinkwell`
- `thinkwell:acp` → `@thinkwell/acp`
- `thinkwell:protocol` → `@thinkwell/protocol`
- `thinkwell:connectors` → `@thinkwell/thinkwell/connectors`

## Programmatic API

### Declaration Generation

```typescript
import { generateDeclarations, watchDeclarations } from "@thinkwell/bun-plugin";

// One-time generation
const files = await generateDeclarations({
  rootDir: "./src",
  include: ["**/*.ts"],
  exclude: ["node_modules/**", "**/*.d.ts"],
  onWrite: (source, decl) => console.log(`Generated: ${decl}`),
  onError: (error, source) => console.error(`Error: ${error.message}`),
});

// Watch mode
const watcher = watchDeclarations({
  rootDir: "./src",
  onWrite: (source, decl) => console.log(`Updated: ${decl}`),
  onRemove: (source, decl) => console.log(`Removed: ${decl}`),
});

// Stop watching
watcher.stop();
```

### Cache Management

```typescript
import { clearProgramCache, invalidateProgramCache } from "@thinkwell/bun-plugin";

// Clear all cached TypeScript programs
clearProgramCache();

// Invalidate cache for a specific file's project
invalidateProgramCache("/path/to/file.ts");
```

## Performance

The plugin uses aggressive caching for performance:

| Operation | First File | Subsequent Files |
|-----------|------------|------------------|
| Schema generation | ~60ms | ~1ms |
| AST parsing | ~0.2ms | ~0.2ms |
| Declaration generation | ~0.01ms | ~0.01ms |

The first file in a project pays the cost of creating the TypeScript program. Subsequent files in the same project reuse the cached program, resulting in ~60x speedup.

## Troubleshooting

### "Failed to generate schema for TypeName"

This usually means the type uses an unsupported TypeScript feature. Check that:
- The type doesn't have circular references without proper handling
- Generic types have concrete type arguments where used
- The type is exported (for cross-file resolution)

### "Unknown thinkwell module"

You're trying to import a module that doesn't exist. Available modules are:
- `thinkwell:agent`
- `thinkwell:acp`
- `thinkwell:protocol`
- `thinkwell:connectors`

### IDE doesn't recognize `TypeName.Schema`

Run `thinkwell types` to generate declaration files and ensure your `tsconfig.json` includes them.

### Cross-file types not resolving

Ensure you have a `tsconfig.json` in your project root. The plugin uses it to understand your project structure.

## License

MIT
