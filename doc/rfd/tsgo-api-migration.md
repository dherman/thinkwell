# RFD: Migrate to `tsgo` IPC API

**Depends on:** [vscode-ts-plugin](vscode-ts-plugin.md), [node-ux](node-ux.md), [check-command](check-command.md)

## Summary

Migrate all three Thinkwell consumers of the TypeScript compiler API — the **VSCode extension**, **`thinkwell check`**, and **`thinkwell build`** — from the TypeScript 5.x/6.x JavaScript API to the new `tsgo` IPC-based API. TypeScript 7 (the Go port) discontinues both the Language Service Plugin API used by the VSCode extension and the `CompilerHost` API used by the CLI commands. The `tsgo` API provides `callbackfs`, a callback-based virtual filesystem over IPC, which replaces both mechanisms with a single sanctioned approach.

This RFD is forward-looking. The `tsgo` API is in early prototype as of February 2026. The timeline for this migration depends on API stabilization, but the architectural direction is clear and the necessary primitives are being built.

## Background

### The TypeScript 7 Transition

TypeScript is being rewritten in Go (codename "Corsa"). TypeScript 7.0 ships mid-March 2026 alongside TypeScript 6.0 (the final JavaScript-based release):

| Version | Language | Editor service | Plugin API |
|---|---|---|---|
| TypeScript 5.x/6.x | JavaScript | tsserver (custom protocol) | TS Language Service Plugin (JS-based) |
| TypeScript 7.x | Go | `tsgo` (native LSP) | IPC-based API (new) |

The existing TS plugin API is fundamentally incompatible with the Go binary — there is no way to load JavaScript plugin code into a compiled Go process. This affects every framework that extends TypeScript: Vue/Volar, Svelte, Angular, and Thinkwell.

Similarly, the `CompilerHost` interface used by `thinkwell check` and `thinkwell build` to serve `@JSONSchema`-transformed source from memory (see [node-ux](node-ux.md), [check-command](check-command.md)) is a TypeScript JavaScript API that does not exist in `tsgo`. The `callbackfs` mechanism replaces both the plugin API and `CompilerHost` with the same IPC-based virtual filesystem abstraction.

### The Coexistence Window

TypeScript 6.x will be maintained indefinitely with no hard sunset date. Users can run both versions side-by-side: TypeScript 6.x for tooling that needs the old API, and `tsgo` for fast type-checking. This provides a long runway for migration, but the direction is clear — the Go port is the future.

### Current State of the `tsgo` API

Two merged PRs establish the foundation:

**[PR #711](https://github.com/microsoft/typescript-go/pull/711): IPC API scaffold**
- Synchronous Node.js client communicating with `tsgo` over STDIO
- AST access, symbol resolution, type queries via opaque object handles
- Two packages: `@typescript/ast` (node definitions) and `@typescript/api` (client)

**[PR #2620](https://github.com/microsoft/typescript-go/pull/2620): Async API and LSP integration**
- `custom/initializeAPISession` LSP command — a VSCode extension can request an API connection to the running `tsgo` language server
- The API session shares the same type checker state as the editor's LSP session
- `callbackfs` — a callback-based virtual filesystem over IPC, implementing `ReadFile`, `FileExists`, `DirectoryExists`, `GetAccessibleEntries`, and `Realpath`
- Explicitly positioned as "the beginnings of a path toward replacing TS Server plugins"

## The `callbackfs` Mechanism

This is the key primitive for Thinkwell's migration. When `tsgo` needs to read a file, `callbackfs` intercepts the read and delegates to the IPC client:

```
tsgo language server                    Thinkwell extension
        │                                       │
        │  ReadFile("project/greeting.ts")      │
        ├──────────────────────────────────────►│
        │                                       │
        │  Returns: original source             │
        │◄──────────────────────────────────────┤
        │                                       │
        │  FileExists("__thinkwell__.d.ts")     │
        ├──────────────────────────────────────►│
        │                                       │
        │  Returns: true                        │
        │◄──────────────────────────────────────┤
        │                                       │
        │  ReadFile("__thinkwell__.d.ts")       │
        ├──────────────────────────────────────►│
        │                                       │
        │  Returns: generated namespace decls   │
        │◄──────────────────────────────────────┤
```

The extension controls what files `tsgo` sees. It can:

1. **Provide virtual declaration files** that don't exist on disk — making `@JSONSchema` namespace merges visible to the type checker
2. **Present transformed source files** if needed — though for Thinkwell's current needs, virtual declarations are sufficient
3. **Make virtual files appear in directory listings** via `GetAccessibleEntries`, so `tsgo` includes them in the project

This achieves the same result as the TS plugin's `getExternalFiles()` + `getScriptSnapshot()` monkey-patching, but through an officially supported, stable API designed for exactly this use case.

## Three Consumers, One Migration

Thinkwell has three consumers of TypeScript's programmatic APIs, each using a different interface today but all converging on `callbackfs` in TypeScript 7:

| Consumer | Current API (TS 5.x/6.x) | `tsgo` replacement | Transport |
|---|---|---|---|
| VSCode extension | TS Language Service Plugin | `callbackfs` via LSP session | IPC to running `tsgo` language server |
| `thinkwell check` | `CompilerHost.getSourceFile()` | `callbackfs` via `@typescript/api` | IPC to spawned `tsgo api` process |
| `thinkwell build` | `CompilerHost.getSourceFile()` + `program.emit()` | `callbackfs` via `@typescript/api` | IPC to spawned `tsgo api` process |

All three use the same underlying mechanism — intercepting file reads to serve `@JSONSchema`-transformed source — but through different transports. The IDE connects to a running `tsgo` language server; the CLI commands spawn a `tsgo api` child process.

## Proposed Architecture

### VSCode Extension

```
┌──────────────────────────────────────────────────────────────────┐
│ VSCode                                                           │
│ ┌──────────────────────────────┐  ┌───────────────────────────┐  │
│ │ Thinkwell VSCode Extension   │  │ TypeScript (Native) Ext   │  │
│ │                              │  │ (runs tsgo as LSP)        │  │
│ │ 1. Calls custom/initialize-  │  │                           │  │
│ │    APISession                │  └──────────┬────────────────┘  │
│ │ 2. Registers callbackfs      │             │                   │
│ │    handlers                  │   ┌─────────▼─────────────────┐ │
│ │ 3. Provides virtual .d.ts    ├──►│ tsgo (native LSP server)  │ │
│ │    content on ReadFile       │   │                           │ │
│ │ 4. Scans for @JSONSchema     │   │ callbackfs delegates      │ │
│ │    markers                   │   │ file reads to extension   │ │
│ └──────────────────────────────┘   └───────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

#### Extension lifecycle

1. **Activation:** The extension activates when a workspace contains `thinkwell` as a dependency.

2. **API session:** The extension calls the `custom/initializeAPISession` LSP command on the `tsgo` language server, receiving a connection (Unix domain socket or named pipe) to an API session that shares the live type checker state.

3. **Filesystem callbacks:** The extension registers `callbackfs` handlers. For most files, it passes through to the real filesystem. For the virtual `__thinkwell_augmentations__.d.ts`, it returns dynamically generated namespace declarations.

4. **Source scanning:** Same as the TS plugin approach — scan project files for `@JSONSchema` markers, generate corresponding namespace merge declarations.

5. **State adoption:** When files change, the extension uses `AdoptLSPState` to pick up the latest type checker snapshot, re-scans affected files, and updates the virtual declarations.

#### Dual-version support

During the coexistence period, the extension should support both TypeScript versions:

- **TypeScript ≤6.x (tsserver):** Use the TS Language Service Plugin from [vscode-ts-plugin](vscode-ts-plugin.md)
- **TypeScript 7+ (tsgo):** Use the `callbackfs` API described here

The extension detects which TypeScript version is active and uses the appropriate mechanism. This is the same pattern that VSCode's own TypeScript extension will need to manage during the transition.

### CLI Commands (`thinkwell check` and `thinkwell build`)

```
┌─────────────────────────────────────────────────────────────┐
│ thinkwell check / thinkwell build                            │
│                                                              │
│  1. Spawn tsgo api as child process (via @typescript/api)    │
│  2. Load project (tsconfig.json)                             │
│  3. Register callbackfs handlers:                            │
│     • ReadFile: apply @JSONSchema transformation in memory   │
│     • FileExists / DirectoryExists: delegate to real FS      │
│  4. Request diagnostics (check) or emit (build)              │
│  5. Stream results to terminal                               │
│                                                              │
│  thinkwell CLI              tsgo api (child process)         │
│       │                           │                          │
│       │  register callbackfs      │                          │
│       ├─────────────────────────►│                           │
│       │                           │                          │
│       │  ReadFile("src/types.ts") │                          │
│       │◄─────────────────────────┤                           │
│       │                           │                          │
│       │  transformed source       │                          │
│       ├─────────────────────────►│                           │
│       │                           │                          │
│       │  diagnostics / emit       │                          │
│       │◄─────────────────────────┤                           │
└─────────────────────────────────────────────────────────────┘
```

#### Migration from CompilerHost

Today, `thinkwell check` and `thinkwell build` use TypeScript's `CompilerHost` interface to intercept `getSourceFile()` and serve `@JSONSchema`-transformed source in memory (see [node-ux](node-ux.md), [check-command](check-command.md)). The migration replaces this with `callbackfs`:

| CompilerHost method | `callbackfs` equivalent |
|---|---|
| `getSourceFile(fileName)` → transform and return | `ReadFile(fileName)` → transform and return |
| `fileExists(fileName)` | `FileExists(fileName)` |
| `directoryExists(dirName)` | `DirectoryExists(dirName)` |
| `readFile(fileName)` | `ReadFile(fileName)` |
| `readDirectory(...)` | `GetAccessibleEntries(dirName)` |
| `realpath(path)` | `Realpath(path)` |

The surface area is nearly identical — both are filesystem virtualization interfaces. The key difference is transport: `CompilerHost` methods are in-process function calls; `callbackfs` methods are IPC messages. The `@JSONSchema` transformation logic (`transformJsonSchemas()` from `schema.ts`) is unchanged; only the plumbing around it changes.

#### Check vs. build

The two commands differ only in what they request after type checking:

- **`thinkwell check`:** Request diagnostics only (equivalent to today's `getPreEmitDiagnostics()` with `--noEmit`)
- **`thinkwell build`:** Request diagnostics and then emit (equivalent to today's `program.emit()`)

The `tsgo` IPC API will need to support both operations. Diagnostics queries are listed as "not yet available" in the current API, but are expected — they're fundamental to any type-checking tool.

#### Dual-version support for CLI

During the coexistence period, the CLI commands should support both TypeScript versions:

- **TypeScript ≤6.x:** Use the `CompilerHost` approach (current implementation)
- **TypeScript 7+:** Use `@typescript/api` with `callbackfs`

The CLI can detect which TypeScript version is available and choose the appropriate path. Since the `@JSONSchema` transformation logic is shared, only the compiler invocation layer needs to be swapped.

## What's Not Yet Available

The `tsgo` API is explicitly described as "early prototype quality." Key gaps as of February 2026:

| Capability | Status | Impact on VSCode extension | Impact on CLI commands |
|---|---|---|---|
| `callbackfs` (virtual files) | Merged (PR #2620) | Core mechanism — available | Core mechanism — available |
| `custom/initializeAPISession` | Merged (PR #2620) | Entry point — available | Not used (CLI spawns `tsgo api` directly) |
| `AdoptLSPState` (state sync) | Merged (PR #2620) | Needed for reactivity — available | Not needed (no persistent session) |
| Diagnostics query | Not yet | Low impact — tsgo computes diagnostics from declarations | **Blocking** — `thinkwell check` needs to retrieve diagnostics |
| Emit / output generation | Not yet | Not needed | **Blocking** — `thinkwell build` needs to produce .js/.d.ts output |
| Completions query | Not yet | Low impact — tsgo computes completions from declarations | Not needed |
| "Proper hooks" for framework integration | Acknowledged, not designed | May not be needed | May not be needed |

For the **VSCode extension**, the critical observation still holds: Thinkwell's approach of providing virtual declaration files does not require diagnostics or completions hooks. We provide the type information; TypeScript's own language service computes the IDE features from it. The primitives we need — `callbackfs`, API session creation, and state adoption — are already merged.

For the **CLI commands**, the situation is different. `thinkwell check` needs to retrieve diagnostics from the `tsgo` API, and `thinkwell build` needs to trigger emit. Both are listed as "not yet available." These are fundamental operations that the `tsgo` API will certainly support eventually — they're core to any programmatic use of a compiler — but they block the CLI migration until they ship.

## Open Questions

### API stability timeline

The `tsgo` API is in active development with no stability guarantees. When should we start building against it? Options:

- **Aggressive:** Start now, accept API churn, be an early adopter and provide feedback
- **Conservative:** Wait for an official beta/stability signal, rely on the TS 6.x plugin in the meantime
- **Middle ground:** Build a proof-of-concept now to validate the approach, defer production use until API stabilizes

### Virtual file discovery

How does `tsgo` discover that `__thinkwell_augmentations__.d.ts` should be part of the project? Options:

- The `callbackfs` `GetAccessibleEntries` callback could include it in directory listings
- There may be an API method to register additional files with the project (analogous to `getExternalFiles()`)
- We may need to include it via a `/// <reference>` directive or tsconfig `include` pattern

This depends on `tsgo` API details that may not be finalized yet.

### IPC performance for file reads

Every file read goes through IPC. For most files, the extension will just pass through to the real filesystem, adding latency. Is there a way to only intercept specific files? The `callbackfs` design may support selective interception (only intercepting reads for files that match a pattern), or it may require the extension to handle all reads.

This is especially relevant for the CLI commands, where startup latency matters. Today, the CompilerHost approach has zero IPC overhead — `getSourceFile()` is an in-process function call. The `callbackfs` migration adds IPC round-trips for every file read. For a project with hundreds of source files, the cumulative latency could be noticeable. Benchmarking will be needed once the API is available.

### CLI process lifecycle

For the CLI commands, what is the expected lifecycle of a `tsgo api` process? Options:

- **One-shot:** Spawn `tsgo api`, load the project, get diagnostics/emit, exit. Simple but incurs startup cost on every invocation.
- **Persistent daemon:** Spawn `tsgo api` once and reuse across multiple `thinkwell check` invocations (similar to how `tsc --watch` keeps the compiler alive). Lower latency but more complex process management.

The one-shot model is simpler and matches the current `thinkwell check` behavior. The persistent model would benefit `thinkwell check --watch` and repeated invocations during development.

## Timeline Considerations

| Milestone | Estimated timing |
|---|---|
| TypeScript 7.0 ships | Mid-March 2026 |
| `tsgo` API stabilizes for virtual file use cases | Unknown — depends on framework adoption pressure |
| Diagnostics and emit available in `tsgo` API | Unknown — blocks CLI migration |
| Thinkwell VSCode extension proof-of-concept | After `callbackfs` API reaches beta quality |
| Thinkwell CLI proof-of-concept | After diagnostics/emit are available in `tsgo` API |
| Thinkwell production migration | After API stability guarantee |
| TS 6.x plugin / CompilerHost deprecation | When `tsgo` API has proven stable for ≥1 release cycle |

The VSCode extension can be migrated first, since the primitives it needs (`callbackfs`, API sessions, state adoption) are already merged. The CLI commands must wait for diagnostics and emit support.

The TS 6.x plugin and `CompilerHost` approach provide working solutions during the entire transition. There is no urgency to migrate before the `tsgo` API is ready.

## References

- [RFD: Node-Native Developer Experience](node-ux.md) — `thinkwell build` CompilerHost architecture
- [RFD: `thinkwell check` Command](check-command.md) — `thinkwell check` CompilerHost architecture
- [RFD: VSCode Extension with TypeScript Plugin](vscode-ts-plugin.md) — the TS 5.x/6.x IDE approach this migrates from
- [RFD: Remove `thinkwell:*` URI Scheme](remove-uri-scheme.md) — prerequisite for all approaches
- [PR #711: Scaffold IPC-based API](https://github.com/microsoft/typescript-go/pull/711)
- [PR #2620: Async API and LSP integration](https://github.com/microsoft/typescript-go/pull/2620)
- [Discussion #455: What is the API story?](https://github.com/microsoft/typescript-go/discussions/455)
- [Announcing TypeScript Native Previews](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/#api-progress)
- [Progress on TypeScript 7 — December 2025](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)
- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) — the TS 5.x/6.x `CompilerHost` API being replaced
- [`@typescript/vfs`](https://www.npmjs.com/package/@typescript/vfs) — official virtual filesystem for CompilerHost
