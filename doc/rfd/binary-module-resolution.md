# RFD: Binary Distribution Module Resolution

## Summary

This document describes how the compiled thinkwell binary should resolve `thinkwell:*` imports when executing user scripts, and proposes a solution using Bun's virtual module capability.

## Problem Statement

The thinkwell CLI can be distributed as a self-contained compiled binary (via Homebrew or direct download). When a user runs:

```bash
thinkwell greeting.ts
```

And `greeting.ts` contains:

```typescript
import { Agent } from "thinkwell:agent";
import { CLAUDE_CODE } from "thinkwell:connectors";
```

The script fails with:

```
Cannot find package 'thinkwell' from '/path/to/greeting.ts'
```

### Root Cause

The current module resolution flow in the bun-plugin:

1. **onResolve** intercepts `thinkwell:agent`
2. Maps it to npm package name `"thinkwell"`
3. Returns `{ path: "thinkwell", external: true }`
4. Bun attempts to resolve `"thinkwell"` as an external package
5. **Fails** because there's no `node_modules/thinkwell` on disk

This works for the npm distribution where `node_modules` exists, but not for the compiled binary which has no external dependencies.

### Why `bun build --compile` Doesn't Solve This

Bun's `--compile` flag bundles all *statically imported* dependencies into the binary. The thinkwell CLI does statically import `@thinkwell/bun-plugin`, so the plugin code is bundled.

However, user scripts are loaded via `await import(scriptUrl)` at runtime—they are not known at compile time. When the user script imports from `thinkwell:agent`, it's a new import that Bun must resolve at runtime. The plugin intercepts this, but currently directs Bun to look for an external package that doesn't exist.

## Requirements

1. **Self-contained execution** — The compiled binary must run user scripts without any external `node_modules`
2. **Identical behavior** — Scripts should work identically whether run via npm distribution or compiled binary
3. **No user configuration** — Users shouldn't need to set up import maps or configure module resolution
4. **Minimal binary size impact** — The solution shouldn't significantly increase the binary size beyond what's already bundled

## Proposal: Virtual Module Registry

### Concept

Use Bun's plugin system to provide thinkwell packages as **virtual modules**:

1. The CLI entry point statically imports all thinkwell packages (ensuring they're bundled)
2. Before running user scripts, register these imports with the plugin
3. The plugin intercepts `thinkwell:*` imports and provides the registered exports directly
4. User scripts receive the bundled modules without filesystem resolution

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Compiled Binary                                                 │
│  ────────────────────────────────────────────────────────────── │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────────────────────┐  │
│  │  main.ts         │    │  bun-plugin                       │  │
│  │                  │    │                                    │  │
│  │  import * as     │───▶│  registerModules({                │  │
│  │    thinkwell     │    │    "thinkwell": thinkwellExports, │  │
│  │  from "thinkwell"│    │    "@thinkwell/acp": acpExports   │  │
│  │                  │    │  })                                │  │
│  └──────────────────┘    └───────────────┬──────────────────┘  │
│                                          │                      │
│                                          ▼                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  User Script (greeting.ts)                                │  │
│  │                                                           │  │
│  │  import { Agent } from "thinkwell:agent"                  │  │
│  │           │                                               │  │
│  │           ▼                                               │  │
│  │  onResolve: thinkwell:agent → thinkwell-virtual:thinkwell │  │
│  │           │                                               │  │
│  │           ▼                                               │  │
│  │  onLoad: return { exports: registeredModules["thinkwell"] │  │
│  │          loader: "object" }                               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### API Design

**bun-plugin/src/registry.ts:**

```typescript
// Module registry for virtual module resolution
const moduleRegistry = new Map<string, Record<string, unknown>>();

/**
 * Register module exports for virtual resolution.
 * Called by the CLI before running user scripts.
 */
export function registerModule(name: string, exports: Record<string, unknown>): void {
  moduleRegistry.set(name, exports);
}

/**
 * Get registered module exports.
 * Returns undefined if not registered (fall back to external resolution).
 */
export function getRegisteredModule(name: string): Record<string, unknown> | undefined {
  return moduleRegistry.get(name);
}

/**
 * Check if running in bundled binary mode (modules are registered).
 */
export function isVirtualModeEnabled(): boolean {
  return moduleRegistry.size > 0;
}
```

**bun-plugin/src/index.ts (modified onResolve):**

```typescript
build.onResolve({ filter: /^thinkwell:/ }, (args) => {
  const moduleName = args.path.replace("thinkwell:", "");
  const npmPackage = THINKWELL_MODULES[moduleName];

  if (!npmPackage) {
    throw new UnknownModuleError({ ... });
  }

  // Check if we have this module registered (binary distribution)
  if (isVirtualModeEnabled() && getRegisteredModule(npmPackage)) {
    return {
      path: npmPackage,
      namespace: "thinkwell-virtual",
    };
  }

  // Fall back to external resolution (npm distribution)
  return {
    path: npmPackage,
    external: true,
  };
});

// Handle virtual module loads
build.onLoad(
  { filter: /.*/, namespace: "thinkwell-virtual" },
  ({ path }) => {
    const exports = getRegisteredModule(path);
    if (!exports) {
      throw new Error(`Virtual module not found: ${path}`);
    }
    return {
      exports,
      loader: "object",
    };
  }
);
```

**main.ts (modified):**

```typescript
import "@thinkwell/bun-plugin";
import { registerModule } from "@thinkwell/bun-plugin";

// Import thinkwell packages to ensure they're bundled
import * as thinkwell from "thinkwell";
import * as acpModule from "@thinkwell/acp";
import * as protocolModule from "@thinkwell/protocol";

// Register for virtual resolution
registerModule("thinkwell", thinkwell);
registerModule("@thinkwell/acp", acpModule);
registerModule("@thinkwell/protocol", protocolModule);

// ... rest of CLI
```

### Handling Transitive Imports

A key consideration: user scripts might import from `thinkwell`, and the thinkwell package itself imports from `@thinkwell/acp`. These transitive imports must also work.

When the `thinkwell` package is bundled into the binary, its imports are resolved at bundle time. So `thinkwell/dist/agent.js` importing from `@thinkwell/acp` is already resolved to the bundled ACP code.

However, if user scripts directly import from `@thinkwell/acp`:

```typescript
import { Agent } from "thinkwell:agent";
import { JsonSchema } from "thinkwell:acp";  // Direct ACP import
```

This also needs to work. The `thinkwell:acp` → `@thinkwell/acp` mapping and registration handles this case.

### npm Distribution Compatibility

The solution maintains full compatibility with npm distribution:

1. When running via `npx thinkwell` or from a project's `node_modules`, no modules are registered
2. `isVirtualModeEnabled()` returns `false`
3. The plugin falls back to `external: true` resolution
4. Bun resolves from `node_modules` as before

This means the same plugin code works for both distributions without conditional compilation.

## Alternatives Considered

### 1. Embed node_modules in Binary

Include the full `node_modules` tree in the compiled binary and configure Bun to read from it.

**Pros:**
- No plugin changes needed
- Standard resolution behavior

**Cons:**
- Significantly increases binary size
- Complex virtual filesystem setup
- Duplicates already-bundled code

### 2. Use Import Maps

Generate an import map that maps `thinkwell:*` to absolute paths within the binary.

**Pros:**
- Standard web platform feature

**Cons:**
- Bun's import map support with compiled binaries is unclear
- Still needs filesystem paths that don't exist

### 3. Rewrite Imports to Inline Code

Have the plugin rewrite `import { Agent } from "thinkwell:agent"` to inline the actual code.

**Pros:**
- No resolution needed—code is directly inserted

**Cons:**
- Massive code duplication in transformed files
- Breaks source maps
- Circular dependency issues

### 4. Bun's Future `--packages=bundle` Flag

Bun may add a `--packages=bundle` flag for `--compile` that bundles all packages.

**Pros:**
- Native solution, no plugin changes

**Cons:**
- Doesn't exist yet
- May not handle dynamic imports correctly

## Implementation Plan

1. **Add registry module** — Create `packages/bun-plugin/src/registry.ts` with `registerModule` and related functions
2. **Export from bun-plugin** — Add registry exports to the plugin's public API
3. **Modify onResolve** — Check virtual mode and return namespace for registered modules
4. **Add onLoad for virtual namespace** — Return registered exports with `loader: "object"`
5. **Update main.ts** — Import and register thinkwell packages before plugin registration
6. **Test locally** — Build binary and run examples
7. **Update CI** — Ensure binary tests pass

## Testing Strategy

1. **Unit tests** — Test registry module in isolation
2. **Integration tests** — Test plugin with both registered and external modules
3. **End-to-end tests** — Run example scripts with compiled binary
4. **Distribution tests** — Test both npm and Homebrew installation paths

## References

- [Bun Plugin Documentation](https://bun.com/docs/bundler/plugins)
- [RFD: CLI Distribution](./cli-distribution.md)
- [RFD: Bun Schema Plugin](./bun-schema-plugin.md)
