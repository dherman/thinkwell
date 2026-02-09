# RFD: Node-Native Developer Experience

**Depends on:** [remove-uri-scheme](remove-uri-scheme.md)

## Summary

This document proposes a build-time tooling experience for TypeScript developers who want to use thinkwell within their existing Node.js workflows — using their own `node`, `tsc`, `tsx`, or other tooling — without installing thinkwell as a global CLI. The key design constraint is **one programming model**: users write the same code regardless of whether they run via the thinkwell CLI or standard Node tooling. The only difference is a small amount of `package.json` configuration.

The build tool uses the TypeScript compiler API with a custom `CompilerHost` that intercepts file reads and serves transformed source from memory. When TypeScript requests a source file, the host reads the original from disk, applies `@JSONSchema` namespace injection in memory, and returns the result. No staging directory or intermediate files are needed.

## Problem Statement

Today, thinkwell's primary UX is the CLI: `thinkwell myscript.ts` or `thinkwell build`. The CLI handles source transformations at load time — most importantly, `@JSONSchema` processing that injects namespace declarations like `Greeting.Schema` alongside user-defined interfaces.

Many TypeScript developers have mature workflows built around standard Node tooling — `tsx`, `vitest`, `jest`, direct `node --experimental-transform-types`, etc. — and don't want a separate CLI runtime. We need to support these users without creating a second dialect of thinkwell TypeScript.

### The Dialect Problem

An earlier version of this design proposed generating companion files (`types.schemas.ts`) with exports like `GreetingSchema` that users would import explicitly. This creates two incompatible programming models:

| | CLI workflow | Node-native workflow |
|---|---|---|
| Usage | `Greeting.Schema` | `import { GreetingSchema } from "./types.schemas.js"` |
| Import | (none — namespace merges onto the type) | Explicit companion import |

This means example code, documentation, tutorials, and Stack Overflow answers would all need to say "if you're using the CLI, write it this way; if you're using Node, write it this other way." That's an unacceptable tax on the programming model. We should have one way to write thinkwell code.

### Why TypeScript Can't Help Us Directly

TypeScript's module system does not support declaration merging across file boundaries. You can't put `namespace Greeting { export const Schema = ... }` in a separate file and have it merge with `interface Greeting` in the user's source. This is [by design](https://github.com/Microsoft/TypeScript/issues/9611) — modules don't merge.

This means the only way to achieve `Greeting.Schema` is to have the namespace declaration **in the same file** as the interface. The CLI does this via runtime transformation into temp files. For the node-native workflow, we need to do the same transformation at build time.

### Prerequisite: Remove `thinkwell:*` URI Scheme

**This RFD depends on [remove-uri-scheme](remove-uri-scheme.md) being implemented first.** The entire node-native workflow relies on imports using standard npm package specifiers (`"thinkwell"`, `"@thinkwell/acp"`) that `tsc` can resolve natively. If user code still contains `thinkwell:*` imports, the CompilerHost would need to handle specifier rewriting in addition to `@JSONSchema` injection — adding complexity without adding value. Once the URI scheme is removed, the only remaining transformation that needs build-time support is `@JSONSchema` namespace injection.

## Design Goals

1. **One programming model** — Users write `Greeting.Schema` regardless of workflow. The same source file works with both `thinkwell src/main.ts` and `tsx src/main.ts` (after a build step).

2. **Standard imports** — Users import from `"thinkwell"` and `"@thinkwell/acp"` like any other npm package. No custom URI schemes, no special resolution.

3. **Composable with existing tooling** — The build step fits naturally into `package.json` scripts, pre-commit hooks, CI pipelines, and watch-mode workflows.

4. **Source files are sacred** — The user's original `.ts` files are never modified. Transformations are applied in memory via a custom CompilerHost; no intermediate files are written to disk.

5. **Good developer experience** — Source maps, IDE navigation, and debugging should work correctly, pointing back to the user's original files.

## Proposal

### The Core Idea

A new build tool that uses the TypeScript compiler API programmatically with a custom `CompilerHost`. When TypeScript's compiler requests a source file via `getSourceFile()`, the host reads the original file from disk, applies `@JSONSchema` namespace injection in memory, and returns the transformed source via `ts.createSourceFile()`. TypeScript compiles these virtual source files and produces `.js` and `.d.ts` output in the project's `outDir`. No intermediate files or staging directory are created — the user's original sources are never touched.

This command reclaims the name `thinkwell build` — currently used for compiling standalone binaries — for the standard tsc-based build that node-native developers expect. The existing binary compilation functionality is renamed to `thinkwell bundle`. See [CLI Interface: `build` vs `bundle`](#cli-interface-build-vs-bundle) below for the full rationale.

The user writes exactly the same code they'd write for the CLI:

```typescript
import { Agent } from "thinkwell";

/**
 * A friendly greeting.
 * @JSONSchema
 */
export interface Greeting {
  message: string;
}

const greeting = await agent
  .think(Greeting.Schema)
  .text("Say hello!")
  .run();
```

### How It Works

```
┌───────────────────────────────────────────────────────────────────────┐
│ thinkwell build                                                       │
│                                                                       │
│  1. Read tsconfig.json from user's project                            │
│  2. Create ts.Program with custom CompilerHost                        │
│  3. CompilerHost.getSourceFile() for each file:                       │
│     • Read original source from disk                                  │
│     • If @JSONSchema markers present, inject namespace declarations   │
│     • Return transformed source via ts.createSourceFile()             │
│  4. program.emit() writes output to user's configured outDir          │
│                                                                       │
│  src/                     CompilerHost (in memory)          dist/     │
│  ├── types.ts       ──►   types.ts + namespace       ──►   types.js  │
│  ├── main.ts        ──►   main.ts (pass-through)     ──►   main.js   │
│  └── tsconfig.json                                         ...       │
│  (never modified)         (no files on disk)               (output)  │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Virtual Transformation Details

When TypeScript requests a source file via `getSourceFile()`, the CompilerHost reads the original from disk and applies `@JSONSchema` namespace injection in memory (reusing the existing `transformJsonSchemas()` from `schema.ts`):

```typescript
// Original on disk (src/types.ts):
/** @JSONSchema */
export interface Greeting {
  message: string;
}

// Served in memory by CompilerHost (at the same path, src/types.ts):
import type * as $$__thinkwell__acp__$$ from "@thinkwell/acp";

/** @JSONSchema */
export interface Greeting {
  message: string;
}
namespace Greeting {
  export const Schema: $$__thinkwell__acp__$$.SchemaProvider<Greeting> = {
    toJsonSchema: () => ({
      type: "object",
      properties: {
        message: { type: "string" }
      },
      required: ["message"]
    }) as $$__thinkwell__acp__$$.JsonSchema,
  };
}
```

Files that don't contain `@JSONSchema` are passed through unchanged from the real filesystem.

### Source Maps

Since the CompilerHost serves transformed source from the original file paths, TypeScript's source maps point directly to the user's original files. No source map path rewriting is needed. The namespace injections are appended after each type declaration (not prepended), so line numbers for user code in the source maps remain correct.

### Example Workflow

**package.json:**
```json
{
  "scripts": {
    "build": "thinkwell build",
    "dev": "thinkwell build --watch",
    "test": "thinkwell build && vitest"
  },
  "devDependencies": {
    "thinkwell": "^0.5.0"
  }
}
```

**Development cycle:**
```bash
npm install
npm run dev          # watches source, rebuilds on changes
# ... edit src/types.ts, add @JSONSchema types
# ... CompilerHost picks up changes, tsc recompiles
```

### Dev Mode: Running Without Full Build

For quick iteration without a full `tsc` build, users can continue to use `tsx` or `node --experimental-transform-types` directly on their source files. The `@JSONSchema` runtime injection is handled by the thinkwell CLI's loader — the same loader used by `thinkwell src/main.ts`.

The CompilerHost-based build is primarily for users who want:
- Full type checking with `@JSONSchema` support (via `thinkwell check`)
- Compiled `.js`/`.d.ts` output (via `thinkwell build`)

For users who just want to run scripts, the thinkwell CLI's runtime transformation (`thinkwell src/main.ts`) remains the fastest path. For fast type-checking feedback during development, `thinkwell check --watch` provides continuous type checking without producing output files.

### CLI Interface: `build` vs `bundle`

The existing `thinkwell build` command compiles to standalone binaries (esbuild + pkg). We rename that to `thinkwell bundle`, which is the standard JavaScript ecosystem term for producing a self-contained artifact. This frees `thinkwell build` for the standard tsc-based build that node-native developers expect.

The `bundle` command supports two output modes:

```
thinkwell build              # tsc-based build (CompilerHost + tsc, this RFD)
thinkwell bundle             # self-contained JS bundle (esbuild, single .js file)
thinkwell bundle --binary    # self-contained binary executable (esbuild + pkg)
```

This naming is precise and idiomatic: "build" is what TypeScript developers type every day, while "bundle" specifically means producing a self-contained artifact — exactly what bundlers like esbuild, ncc, and webpack do. The `--binary` flag escalates from a JS bundle to a compiled executable, which is the less common need.

**Breaking change:** This is a backwards-incompatible rename. Existing users of `thinkwell build <entry>` (for binary compilation) will need to update to `thinkwell bundle <entry>`, and the `thinkwell.build` key in `package.json` moves to `thinkwell.bundle`. Since thinkwell is pre-1.0, this is an acceptable trade-off — and `bundle` is a more accurate name for what that command actually does.

### Configuration

The CompilerHost reads the user's existing `tsconfig.json` directly to understand their compiler options (`outDir`, `target`, `module`, `strict`, etc.). No intermediate or generated tsconfig is needed.

Additional thinkwell-specific configuration can go in `package.json`:

```json
{
  "thinkwell": {
    "build": {
      "include": ["src/**/*.ts"],
      "exclude": ["**/*.test.ts", "**/__fixtures__/**"]
    }
  }
}
```

The optional `include` and `exclude` fields accept glob patterns for controlling which files receive `@JSONSchema` processing. This is useful for skipping test files, fixtures, or other sources that don't need transformation. Files not matched by `include` (or matched by `exclude`) are still compiled by TypeScript — they just aren't transformed by the CompilerHost.

### Watch Mode

```bash
thinkwell build --watch
```

Watch mode:
1. Watches the source directory for `.ts` file changes
2. On change, re-runs the CompilerHost-based compilation (the CompilerHost reads fresh source from disk)
3. Uses TypeScript's incremental compilation (`--incremental`) for fast re-checks
4. Debounces rapid changes

This provides the same experience as `tsc --watch` but with thinkwell `@JSONSchema` transformations applied in memory.

## How This Interacts with the CLI Workflow

The CLI workflow (`thinkwell src/main.ts`) continues to work exactly as it does today — runtime transformation, no build step needed. The node-native workflow adds a build step but uses the same source code.

| Aspect | CLI workflow | Node-native workflow |
|---|---|---|
| User code | `Greeting.Schema` | `Greeting.Schema` (identical) |
| Imports | `"thinkwell"`, `"@thinkwell/acp"` | Same |
| `@JSONSchema` | Runtime injection | Build-time injection via CompilerHost |
| Build step | None | `thinkwell build` (CompilerHost + tsc emit) |
| Run command | `thinkwell src/main.ts` | `node dist/main.js` |
| Type checking | `thinkwell check` or VS Code extension | `thinkwell check` (same CompilerHost) |
| IDE support | VS Code extension ([vscode-ts-plugin](vscode-ts-plugin.md)) | Same VS Code extension |

### IDE Support

IDE support for `@JSONSchema` augmentations is covered by a separate effort: the Thinkwell VS Code extension with a TypeScript Language Service plugin ([vscode-ts-plugin](vscode-ts-plugin.md)). The extension presents virtual namespace augmentations to TypeScript so that `Greeting.Schema` is visible in the editor without generating files on disk.

This works identically for both workflows — the VS Code extension doesn't care whether the user runs scripts via the thinkwell CLI or standard Node tooling. All three mechanisms — the VS Code extension, `thinkwell check`, and `thinkwell build` — use the same concept of virtual/in-memory `@JSONSchema` injection, just through different interfaces (TS Language Service plugin for the IDE, CompilerHost for CLI tools). The migration path to TypeScript 7's `tsgo` is covered in [tsgo-api-migration](tsgo-api-migration.md).

### Shared Infrastructure with `thinkwell check`

The [`thinkwell check`](check-command.md) command uses the same custom CompilerHost as `thinkwell build`, but with `--noEmit`. Both commands:

- Create a `ts.Program` using the same custom CompilerHost
- Apply `@JSONSchema` namespace injection via `getSourceFile()` interception
- Read the user's `tsconfig.json` directly

The only difference is what happens after type checking:

| | `thinkwell check` | `thinkwell build` |
|---|---|---|
| Type checking | Yes | Yes |
| Emit (.js, .d.ts, source maps) | No (`--noEmit`) | Yes (`program.emit()`) |
| Primary use | Fast feedback during development | Produce compiled output |

This shared CompilerHost is implemented once and used by both commands, ensuring consistent `@JSONSchema` handling and reducing maintenance burden.

## Architecture

### Reuse of Existing Infrastructure

The CompilerHost reuses the core `@JSONSchema` transformation functions from `schema.ts` inside its `getSourceFile()` implementation:

| Component | Used By |
|---|---|
| `findMarkedTypes()` | CLI loader, CompilerHost `getSourceFile()` |
| `generateSchemas()` | CLI loader, CompilerHost `getSourceFile()` |
| `generateInsertions()` | CLI loader, CompilerHost `getSourceFile()` |
| `applyInsertions()` | CLI loader, CompilerHost `getSourceFile()` |
| `generateSchemaImport()` | CLI loader, CompilerHost `getSourceFile()` |
| `transformJsonSchemas()` | CLI loader, CompilerHost `getSourceFile()` (top-level orchestrator) |
| Custom `CompilerHost` | `thinkwell build`, `thinkwell check` |

The build tool adds orchestration logic around these: CompilerHost creation, `ts.Program` construction, `program.emit()` invocation, watch mode, and diagnostic formatting.

### CompilerHost Architecture

The custom CompilerHost follows a hybrid pattern inspired by [`@typescript/vfs`](https://www.npmjs.com/package/@typescript/vfs): transformed source takes priority for project files, with fallback to the real filesystem for everything else (`node_modules`, lib files, declaration files).

```typescript
// Simplified CompilerHost structure
const defaultHost = ts.createCompilerHost(options);

const host: ts.CompilerHost = {
  ...defaultHost,

  getSourceFile(fileName, languageVersion) {
    const source = ts.sys.readFile(fileName);
    if (source === undefined) return undefined;

    // Apply @JSONSchema transformation in memory
    const transformed = transformJsonSchemas(fileName, source);
    return ts.createSourceFile(fileName, transformed, languageVersion);
  },

  // All other methods (fileExists, readFile, module resolution, etc.)
  // delegate to the default host, which reads from the real filesystem.
};

const program = ts.createProgram({ rootNames, options, host });

// For thinkwell check:
const diagnostics = ts.getPreEmitDiagnostics(program);

// For thinkwell build:
program.emit();
```

The `transformJsonSchemas()` function is a no-op for files without `@JSONSchema` markers, so the CompilerHost is a transparent pass-through for standard TypeScript files.

### Incremental Compilation

TypeScript's built-in incremental compilation (`"incremental": true` in tsconfig) works naturally with the CompilerHost approach. TypeScript writes `.tsbuildinfo` files to track what has changed between compilations. Since the CompilerHost serves files from their original paths, TypeScript's incremental state aligns correctly with the real filesystem.

The CompilerHost itself does not need to cache transformations between runs — the `@JSONSchema` transformation is fast (regex check + AST traversal only for files that contain the marker). The dominant cost is TypeScript's own type checking, which incremental mode already optimizes.

## Trade-offs

### Advantages

| Aspect | Benefit |
|---|---|
| One programming model | `Greeting.Schema` works everywhere — no dialect split |
| Familiar tooling | Uses tsc under the hood; developers understand the output |
| Reuses existing code | Same transformation functions as the CLI |
| Full type checking | tsc runs on complete, valid TypeScript (with namespace merges) |
| Source map support | Output maps directly to original source files — no path rewriting needed |
| No intermediate files | No staging directory, no duplicated files, no generated tsconfig |
| Shared with `check` | Same CompilerHost used by `thinkwell check` — one implementation to maintain |

### Disadvantages

| Aspect | Impact |
|---|---|
| Build step required | Must run `thinkwell build` before running compiled output |
| TypeScript API coupling | Depends on TypeScript's `CompilerHost` interface, which is stable in practice but not a formally guaranteed public contract |
| tsgo migration | TypeScript 7 (Go port, shipping March 2026) replaces `CompilerHost` with `callbackfs` over IPC — requires migration (see [tsgo-api-migration](tsgo-api-migration.md)) |
| Implementation complexity | A custom CompilerHost is more complex to implement and debug than copying files to a directory |
| Debugging opacity | Transformed source only exists in memory; harder to inspect than staged files on disk (mitigation: a `--verbose` flag that logs transformed source) |

### Why Not a Staging Directory?

An earlier version of this design proposed copying source files to `.thinkwell/staged/`, applying `@JSONSchema` namespace injection to the copies, then running `tsc` on the staged files. This was replaced by the CompilerHost approach because:

1. **Source map complexity** — Staged files live at different paths from the originals, requiring post-processing of source maps to rewrite paths back to the user's source. The CompilerHost serves files from their original paths, eliminating this entirely.
2. **Disk I/O overhead** — Every source file must be copied to the staging directory, even files without `@JSONSchema`. The CompilerHost only transforms files that need it; everything else is a pass-through read from the real filesystem.
3. **Generated tsconfig** — The staging approach requires generating a second `tsconfig.json` that extends the user's config from the staging directory, introducing a layer of indirection and potential for configuration drift.
4. **Shared infrastructure** — The `thinkwell check` command already uses the CompilerHost approach (with `--noEmit`). Using the same CompilerHost for `build` means one implementation to maintain rather than two parallel transformation mechanisms.
5. **Cleaner project structure** — No `.thinkwell/staged/` directory to gitignore, no duplicated files on disk.

### Why Not Companion Files?

An earlier version of this design proposed generating companion `.schemas.ts` files with exports like `GreetingSchema`. This was rejected because it creates a programming model split: CLI users write `Greeting.Schema` while node-native users write `import { GreetingSchema }`. Having one way to write thinkwell code is more important than avoiding a build step.

### Why Not a Custom Node Loader?

Node.js supports custom ESM loaders via `--loader` or `register()`. We considered providing a thinkwell loader that performs transformations at import time. This was rejected because:

1. **Loader API instability** — Node's loader API has changed significantly across versions and remains experimental.
2. **Tooling incompatibility** — Custom loaders interact poorly with tsx, vitest, jest, and bundlers.
3. **Debugging friction** — Cryptic errors when loaders misbehave.
4. **No type checking** — A loader can make code run, but tsc still wouldn't see the namespace merges. You'd need the CompilerHost approach anyway for type-checking.

### Why Not ts-patch or Custom TypeScript Transformers?

ts-patch allows program-level transformers that can inject files into the compilation. This could theoretically inject namespace declarations. However:

1. **Patches the TypeScript installation** — Requires `ts-patch install` as a setup step, which modifies `node_modules`.
2. **Fragile across TypeScript versions** — Patches may break on TypeScript upgrades.
3. **No runtime code** — TypeScript transformers operate during emit; they can't inject runtime values (the `Schema` property needs to actually exist at runtime, not just type-check).

## References

- [RFD: `thinkwell check` Command](./check-command.md)
- [RFD: Remove `thinkwell:*` URI Scheme](./remove-uri-scheme.md)
- [RFD: VSCode Extension with TypeScript Plugin](./vscode-ts-plugin.md)
- [RFD: Migrate to `tsgo` IPC API](./tsgo-api-migration.md)
- [RFD: Schema Provider Interface](./schema-providers.md)
- [RFD: CLI Distribution](./cli-distribution.md)
- [RFD: `thinkwell bundle` Command](./user-build-command.md)
- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [`@typescript/vfs`](https://www.npmjs.com/package/@typescript/vfs) — Official virtual filesystem for TypeScript CompilerHost
- [TypeScript Declaration Merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html)
- [ts-json-schema-generator](https://www.npmjs.com/package/ts-json-schema-generator)
- [TypeScript #9611: Modules don't allow merging](https://github.com/Microsoft/TypeScript/issues/9611)
