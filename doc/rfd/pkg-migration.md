# RFD: Migrate Binary Distribution from Bun to pkg

**Implementation:** [PR #17](https://github.com/dherman/thinkwell/pull/17)

## Summary

This document proposes replacing Bun's `--compile` flag with [yao-pkg/pkg](https://github.com/yao-pkg/pkg) for building the thinkwell compiled binary. This migration solves a fundamental limitation in Bun's compiled binaries: the inability to resolve npm packages from a user's `node_modules` at runtime.

## Problem Statement

The current Bun-based binary distribution has a critical limitation that prevents user scripts from importing their own npm dependencies:

```typescript
// User's script: examples/src/sentiment.ts
import { Agent } from "thinkwell:agent";     // ✅ Works (transformed via globalThis.__thinkwell__)
import Sentiment from "sentiment";           // ❌ Fails
```

**Error:**
```
Cannot find package 'sentiment' from '/path/to/user/script.ts'
```

### Root Cause

When a Bun compiled binary executes `await import(userScript)`:

1. The binary's virtual filesystem uses `/$bunfs/` prefix
2. Bun's module resolution starts from `/$bunfs/root/...`
3. External packages in the user's `node_modules` cannot be found
4. Even `Bun.resolveSync()` with explicit paths has bugs in compiled binaries ([Issue #13405](https://github.com/oven-sh/bun/issues/13405))

### Why Bun Can't Fix This

This is a **known limitation** tracked across multiple Bun issues:

| Issue | Description | Status |
|-------|-------------|--------|
| [#5445](https://github.com/oven-sh/bun/issues/5445) | `--embed-dir` flag to embed arbitrary directories | Open |
| [#11732](https://github.com/oven-sh/bun/issues/11732) | Non-statically-analyzable dynamic imports | Open |
| [#8967](https://github.com/oven-sh/bun/issues/8967) | Include complete node_modules in binary | Open |
| [#26653](https://github.com/oven-sh/bun/issues/26653) | Plugin onLoad breaks transitive dependencies | Open |

**Key finding:** Bun plugins run at **bundle time**, not runtime. When the binary does `await import(userScript)`, there are no plugin hooks to intercept module resolution for the user script's dependencies.

## Research Findings

We built a proof-of-concept at `experiments/pkg-poc/` demonstrating that pkg successfully achieves what Bun cannot.

### pkg Architecture

pkg uses a `/snapshot/` virtual filesystem prefix and patches Node's `require` to serve bundled files. Critically, it maintains proper separation between:

- **Bundled modules** — Served from `/snapshot/...`
- **External modules** — Resolved from the real filesystem

```
┌─────────────────────────────────────────────────────────────────┐
│ Compiled Binary (/snapshot/)                                    │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ thinkwell, @thinkwell/acp, @thinkwell/protocol              │ │
│ │ (bundled in virtual filesystem)                              │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                           ↓                                     │
│              require(userScript)                                │
│                           ↓                                     │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ User Script Resolution                                       │ │
│ │                                                              │ │
│ │ require("thinkwell")  → global.__bundled__["thinkwell"]     │ │
│ │ require("sentiment")  → /user/project/node_modules/sentiment│ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Proof-of-Concept Results

| Test Case | Bun --compile | pkg |
|-----------|---------------|-----|
| Bundle thinkwell packages | ✅ | ✅ |
| Dynamic import from real FS | ✅ | ✅ |
| User script imports from node_modules | ❌ | ✅ |
| Transitive dependencies | ❌ | ✅ |
| TypeScript support | ✅ Built-in | ✅ Native (Node 24) |

### Native TypeScript Support

Node.js 24+ supports native TypeScript execution. We use `--experimental-transform-types` (not `--experimental-strip-types`) because @JSONSchema processing generates TypeScript namespace declarations, which require transformation rather than just stripping.

```bash
pkg src/cli/main-pkg.cjs --targets node24-macos-arm64 --options experimental-transform-types -o thinkwell
```

The compiled binary can then directly `require('./user-script.ts')` without any external transpiler. Using `--experimental-transform-types` enables full TypeScript support including:
- Namespaces (required for @JSONSchema-generated code)
- Enums (regular and const)
- Parameter properties
- Legacy decorators

**Tested and working:**
```
./dist/pkg-poc-native-ts user-project/thinkwell-style.ts

=== TypeScript Thinkwell-Style Script ===
[Agent] Created agent: sentiment-analyzer
Running TypeScript sentiment analysis...
Input: "TypeScript is absolutely fantastic!"
  Score: 4
  Positive: fantastic
=== TypeScript Script Completed ===
```

### ESM Bundling Workaround

pkg doesn't properly resolve ESM imports inside its `/snapshot/` virtual filesystem. To work around this, thinkwell packages are pre-bundled into CJS format using esbuild before pkg compilation:

```
scripts/bundle-for-pkg.ts → dist-pkg/
  ├── thinkwell.cjs      (~711 KB) - bundled thinkwell package
  ├── acp.cjs            (~242 KB) - bundled @thinkwell/acp package
  ├── protocol.cjs       (~7 KB)   - bundled @thinkwell/protocol package
  └── cli-loader.cjs     (~11 MB)  - loader + ts-json-schema-generator + typescript
```

The CLI loader is bundled separately because it includes the full TypeScript compiler and ts-json-schema-generator for @JSONSchema processing at runtime.

## Proposal

### Migration Strategy

Replace the current Bun-based binary build with pkg:

**Current (Bun):**
```bash
bun build --compile --target=bun-darwin-arm64 src/cli/main.ts -o thinkwell
```

**Proposed (pkg):**
```bash
pkg src/cli/main.js --targets node24-macos-arm64 --options experimental-strip-types -o thinkwell
```

### Module Resolution Architecture

The CLI will use a custom `require` function that routes imports appropriately:

```javascript
// src/cli/loader.js
function createCustomRequire(scriptDir) {
  return function customRequire(moduleName) {
    // Bundled thinkwell packages
    if (global.__bundled__[moduleName]) {
      return global.__bundled__[moduleName];
    }

    // External packages from user's node_modules
    const resolved = require.resolve(moduleName, {
      paths: [scriptDir, path.join(scriptDir, 'node_modules')]
    });
    return require(resolved);
  };
}
```

### Virtual Module Registry

The CLI entry point registers bundled exports before loading user scripts:

```javascript
// src/cli/main.js
const thinkwell = require('./bundled/thinkwell');
const acpModule = require('./bundled/acp');
const protocolModule = require('./bundled/protocol');

global.__bundled__ = {
  'thinkwell': thinkwell,
  '@thinkwell/acp': acpModule,
  '@thinkwell/protocol': protocolModule,
};
```

### Import Transformation

User scripts using `thinkwell:*` imports will be transformed at load time:

```typescript
// User writes:
import { Agent } from "thinkwell:agent";

// Transformed to:
const { Agent } = global.__bundled__["thinkwell"];
```

This transformation happens in the loader before the script is executed, similar to the current `transformVirtualImports()` in the Bun plugin.

### Build Configuration

The build process has two stages:

1. **Pre-bundle** (`scripts/bundle-for-pkg.ts`): Bundle thinkwell packages and CLI loader into CJS format
2. **pkg compile** (`scripts/build-binary-pkg.ts`): Compile the CJS entry point into platform binaries

**package.json scripts:**
```json
{
  "scripts": {
    "bundle:pkg": "tsx scripts/bundle-for-pkg.ts",
    "build:binary:pkg": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts",
    "build:binary:pkg:darwin-arm64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts darwin-arm64",
    "build:binary:pkg:darwin-x64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts darwin-x64",
    "build:binary:pkg:linux-x64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts linux-x64",
    "build:binary:pkg:linux-arm64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts linux-arm64"
  }
}
```

**pkg configuration in package.json:**
```json
{
  "pkg": {
    "assets": ["dist/**/*.js", "dist-pkg/*.cjs"],
    "scripts": ["dist/**/*.js", "dist-pkg/*.cjs"],
    "targets": ["node24-macos-arm64", "node24-macos-x64", "node24-linux-x64", "node24-linux-arm64"],
    "outputPath": "dist-bin"
  }
}
```

## Trade-offs

### Advantages of pkg (and Node.js)

| Aspect | Benefit |
|--------|---------|
| External resolution | User scripts can import from their own node_modules |
| Transitive dependencies | Packages that import other packages work correctly |
| Mature ecosystem | pkg has been production-tested for years |
| Native TypeScript | Node 24's type transformation eliminates transpiler dependency |
| Unified architecture | Both npm and binary distributions use identical execution paths |

### Disadvantages vs Bun

| Aspect | Impact |
|--------|--------|
| Binary size | ~63 MB (Node 24) vs ~45 MB (Bun) |
| Startup time | Node.js startup is slower than Bun |
| Runtime performance | Node.js is generally slower than Bun for CPU-bound tasks |
| CommonJS focus | pkg works best with CommonJS; ESM has limitations |
| No Bun APIs | Cannot use Bun-specific APIs like `Bun.file()` |

### Runtime Performance Considerations

For thinkwell's use case, the performance trade-offs are acceptable:

1. **IO-bound workloads** — Agent execution is dominated by LLM API calls, not CPU
2. **Startup is one-time** — Scripts typically run for extended periods
3. **Correctness over speed** — External module resolution working correctly is more important than faster startup

## Open Questions

### ESM Support — RESOLVED

**Question:** Can pkg handle ES modules for user scripts?

**Answer:** Yes, via Node.js's stable `require(esm)` feature.

**Investigation results** (see [experiments/pkg-esm-test/](../../experiments/pkg-esm-test/)):

| Approach | Development | pkg Binary |
|----------|-------------|------------|
| `await import()` | ✅ | ❌ `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` |
| `require(esm)` (no TLA) | ✅ | ✅ Works |
| `require(esm)` (with TLA) | ❌ | ❌ `ERR_REQUIRE_ASYNC_MODULE` |

**Key findings:**

1. **`require(esm)` is stable** in Node.js 20.19.0+ and 22.12.0+ ([announcement](https://joyeecheung.github.io/blog/2025/12/30/require-esm-in-node-js-from-experiment-to-stability/))
2. **Works in pkg binaries** — User ESM scripts (`.mjs` or `"type": "module"`) can be loaded via `require()`
3. **ESM-only packages work** — Tested with `chalk` v5 (pure ESM) importing from user's `node_modules`
4. **No pre-bundling needed** — Unlike pkg issue workarounds suggest

**Limitation:** Top-level `await` is not supported in user scripts. This affects only ~0.02% of npm packages (6 out of top 5000). Users needing TLA can pre-bundle their scripts with esbuild.

**Decision:** Use `require()` for loading user scripts. This handles both CommonJS and ESM (without TLA) transparently.

### Windows Support

**Question:** Does this approach work on Windows?

**Current status:** Not tested. pkg supports Windows (win32-x64), but:
- Path handling differs (`C:\snapshot\` vs `/snapshot/`)
- Native TypeScript stripping should work identically
- `require.resolve()` with paths should work

**Recommendation:** Add Windows to the test matrix but defer as lower priority.

### @JSONSchema Processing — RESOLVED

**Question:** How will @JSONSchema type processing work?

**Answer:** Ported schema generation to a standalone module that runs at script load time.

**Implementation** (see `packages/thinkwell/src/cli/schema.ts`):

1. **Type Discovery**: `findMarkedTypes()` uses TypeScript AST traversal to find types with `@JSONSchema` JSDoc tag
2. **Schema Generation**: `generateSchemas()` uses ts-json-schema-generator to create JSON schemas with inlined `$ref` references
3. **Code Injection**: `generateInsertions()` creates namespace declarations with `SchemaProvider` implementations
4. **Transform Pipeline**: `transformJsonSchemas()` orchestrates the full transformation

The schema module is pre-bundled into `dist-pkg/cli-loader.cjs` along with ts-json-schema-generator and typescript (~11MB total). This enables @JSONSchema processing in both the pkg binary and npm distributions.

**Key insight:** Using `--experimental-transform-types` instead of `--experimental-strip-types` was necessary because the injected namespace declarations are TypeScript syntax that must be transformed, not just stripped.

## Comparison with Alternatives

### Keep Bun + subprocess

**Description:** Accept the limitation; use subprocess spawn for npm distribution.

**Pros:** No migration needed
**Cons:** Binary distribution remains broken; subprocess adds latency

### Wait for Bun fixes

**Description:** Wait for Bun to implement `--embed-dir` or fix module resolution.

**Pros:** Eventually get Bun's performance benefits
**Cons:** No timeline; may never happen; blocks users now

### Node.js SEA (Single Executable Applications)

**Description:** Use Node.js native single executable feature.

**Pros:** Native Node.js support; no third-party tool
**Cons:** Requires bundling to single file; limited asset embedding; less mature than pkg

### Deno

**Description:** Migrate to Deno which has `deno compile --include`.

**Pros:** Modern runtime; good module resolution
**Cons:** Major migration; different APIs; TypeScript handling differs

## References

- [yao-pkg/pkg GitHub](https://github.com/yao-pkg/pkg)
- [Node.js Native TypeScript](https://nodejs.org/en/learn/typescript/run-natively)
- [Bun Issue #5445: --embed-dir](https://github.com/oven-sh/bun/issues/5445)
- [Bun Issue #13405: resolveSync bug](https://github.com/oven-sh/bun/issues/13405)
- [pkg Issue #16: ESM support](https://github.com/yao-pkg/pkg/issues/16)
- [Proof-of-concept: experiments/pkg-poc/](../experiments/pkg-poc/)
- [RFD: Binary Distribution Module Resolution](./archive/binary-module-resolution.md)
- [RFD: CLI Distribution](./cli-distribution.md)
