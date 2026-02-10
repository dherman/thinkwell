# RFD: Remove `thinkwell:*` URI Scheme

**Implementation:** [PR #28](https://github.com/dherman/thinkwell/pull/28)

## Summary

Replace the custom `thinkwell:*` import URI scheme with standard npm package imports and redesign the agent connection API. The new `open()` function accepts a named agent string (like `'claude'` or `'codex'`) with built-in environment variable overrides, so the simplest scripts need only a single import and a single line to connect. This eliminates an entire category of IDE integration problems by making imports resolve natively through TypeScript, Node.js, and every editor and bundler — with zero configuration.

## Background

Thinkwell scripts currently use a custom URI scheme for imports:

```typescript
import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";
```

The `thinkwell:*` scheme was inspired by Node.js built-in protocols like `node:fs`, providing a visually distinctive import convention. At runtime, the loader in `loader.ts` rewrites these to their corresponding npm package names before execution:

| URI scheme | npm package |
|---|---|
| `thinkwell:agent` | `thinkwell` |
| `thinkwell:connectors` | `thinkwell` |
| `thinkwell:acp` | `@thinkwell/acp` |
| `thinkwell:protocol` | `@thinkwell/protocol` |

## Problem Statement

The custom URI scheme creates friction across the entire toolchain:

1. **VSCode / TypeScript:** `Cannot find module 'thinkwell:agent'` — TypeScript doesn't know how to resolve custom protocol imports. Users see red squiggles on every thinkwell import.

2. **Other editors:** The same problem affects every IDE and editor with TypeScript support (WebStorm, Neovim, Helix, Zed, etc.).

3. **`tsc` CLI:** Type-checking with `tsc` fails on these imports. There's no tsconfig option that resolves custom protocols without a plugin.

4. **Bundlers:** Any bundler (esbuild, webpack, Vite) requires custom configuration to resolve `thinkwell:*` imports.

5. **Plugin-based workarounds are fragile:** TypeScript Language Service plugins can suppress errors and monkey-patch module resolution, but:
   - They don't affect `tsc` CLI builds
   - The monkey-patching pattern (modifying `LanguageServiceHost`) is unofficial
   - TypeScript 7 (the Go port, shipping March 2026) will not support the plugin API at all

6. **`declare module` workarounds add maintenance burden:** Shipping ambient module declarations for `thinkwell:agent` etc. would work, but adds a layer of indirection that must be kept in sync.

### The Key Observation

The `thinkwell` package already has `package.json` `exports` for standard paths, and `Agent` is its primary export. The URI scheme is a parallel mechanism that the loader translates back to these same packages at runtime. The translation adds complexity without adding capability.

## Proposal

### The new API

**Before:**
```typescript
import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";

const agent = await Agent.connect(process.env.THINKWELL_AGENT_CMD ?? CLAUDE_CODE);
```

**After:**
```typescript
import { open } from "thinkwell";

const agent = await open('claude');
```

Three changes work together to simplify this:

1. The `thinkwell:agent` specifier becomes the standard `"thinkwell"` import.
2. The connectors module is replaced by named agent strings.
3. The `Agent.connect()` static method is replaced by a top-level `open()` function, which handles agent resolution and environment variable overrides internally.

For the scoped packages, no change is needed — users can import `@thinkwell/acp` and `@thinkwell/protocol` directly (and some likely already do).

### `open()` API design

```typescript
type AgentName = 'claude' | 'codex' | 'gemini' | 'kiro' | 'opencode' | 'auggie';

interface AgentOptions {
  /** Custom command to spawn the agent process (mutually exclusive with AgentName) */
  cmd?: string;
  /** Environment variables for the agent process */
  env?: Record<string, string>;
  /** Connection timeout in milliseconds */
  timeout?: number;
}

// Named agent (the common case)
async function open(name: AgentName, options?: AgentOptions): Promise<Agent>;

// Custom command
async function open(options: AgentOptions & { cmd: string }): Promise<Agent>;
```

**Usage patterns:**

```typescript
// Named agent — the 90% case
const agent = await open('claude');

// Named agent with options
const agent = await open('claude', { timeout: 30000 });

// Custom command
const agent = await open({ cmd: 'myagent --acp' });

// Custom command with options
const agent = await open({ cmd: 'myagent --acp', timeout: 30000, env: { DEBUG: '1' } });
```

When the first argument is an `AgentName`, specifying `cmd` in the options is disallowed (they're mutually exclusive — one selects a known agent, the other provides an arbitrary command).

### Environment variable override

`open()` checks two environment variables before resolving the agent:

- `$THINKWELL_AGENT` — an agent name: `THINKWELL_AGENT=opencode thinkwell script.ts`
- `$THINKWELL_AGENT_CMD` — a command string: `THINKWELL_AGENT_CMD="myagent --acp" thinkwell script.ts`

If both are set, `$THINKWELL_AGENT_CMD` takes precedence (it's the more specific override). Either way, the env override applies regardless of what the script passes to `open()`. This is an ecosystem convention: scripts declare a *default* agent, but users can swap agents at runtime without changing code.

### Agent name resolution

Each `AgentName` maps to a command string:

| Name | Command |
|---|---|
| `'claude'` | `npx -y @zed-industries/claude-code-acp` |
| `'codex'` | `npx -y @zed-industries/codex-acp` |
| `'gemini'` | `npx -y @google/gemini-cli --experimental-acp` |
| `'kiro'` | `kiro-cli acp` |
| `'opencode'` | `opencode acp` |
| `'auggie'` | `auggie --acp` |

This table lives in the `open()` implementation. The `connectors/index.ts` module is removed.

**Note:** The current `connectors/index.ts` has an incorrect command string for Kiro (`kiro-cli chat acp` instead of `kiro-cli acp`). This should be fixed as part of the implementation.

### Changes required

**1. Add the `open()` function:**
- Add the `AgentName` type and the agent name → command mapping
- Implement the overloaded `open()` function with env override logic
- Export it from the package root
- Implement `AgentOptions` (rename from `ConnectOptions`, add `cmd`)
- Actually use the `env` and `timeout` options (currently ignored in `connect()`)
- Deprecate or remove `Agent.connect()`

**2. Remove the connectors module:**
- Delete `packages/thinkwell/src/connectors/index.ts`
- Remove the `./connectors` subpath from `package.json` `exports`

**3. User-facing code (examples and docs):**
Update all import and connection statements:
- `import { Agent } from "thinkwell:agent"` → `import { Agent } from "thinkwell"`
- `import { CLAUDE_CODE } from "thinkwell:connectors"` → remove
- `Agent.connect(CLAUDE_CODE)` → `open('claude')`
- `"thinkwell:acp"` → `"@thinkwell/acp"`
- `"thinkwell:protocol"` → `"@thinkwell/protocol"`

**4. Loader (`packages/thinkwell/src/cli/loader.ts`):**
- Remove the `THINKWELL_MODULES` mapping table
- Remove the `rewriteThinkwellImports()` function
- Update `needsTransformation()` to no longer check for `thinkwell:*` patterns
- Remove references in the doc comments

**5. Build system (`packages/thinkwell/src/cli/build.ts`):**
- Remove any esbuild `onResolve` hooks for `thinkwell:*` specifiers

**6. Init template (`packages/thinkwell/src/cli/init-command.ts`):**
- Update the scaffolded example script to use `open()`

**7. Tests:**
- Update test fixtures and assertions that reference `thinkwell:*` imports
- Remove tests specific to URI scheme rewriting
- Add tests for `open()` overloads and env override behavior

**8. Binary entry point (`packages/thinkwell/src/cli/main.cjs`):**
- The `global.__bundled__` registry is keyed by npm package name, not URI — no change needed

**9. Documentation and website:**
- Update all code examples across the website

### What stays the same

- The `global.__bundled__` registry and bundled module resolution — this is keyed by npm package names and is unaffected
- The `@JSONSchema` processing pipeline — completely independent of the import scheme
- The `.js` → `.ts` extension rewriting — unrelated
- The esbuild bundling for `thinkwell build` — standard npm imports are what esbuild already expects

## Design Decisions

### Why not keep both syntaxes with a deprecation period?

Supporting both syntaxes means maintaining the rewriting infrastructure and testing both paths. The URI scheme has not been released to external users yet, so there's no backwards compatibility obligation. A clean break is simpler.

### Why a top-level `open()` function instead of `Agent.connect()`?

Two improvements over the previous API:

- **`open` instead of `connect`:** "Open" frames the operation at the right level of abstraction. Opening an agent should feel as simple and commonplace as opening a file — you name what you want and start using it. "Connect" leaks the lower-level ACP transport model, which is an implementation detail users shouldn't need to think about.
- **Top-level function instead of static method:** `open('claude')` is more concise and idiomatic than `Agent.open('claude')`. It also means users who only need to open an agent and call `.think()` don't need to import the `Agent` class at all — `import { open } from "thinkwell"` is the only import they need.

### Why named agent strings instead of command constants?

The previous API required users to import command strings like `CLAUDE_CODE` and understand that they were shell commands. Named strings like `'claude'` are:

- **Simpler:** No second import, no need to know the underlying command
- **Discoverable:** The `AgentName` type provides autocomplete for all supported agents
- **Agent-neutral:** Thinkwell doesn't privilege any particular agent — they're all just names in a union type
- **Readable:** `open('claude')` reads like plain English

Users who need custom commands can pass `{ cmd: '...' }` directly.

### Why built-in environment variable overrides?

The `$THINKWELL_AGENT` and `$THINKWELL_AGENT_CMD` overrides are an ecosystem convention that decouples scripts from specific agents. A script says "use Claude by default" but an end user can run `THINKWELL_AGENT=opencode thinkwell script.ts` to swap agents without modifying code. This is especially valuable for:

- Testing scripts across different agents
- Teams with different agent preferences
- CI environments where the agent may differ from development

## Impact

After this change, thinkwell **import statements** will resolve natively for projects that have `thinkwell` installed as an npm dependency. No plugins, no generated files, no tsconfig changes, no `declare module` declarations — standard `package.json` `exports` handle everything.

### Remaining IDE gaps

Two categories of errors remain after this change:

1. **Standalone scripts without `node_modules`:** The `thinkwell` CLI supports standalone scripts (e.g., with a `#!/usr/bin/env thinkwell` shebang) that don't require a `package.json` or `npm install`. The CLI bundles all thinkwell dependencies internally, but VSCode has no `node_modules/thinkwell` to resolve against and will still report `Cannot find module 'thinkwell'`. The VSCode extension in [vscode-ts-plugin](vscode-ts-plugin.md) can solve this by resolving `thinkwell` imports to the CLI's bundled type declarations for detected thinkwell scripts.

2. **`@JSONSchema` type augmentation:** Expressions like `Greeting.Schema` will still show errors because TypeScript doesn't know about the runtime-injected namespace members. Solving that is the subject of the [vscode-ts-plugin](vscode-ts-plugin.md) and [tsgo-api-migration](tsgo-api-migration.md) RFDs.
