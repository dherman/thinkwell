# RFD: Bundled Type Declarations for Standalone Scripts

- **Depends on:** [vscode-ts-plugin](completed/vscode-ts-plugin.md), [cli-distribution](completed/cli-distribution.md)
- **Issue:** [#59](https://github.com/dherman/thinkwell/issues/59)

## Summary

Bundle thinkwell's `.d.ts` type declarations into the VSCode TS plugin so that standalone scripts get module resolution without depending on an npm-installed CLI.

## Background

The TS plugin provides module resolution for standalone thinkwell scripts (files with `#!/usr/bin/env thinkwell` that have no `node_modules`). When TypeScript can't resolve an `import { open } from "thinkwell"`, the plugin's `standalone-resolver.ts` kicks in:

1. Runs `which thinkwell` to find the CLI binary
2. Resolves symlinks to get the real path
3. Walks up to find a `package.json` with `name: "thinkwell"`
4. Reads the `types` field to locate `.d.ts` files
5. Returns the resolved path to TypeScript

This worked when thinkwell was installed via npm (`npm install -g thinkwell`), which creates a standard npm package layout with `package.json`, `dist/index.d.ts`, etc.

### What broke

Thinkwell is now distributed as a compiled binary via Homebrew. The Homebrew installation at `/opt/homebrew/Cellar/thinkwell/<version>/bin/thinkwell` is a standalone Mach-O executable — no `package.json`, no `dist/` directory, no `.d.ts` files. Step 3 above fails, and module resolution falls back to the default, which reports `Cannot find module 'thinkwell'`.

## Problem Statement

Standalone scripts need type declarations for `thinkwell`, `@thinkwell/acp`, and `@thinkwell/protocol` to get IDE support. The current approach of locating declarations on disk is fragile because it couples the TS plugin to the CLI's installation layout, which varies by distribution channel (npm, Homebrew, local dev).

## Proposal

Embed the thinkwell type declarations directly into the TS plugin at build time. The plugin already uses virtual files for `@JSONSchema` augmentations — this extends the same technique to the thinkwell module declarations.

### How it works

1. **At plugin build time:** A build step reads the `.d.ts` files for `thinkwell`, `@thinkwell/acp`, and `@thinkwell/protocol` and embeds them as string constants (or imports them as raw text) into the plugin bundle.

2. **At runtime (module resolution):** When `resolveModuleNameLiterals` intercepts an unresolved thinkwell import in a standalone script, instead of searching the filesystem, it resolves to a virtual file path (e.g., `__thinkwell_types__/thinkwell/index.d.ts`).

3. **At runtime (file content):** The existing `getScriptSnapshot` patch is extended to serve the embedded declaration content when TypeScript requests the virtual type file.

### Resolution order

The plugin already checks whether normal TypeScript resolution succeeded before activating custom resolution (line 240 of `standalone-resolver.ts`). This means:

- **Explicit-config projects** (thinkwell in `package.json` dependencies): Normal resolution finds the types in `node_modules`. The plugin does nothing.
- **Standalone scripts** (shebang, no `node_modules`): Normal resolution fails. The plugin serves the bundled declarations.

No change to the resolution order is needed — the fallback just becomes self-contained instead of searching for an npm installation.

### What to remove

The `locateInstallation()` function and its `which thinkwell` + symlink-chasing logic can be removed entirely. It was only needed because the declarations lived on disk. With bundled declarations, there's no external dependency to locate.

### Build integration

The `vscode-ts-plugin` package's esbuild config needs a step to inline the `.d.ts` content. Options include:

- An esbuild plugin that reads `.d.ts` files and exposes them as string exports
- A codegen script that writes a `generated/type-snapshots.ts` file before the main build

The declarations come from sibling packages in the monorepo (`packages/thinkwell`, `packages/acp`, `packages/protocol`), so they're always available at build time.

## Trade-offs

**Advantages:**
- Zero-config: works regardless of how thinkwell is installed (Homebrew, npm, local dev, not installed at all)
- No filesystem probing or `which` subprocess at plugin startup
- Simpler code — removes the installation-locator machinery

**Disadvantages:**
- Type declarations are frozen at extension build/release time — if the thinkwell API changes, users need to update the extension. However, this only affects zero-config standalone scripts, and is inherently unavoidable: without a `package.json` pinning a version, the script is already coupled to whatever version of thinkwell happens to be installed on the user's system. The extension version is just another part of that ambient environment.

## Scope

**In scope:**
- Embedding `.d.ts` content for `thinkwell`, `@thinkwell/acp`, `@thinkwell/protocol` in the plugin bundle
- Serving them via virtual file snapshots for standalone scripts
- Removing the `locateInstallation` / `which thinkwell` machinery

**Not in scope:**
- Changes to explicit-config project resolution (already works via `node_modules`)
- Changes to the `@JSONSchema` augmentation system
- Shipping `.d.ts` files in the Homebrew formula
