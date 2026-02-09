# RFD: VSCode Extension with TypeScript Plugin for `@JSONSchema`

**Depends on:** [remove-uri-scheme](remove-uri-scheme.md)

## Summary

Build a VSCode extension that bundles a TypeScript Language Service plugin to provide IDE support for the `@JSONSchema` feature. The plugin presents virtual type augmentations to TypeScript so that `Greeting.Schema` and other injected namespace members are visible in the editor — without generating any files on disk.

This targets TypeScript 5.x/6.x. A separate RFD ([tsgo-api-migration](tsgo-api-migration.md)) covers the migration path to TypeScript 7+.

## Background

Thinkwell's `@JSONSchema` JSDoc marker triggers a runtime transformation: when a script is loaded, the loader scans for marked interfaces, generates JSON schemas, and injects TypeScript namespace declarations that merge with the interface:

```typescript
/** @JSONSchema */
export interface Greeting {
  message: string;
}

// At runtime, the loader injects:
namespace Greeting {
  export const Schema: SchemaProvider<Greeting> = { ... };
}

// So user code can write:
const greeting = await agent.think(Greeting.Schema);
```

This works perfectly at runtime. But in the editor, TypeScript sees only the interface declaration and reports: `Property 'Schema' does not exist on type 'typeof Greeting'`.

### Prerequisite

This RFD assumes the `thinkwell:*` URI scheme has been removed per [remove-uri-scheme](remove-uri-scheme.md). For projects with `thinkwell` installed as an npm dependency, import resolution is handled natively by TypeScript through standard `package.json` exports. Two IDE gaps remain: `@JSONSchema` augmentation and standalone script support (see below).

## Problem Statement

The `@JSONSchema` transformation is project-specific — it depends on which interfaces in the user's code are marked with `@JSONSchema`. This means static type declarations shipped in the npm package can't solve it. Something has to analyze the user's code and tell TypeScript about the generated namespace members.

### Approaches considered and rejected

**Generated `.d.ts` files (`thinkwell types` command):**
- Pollutes the user's directory with generated files (or hides them in `node_modules` where they may be cleaned)
- Requires running a command or a watch process
- Files can go stale, leading to confusing mismatches between editor state and runtime
- Adds complexity to the build pipeline (gitignore rules, CI steps, etc.)

**tsconfig `paths` or ambient declarations:**
- Can't solve this problem — the augmentations are project-specific and depend on user-defined types

## Proposal

### Architecture

A VSCode extension (`thinkwell-vscode`) that bundles a TypeScript Language Service plugin (`thinkwell-ts-plugin`). The extension auto-injects the plugin into the TypeScript language service, requiring no manual `tsconfig.json` changes.

```
┌──────────────────────────────────────────────────────────────────┐
│ VSCode                                                           │
│ ┌──────────────────────────────┐  ┌───────────────────────────┐  │
│ │ Thinkwell VSCode Extension   │  │ Built-in TypeScript Ext   │  │
│ │ (activates on thinkwell      │  │ (runs tsserver)           │  │
│ │  projects)                   │  │                           │  │
│ └──────────────────────────────┘  └──────────┬────────────────┘  │
│                                              │                   │
│                                   ┌──────────▼─────────────────┐ │
│                                   │ tsserver                   │ │
│                                   │ ┌────────────────────────┐ │ │
│                                   │ │ thinkwell-ts-plugin    │ │ │
│                                   │ │ (loaded as TS plugin)  │ │ │
│                                   │ └────────────────────────┘ │ │
│                                   └────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### How the TS plugin works

The plugin intercepts TypeScript's language service using the standard decorator pattern (`ts.server.PluginCreateInfo`). It does four things:

#### 1. Virtual declaration injection via `getExternalFiles()`

The plugin uses the `getExternalFiles()` API to register a virtual `.d.ts` file with the TypeScript project. This file contains namespace merge declarations for all `@JSONSchema`-marked types discovered in the project:

```typescript
// Virtual file: __thinkwell_augmentations__.d.ts (never written to disk)

import { SchemaProvider } from "thinkwell";

declare namespace Greeting {
  export const Schema: SchemaProvider<Greeting>;
}

declare namespace Sentiment {
  export const Schema: SchemaProvider<Sentiment>;
}
```

The plugin provides the content of this virtual file by monkey-patching `LanguageServiceHost.getScriptSnapshot()` — when TypeScript asks for the content of `__thinkwell_augmentations__.d.ts`, the plugin returns the dynamically generated declarations.

#### 2. Source scanning for `@JSONSchema` markers

The plugin watches for file changes (via `getSemanticDiagnostics` interception or project update events) and scans TypeScript source files for the `@JSONSchema` JSDoc marker. When it finds marked types, it:

1. Extracts the type name and its exported status
2. Generates a corresponding namespace declaration with a `Schema` property
3. Updates the virtual declaration file
4. Triggers a project update so TypeScript re-checks with the new declarations

This reuses the same pattern-matching logic that the runtime loader uses in `schema.ts` — identifying types marked with `/** @JSONSchema */` via AST traversal.

#### 3. Module resolution for standalone scripts

The `thinkwell` CLI supports standalone scripts (e.g., with a `#!/usr/bin/env thinkwell` shebang) that don't require a `package.json` or `npm install` — the CLI bundles all thinkwell dependencies internally. But without `node_modules/thinkwell`, VSCode reports `Cannot find module 'thinkwell'`.

The plugin solves this by monkey-patching `resolveModuleNameLiterals` on the `LanguageServiceHost`. When it encounters an import of `thinkwell` (or `@thinkwell/acp`, `@thinkwell/protocol`) in a file that has no `node_modules` resolution, it resolves the import to the type declarations bundled with the `thinkwell` CLI installation. The plugin locates the CLI binary (via `which thinkwell` or a configured path) and points TypeScript at its shipped `.d.ts` files.

This uses the same monkey-patching approach as the Svelte and `typescript-plugin-css-modules` plugins for custom module resolution.

#### 4. Diagnostic filtering (defensive)

As a safety net, the plugin filters `getSemanticDiagnostics` to suppress any residual "Property 'Schema' does not exist" errors (code 2339) that reference known `@JSONSchema`-marked types. In practice, the virtual declaration file should prevent these errors from occurring, but the filter provides defense in depth.

### VSCode extension responsibilities

The extension itself (separate from the TS plugin) handles:

1. **Plugin injection:** Uses the `typescript.tsserver.pluginPaths` configuration to load the bundled TS plugin without requiring a `tsconfig.json` `plugins` entry.

2. **Project detection:** Activates when the workspace has `thinkwell` as a dependency in `package.json`, or when files with a `#!/usr/bin/env thinkwell` shebang are detected.

3. **Status bar indicator:** Shows "Thinkwell" in the status bar when the plugin is active, providing feedback that augmentations are being provided.

### What the user experiences

1. Install the VSCode extension (one-time)
2. Open a thinkwell project
3. `Greeting.Schema` just works — completions, type checking, hover info, go-to-definition
4. No generated files, no commands to run, no tsconfig changes

## Technical Risks

### Monkey-patching `LanguageServiceHost`

The TS plugin API officially only wraps `LanguageService`, not `LanguageServiceHost`. Intercepting `getScriptSnapshot()` requires monkey-patching the host object, which is an unofficial pattern. This is the same approach used by:

- [typescript-plugin-css-modules](https://github.com/mrmckeb/typescript-plugin-css-modules)
- [Svelte language tools](https://github.com/sveltejs/language-tools/blob/master/packages/typescript-plugin/src/module-loader.ts)
- Volar's `@volar/typescript` (`decorateLanguageServiceHost.ts`)

It works reliably in practice but is not guaranteed by TypeScript's API contract.

### TypeScript version compatibility

This approach targets TypeScript 5.x and 6.x. **TypeScript 7 (the Go port) will not support this plugin API.** The [tsgo-api-migration](tsgo-api-migration.md) RFD covers the migration strategy. The key mitigation: TypeScript 6.x will be maintained indefinitely with no hard sunset date, providing a long coexistence window.

### Performance

Scanning project files for `@JSONSchema` markers must be fast. The initial implementation should:

- Only scan files that are part of the TypeScript project (not all workspace files)
- Cache scan results and only re-scan files that change
- Use the lightweight regex check (`/@JSONSchema/`) before doing full AST traversal

## Scope and Non-Goals

**In scope:**
- TS plugin that provides virtual declarations for `@JSONSchema` types
- Module resolution for standalone thinkwell scripts (no `node_modules`)
- VSCode extension wrapper that auto-injects the plugin
- Completions, type checking, and hover for `.Schema` members

**Not in scope (for this phase):**
- CodeLens, snippets, or other VSCode-specific features
- Support for editors other than VSCode (the TS plugin would work in any editor that loads tsconfig plugins, but the auto-injection is VSCode-specific)
- `thinkwell run` or `thinkwell build` integration in the extension
- Watch mode or file generation

## References

- [Writing a Language Service Plugin (TypeScript Wiki)](https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin)
- [getExternalFiles API discussion](https://github.com/microsoft/TypeScript/issues/29706)
- [remove-uri-scheme](remove-uri-scheme.md) — prerequisite RFD
- [tsgo-api-migration](tsgo-api-migration.md) — follow-up RFD for TypeScript 7 migration
