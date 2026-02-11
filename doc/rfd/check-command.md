# RFD: `thinkwell check` Command

- **Depends on:** [remove-uri-scheme](remove-uri-scheme.md)
- **Implementation:** [PR #30](https://github.com/dherman/thinkwell/pull/30)

## Summary

This document proposes a new `thinkwell check` command that performs type checking on a thinkwell project without producing any output files. Inspired by `cargo check` in Rust, the goal is to give developers the fastest possible feedback loop for catching type errors during development.

The command uses the TypeScript compiler API with a custom `CompilerHost` that serves `@JSONSchema`-transformed source from memory. This is the same CompilerHost shared with `thinkwell build` (see [node-ux](node-ux.md)), but invoked with `--noEmit` to skip producing output files.

## Motivation

### The Problem

During development, the primary question a developer asks after editing code is: **"Did I break anything?"** The answer to this question is dominated by type errors — mismatched interfaces, missing properties, incorrect return types, etc.

Today, the fastest way to answer this question in a thinkwell project is `pnpm build`, which runs `tsc` and produces JavaScript output in `dist/`. This works, but it does unnecessary work: the developer doesn't need the `.js`, `.d.ts`, and `.js.map` files just to know if their types are correct. On larger projects, skipping emit can be meaningfully faster.

### Analogy: `cargo check`

Rust's `cargo check` is one of the most-used developer commands in the ecosystem. It runs the compiler's analysis passes (parsing, name resolution, type checking, borrow checking) but skips code generation and linking. This makes it significantly faster than `cargo build` for the most common development task: "does my code typecheck?"

TypeScript offers the same escape hatch via `tsc --noEmit`, which skips generating `.js`, `.d.ts`, and source map files.

### Use Cases

1. **Rapid iteration** — Check types after a quick edit without waiting for full emit. Especially valuable in larger projects where declaration and source map generation add overhead.

2. **CI gating** — Run type checking as a fast, early CI step before slower build and test stages. A failing `thinkwell check` can fail the pipeline in seconds rather than minutes.

3. **Editor-independent checking** — Not all editors have robust TypeScript language server integration. `thinkwell check` provides a reliable command-line alternative that uses the same configuration as the build.

4. **Pre-commit hooks** — A fast type check is ideal for pre-commit hooks where developers don't want to wait for a full build.

### Design Goals

- **Minimal** — Do one thing well: run the type checker and report errors.
- **Fast** — Skip all unnecessary work (emit, declaration generation, source maps).
- **Familiar** — Follow conventions from `cargo check` and `tsc --noEmit`.
- **Consistent** — Use the same `tsconfig.json` configuration as `thinkwell build`, so type checking results are never surprising.

## Proposal

### Basic Usage

```bash
# Check the current project (single-package project)
thinkwell check

# Check all packages in a workspace (from workspace root)
thinkwell check

# Check a specific package by name
thinkwell check --package @thinkwell/acp
thinkwell check -p acp                     # short name also works

# Check multiple specific packages
thinkwell check -p @thinkwell/acp -p @thinkwell/protocol
```

### Command-Line Interface

```
thinkwell check [options]

Options:
  -p, --package <name>   Check a specific workspace package by name
                          (can be specified multiple times)
  --pretty               Enable colorized output (default: true if TTY)
  --no-pretty            Disable colorized output
  -h, --help             Show help message
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | No type errors |
| 1 | Type errors found |
| 2 | Configuration error (e.g., tsconfig.json not found) |

### Package Name Resolution

The `--package` flag accepts either a full package name or a short name:

| `--package` value | Matches |
|-------------------|---------|
| `@thinkwell/acp` | Exact match on `"name"` in `package.json` |
| `acp` | Matches `@thinkwell/acp` (or any package whose name ends with `/acp`) |
| `thinkwell` | Matches the `thinkwell` package (exact match) |

**Ambiguity:** If a short name matches multiple packages, `thinkwell check` exits with code 2 and lists the matches, asking the user to use the full name.

### Example Output

**Single package (success):**
```
$ thinkwell check
  Checking thinkwell...
  No type errors found.
```

**Workspace (all packages):**
```
$ thinkwell check
  Checking @thinkwell/protocol... ok
  Checking @thinkwell/acp... ok
  Checking @thinkwell/conductor... ok
  Checking thinkwell... ok

  All 4 packages passed.
```

**Workspace (failure in one package):**
```
$ thinkwell check
  Checking @thinkwell/protocol... ok
  Checking @thinkwell/acp...

  src/extensions.ts(42,5): error TS2345: Argument of type 'string' is not
    assignable to parameter of type 'number'.

  Checking @thinkwell/conductor... ok
  Checking thinkwell...

  src/index.ts(18,3): error TS2741: Property 'name' is missing in type
    '{}' but required in type 'AgentConfig'.

  2 of 4 packages had errors.
```

**Specific package:**
```
$ thinkwell check -p acp
  Checking @thinkwell/acp...
  No type errors found.
```

## Architecture

### The `@JSONSchema` Challenge

After the [removal of the `thinkwell:*` URI scheme](remove-uri-scheme.md), thinkwell user scripts use standard npm package imports (`"thinkwell"`, `"@thinkwell/acp"`) that TypeScript resolves natively. The one remaining language extension that standard `tsc` cannot process directly is:

**`@JSONSchema` code generation** — The `@JSONSchema` JSDoc tag on a type like `interface Greeting { ... }` triggers code injection that generates a companion namespace with a `Schema` property. User code then references `Greeting.Schema` at runtime. Since this namespace doesn't exist in the source, `tsc --noEmit` produces: `Property 'Schema' does not exist on type 'Greeting'`.

This extension is fundamental to the thinkwell developer experience — it appears in every example and most user projects. A `thinkwell check` that can't handle it would be useless for the primary audience.

### Always Use the Programmatic Path

One approach would be to try to detect whether a package uses `@JSONSchema` and only use the custom CompilerHost when needed. But this detection is inherently fragile — it would require scanning source files for `@JSONSchema` tags before type checking even begins, or guessing based on heuristics like `package.json` dependencies.

Instead, `thinkwell check` always uses the programmatic TypeScript compiler API with the custom CompilerHost. The CompilerHost is a superset of standard behavior: for files that don't contain `@JSONSchema`, it behaves identically to the default host — the transformation is a no-op pass-through. For a standard TypeScript package without `@JSONSchema`, the result is the same as `tsc --noEmit` — just invoked via the API rather than the CLI.

### `@JSONSchema` Transformation Strategy

To type-check user scripts that use `@JSONSchema`, the CompilerHost intercepts `getSourceFile()` and injects namespace declarations in memory. For a type like:

```typescript
/** @JSONSchema */
export interface Greeting {
  message: string;
}
```

The CompilerHost serves a transformed version that includes the companion namespace:

```typescript
import type * as $$__thinkwell__acp__$$ from "@thinkwell/acp";

/** @JSONSchema */
export interface Greeting {
  message: string;
}
namespace Greeting {
  export const Schema: $$__thinkwell__acp__$$.SchemaProvider<Greeting> = ...;
}
```

This reuses the existing `transformJsonSchemas()` from `schema.ts` — the same transformation the CLI loader applies at runtime. The CompilerHost serves the transformed source from the original file path, so TypeScript sees valid code without any intermediate files on disk. See the [Node UX RFD](node-ux.md) for the full CompilerHost architecture.

### Implementation Strategy

`thinkwell check` uses the TypeScript compiler API programmatically with a custom `CompilerHost` that injects `@JSONSchema` namespace declarations via `getSourceFile()`. This single path works for all packages — those with `@JSONSchema` and those without.

```
thinkwell check [-p <package>...]
        │
        ▼
  Detect workspace (npm or pnpm)
        │
        ├── Workspace root + no --package  ──► check all packages
        ├── Workspace root + --package     ──► resolve named packages
        └── Non-workspace (single project) ──► check cwd
        │
        ▼  (for each package)
  Resolve tsconfig.json in package directory
        │
        ▼
  Use TypeScript compiler API with custom CompilerHost
    • Inject @JSONSchema namespace declarations where needed
    • Run getPreEmitDiagnostics() with --noEmit
        │
        ▼
  Stream diagnostics to terminal
        │
        ▼
  Exit 0 if all packages pass, 1 if any had errors
```

### Workspace Detection

`thinkwell check` detects workspaces by examining the current working directory:

1. **pnpm workspaces** — Look for `pnpm-workspace.yaml` in cwd. Parse the `packages` array to get glob patterns (e.g., `["packages/*", "examples"]`). Expand globs to find package directories.

2. **npm workspaces** — Look for `"workspaces"` key in `package.json` in cwd. Parse the array of glob patterns (e.g., `["packages/*"]`). Expand globs to find package directories.

3. **Single project** — If neither is found, treat cwd as a single-package project.

When a workspace is detected, each matched directory is scanned for a `package.json` to read the package `"name"` field, and for a `tsconfig.json` to confirm it's a TypeScript package. Directories without a `tsconfig.json` are silently skipped (they may be non-TypeScript packages).

**Detection priority:** If both `pnpm-workspace.yaml` and `package.json` `"workspaces"` exist (unusual but possible), prefer the pnpm configuration since pnpm ignores the npm `"workspaces"` field and uses its own config.

### Package Resolution

When `--package <name>` is specified:

1. Detect the workspace as described above.
2. Build a map of package name to directory by reading `package.json` in each workspace member.
3. Try exact match on the full package name (e.g., `@thinkwell/acp`).
4. If no exact match, try matching the short name against the last segment of scoped package names (e.g., `acp` matches `@thinkwell/acp`).
5. If the short name is ambiguous (matches multiple packages), exit with code 2 and list the matches.
6. If no match is found, exit with code 2 and list available package names.

If `--package` is used but no workspace is detected, exit with code 2:
```
Error: --package can only be used in a workspace.
No pnpm-workspace.yaml or package.json "workspaces" found in current directory.
```

### tsconfig.json Resolution

For each package being checked, `thinkwell check` looks for `tsconfig.json` in the package's directory. If no `tsconfig.json` is found in a package:

- **When checking all packages** (no `--package` flag): silently skip the package. This is expected for non-TypeScript workspace members.
- **When checking a specific package** (`--package` given): exit with code 2 and report that the package has no `tsconfig.json`.

### TypeScript Dependency

Since `thinkwell check` uses the TypeScript compiler API directly (not the `tsc` CLI), it depends on the `typescript` npm package being importable. TypeScript is already a runtime dependency of the `thinkwell` package (used for `@JSONSchema` processing via `ts-json-schema-generator`), so no additional installation is needed when thinkwell is installed via npm.

For the compiled binary distribution, TypeScript is bundled into the binary alongside thinkwell's other dependencies, so the programmatic API is available without any extraction or download step.

## Relationship to Existing Commands

### `thinkwell build`

`thinkwell build` (see [node-ux](node-ux.md)) uses the same custom CompilerHost as `thinkwell check`, but with emit enabled — it produces `.js`, `.d.ts`, and source map output in the project's `outDir`. Both commands share the same CompilerHost infrastructure; the only difference is whether `program.emit()` is called.

`thinkwell check` is the fast-feedback counterpart to `thinkwell build`: it verifies type correctness without producing any artifacts.

### `thinkwell bundle`

`thinkwell bundle` compiles a user script into a standalone executable (esbuild + pkg). It does **not** run `tsc` and does **not** check types. Developers would typically run `thinkwell check` during development and `thinkwell bundle` when ready to produce a distributable binary.

### `pnpm build` / `npm run build` (monorepo development)

For monorepo development, `pnpm build` (or `npm run build`) typically runs `tsc` across all packages, producing JavaScript output. `thinkwell check` provides a faster alternative when you only need type correctness feedback: it detects the workspace configuration, finds all TypeScript packages, and type-checks each with the CompilerHost — no emitted files, no `dist/` directories to clean up.

## Trade-offs

### Advantages

| Aspect | Benefit |
|--------|---------|
| Speed | Skipping emit is faster than full `tsc`, especially for projects with declaration generation |
| Workspace awareness | Automatically detects npm/pnpm workspaces and checks all packages with a single command |
| Unified path | Single CompilerHost implementation handles both standard packages and user scripts with `@JSONSchema` |
| Consistency | Uses same tsconfig.json as build; no divergent configuration |
| Familiarity | Follows `cargo check` pattern known to Rust developers |

### Disadvantages

| Aspect | Impact |
|--------|--------|
| Complexity | User scripts require a custom CompilerHost to handle `@JSONSchema` namespace injection; this is more than a simple `tsc` wrapper |
| Redundancy | For library packages, users who already know `tsc --noEmit` may not see the value |

### Why Not Just `tsc --noEmit`?

A reasonable question. The value of `thinkwell check` over raw `tsc --noEmit` is:

1. **`@JSONSchema` support** — `tsc --noEmit` fails on user scripts that use `@JSONSchema` code generation because the injected namespaces don't exist in the source. `thinkwell check` handles this transparently by injecting namespace declarations via the CompilerHost before type checking.
2. **Workspace awareness** — A single `thinkwell check` from the workspace root checks all packages. `tsc --noEmit` only checks one `tsconfig.json` at a time, requiring manual iteration or a separate script.
3. **Discoverability** — New thinkwell users see `check` in the help output alongside `build` and `run`, forming a coherent command vocabulary.
4. **Correct defaults** — Automatically locates the right `tsconfig.json` and applies `--noEmit` without the user needing to remember flags.
5. **Future extensibility** — As thinkwell grows, `check` can incorporate additional validation (e.g., `@JSONSchema` correctness, conductor protocol compliance) beyond what `tsc` alone provides.
6. **Compiled binary support** — When running from a compiled thinkwell binary, there is no `tsc` on `PATH`. `thinkwell check` handles this transparently.

## Alternatives Considered

### Alternative 1: Add `--check` Flag to `thinkwell build`

**Description:** Instead of a separate command, add a `--check` flag to `thinkwell build` that skips the build and only type-checks.

**Pros:** No new command to learn; fewer top-level commands.
**Cons:** Conflates two distinct operations; `build --check` is confusing because "build" implies producing output. `cargo` deliberately made `check` a separate command rather than `build --check` for this reason.

### Alternative 2: Integrate Type Checking into `thinkwell run`

**Description:** Automatically type-check before running scripts.

**Pros:** Catches errors before runtime.
**Cons:** Adds latency to every script invocation; users who want fast iteration can use their editor's language server. This should be opt-in at most, not the default.

### Alternative 3: Do Nothing

**Description:** Document `tsc --noEmit` in the thinkwell docs and let users run it directly.

**Pros:** Zero implementation effort.
**Cons:** Doesn't work for user scripts that use `@JSONSchema` — which is most thinkwell user code. Also misses workspace awareness, compiled-binary support, and discoverability.

## Future Evolution

### Deep `@JSONSchema` validation

This RFD handles `@JSONSchema` at the type level: it injects ambient namespace declarations so that references like `Greeting.Schema` type-check correctly. But it doesn't validate that the annotated types are actually compatible with JSON Schema generation (e.g., no functions, no circular references that `ts-json-schema-generator` can't handle).

In the future we could add deeper validation by actually running `ts-json-schema-generator` against annotated types and surfacing its errors as diagnostics. This could be exposed as `thinkwell check --schemas` or folded into the default behavior once it's fast enough.

### Parallel workspace checking

Sequential checking keeps output clear but leaves performance on the table for large workspaces. A future phase could check packages in parallel with output buffering — printing each package's results as a complete block once it finishes.

### TypeScript project references and incremental checking

TypeScript [project references](https://www.typescriptlang.org/docs/handbook/project-references.html) (`tsc --build --noEmit`) let the compiler understand the dependency graph across a monorepo. With project references, `tsc` can skip re-checking packages whose inputs haven't changed, and it builds packages in topological order automatically. This would reduce the need for `--package` as a manual scoping mechanism — users could just run `thinkwell check` and let incremental logic handle the rest.

For now, the workspace-based approach with `--package` is simpler and doesn't require users to set up `composite: true` or `references` arrays in their tsconfig files. Project references could be explored as an optimization path if monorepo check times become a pain point.

### Conductor protocol compliance

As the conductor protocol matures, `thinkwell check` could validate that agent implementations conform to the protocol's type contracts beyond what TypeScript's structural type system catches (e.g., required capability registrations, message handler completeness).

## References

- [RFD: Remove `thinkwell:*` URI Scheme](./remove-uri-scheme.md)
- [RFD: Node-Native Developer Experience](./node-ux.md)
- [RFD: `thinkwell bundle` Command](./user-build-command.md)
- [RFD: Migrate Binary Distribution from Bun to pkg](./pkg-migration.md)
- [`cargo check` documentation](https://doc.rust-lang.org/cargo/commands/cargo-check.html)
- [TypeScript `--noEmit` compiler option](https://www.typescriptlang.org/tsconfig#noEmit)
- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [`@typescript/vfs`](https://www.npmjs.com/package/@typescript/vfs) — Official virtual filesystem for TypeScript CompilerHost
