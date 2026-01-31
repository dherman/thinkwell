# Bun Workarounds

This document tracks Bun bugs or limitations encountered during development and the workarounds we implemented.

## 1. Runtime Plugin `onResolve` Doesn't Intercept URL-like Imports

**Bun Version:** 1.2.17

**Problem:** When using a Bun runtime plugin (via `--preload`), the `onResolve` hook does not intercept imports that look like URLs (i.e., contain a `:`). Bun validates these as URLs before the plugin gets a chance to handle them.

```typescript
// This never fires for "thinkwell:agent" imports
build.onResolve({ filter: /^thinkwell:/ }, (args) => {
  // ...
});
```

**Error:** `Cannot resolve invalid URL 'thinkwell:agent'`

**Workaround:** Rewrite the imports during `onLoad` instead. We use a regex to transform `thinkwell:*` imports to their actual npm package names before transpilation:

```typescript
// In packages/bun-plugin/src/index.ts
function rewriteThinkwellImports(source: string): string {
  return source.replace(
    /(from\s+['"])thinkwell:(\w+)(['"])/g,
    (_, prefix, moduleName, suffix) => {
      const npmPackage = THINKWELL_MODULES[moduleName];
      return npmPackage ? `${prefix}${npmPackage}${suffix}` : `${prefix}thinkwell:${moduleName}${suffix}`;
    }
  );
}
```

**Files Affected:**
- [packages/bun-plugin/src/index.ts](../packages/bun-plugin/src/index.ts)

---

## 2. Runtime Plugin `loader: "ts"` Doesn't Properly Transpile TypeScript

**Bun Version:** 1.2.17

**Problem:** When returning `{ contents, loader: "ts" }` from an `onLoad` hook in a runtime plugin, Bun doesn't properly transpile the TypeScript before executing it.

**Workaround:** Manually transpile using `Bun.Transpiler` and return `loader: "js"`:

```typescript
// In packages/bun-plugin/src/index.ts
function safeTranspile(source: string, loader: "ts" | "tsx", filePath: string): string {
  const transpiler = new Bun.Transpiler({ loader });
  return transpiler.transformSync(source);
}

// In onLoad:
return { contents: safeTranspile(modifiedSource, loader, path), loader: "js" };
```

**Files Affected:**
- [packages/bun-plugin/src/index.ts](../packages/bun-plugin/src/index.ts)

---

## 3. `NODE_PATH` Doesn't Support Subpath Exports

**Bun Version:** 1.2.17

**Problem:** When using `NODE_PATH` to help Bun find packages, subpath exports (e.g., `thinkwell/connectors`) don't resolve correctly, even though the main export (`thinkwell`) works fine.

```bash
# Works
NODE_PATH=./packages/cli/node_modules bun -e "import { Agent } from 'thinkwell'"

# Fails
NODE_PATH=./packages/cli/node_modules bun -e "import { CLAUDE_CODE } from 'thinkwell/connectors'"
```

**Workaround:** Re-export subpath modules from the main package entry point, and map `thinkwell:connectors` to the main `thinkwell` package instead of `thinkwell/connectors`:

```typescript
// In packages/thinkwell/src/index.ts
export * from "./connectors/index.js";

// In packages/bun-plugin/src/modules.ts
export const THINKWELL_MODULES: Record<string, string> = {
  agent: "thinkwell",
  connectors: "thinkwell",  // Maps to main package which re-exports connectors
  // ...
};
```

**Files Affected:**
- [packages/thinkwell/src/index.ts](../packages/thinkwell/src/index.ts)
- [packages/bun-plugin/src/modules.ts](../packages/bun-plugin/src/modules.ts)
- [packages/cli/bin/thinkwell](../packages/cli/bin/thinkwell) (sets `NODE_PATH`)
