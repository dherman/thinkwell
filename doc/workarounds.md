# Workarounds

This document tracks bugs or limitations encountered during development and the workarounds we implemented.

## pkg Workarounds

### 1. TTY Access During Module Load Causes V8 Crash

**pkg Version:** @yao-pkg/pkg 6.12.0
**Node.js Version:** 24.x (embedded in pkg binary)
**Platform:** macOS darwin-arm64 (confirmed), likely other platforms

**Problem:** When running `thinkwell build` from a pkg-compiled binary in a TTY environment (where `process.stderr.isTTY === true`), the process crashes with a segmentation fault during V8 bootstrap.

```
$ thinkwell build src/greeting.ts
Building greeting...

zsh: segmentation fault  thinkwell build src/greeting.ts
```

The crash occurs after initial output but before the spinner starts.

**Root Cause:** The `ora` spinner library depends on `restore-cursor`, which evaluates `process.stderr.isTTY` at module load time (not when the spinner is used). In pkg's virtual filesystem environment, this TTY access during Node.js bootstrap triggers a V8 crash in `node::Realm::ExecuteBootstrapper`.

The problematic code in `restore-cursor`:
```javascript
var terminal = process.stderr.isTTY
  ? process.stderr
  : process.stdout.isTTY
    ? process.stdout
    : void 0;
```

This executes when the module is `require()`d, which happens during pkg's bootstrap phase.

**Reproduction Matrix:**

| Condition | stderr.isTTY | Result |
|-----------|--------------|--------|
| Normal TTY terminal | true | **CRASH** |
| `2>/dev/null` | false | Works |
| `2>&1 \| cat` | false | Works |
| `CI=true` | true | Works (ora skips TTY code) |
| Non-TTY environment | false | Works |

**Workaround:** Replace `ora` with a custom spinner implementation that lazily checks `process.stderr.isTTY` only when `start()` is called, not at module load time.

The custom spinner in [packages/thinkwell/src/cli/build.ts](../packages/thinkwell/src/cli/build.ts) provides the same user experience (animated spinner in TTY, static output in non-TTY) without the problematic module-load-time TTY access.

**Upstream Issue:** Unknown whether this is a bug in pkg, Node.js, or an unavoidable limitation of pkg's virtual filesystem. The crash occurs deep in V8 internals during bootstrap, suggesting it may be a pkg issue with how it initializes the Node.js runtime.

**Files Affected:**
- [packages/thinkwell/src/cli/build.ts](../packages/thinkwell/src/cli/build.ts)
- [packages/thinkwell/package.json](../packages/thinkwell/package.json) (removed ora dependency)

**See Also:** [doc/debugging-build-crash.md](debugging-build-crash.md) for the full investigation.

---

## kiro-cli acp: Doesn't Exit on stdin EOF

**Issue:** `kiro-cli acp` (v1.25.0) doesn't exit when stdin closes (EOF). This is a bug in kiro-cli that has been confirmed with the maintainers.

**Expected behavior:** When stdin closes, the process should detect EOF and exit gracefully.

**Actual behavior:** The process continues running indefinitely even after stdin is closed.

**Workaround:** In `packages/conductor/src/connectors/stdio.ts`, we:
1. Close stdin with `process.stdin.end()`
2. Wait 250ms for graceful exit
3. Send SIGTERM if the process hasn't exited
4. Wait another 500ms
5. Send SIGKILL if still running

**Side effects:**
- Process exits with code 255 (from SIGTERM) instead of 0
- We suppress logging of non-zero exit codes during graceful shutdown to avoid confusing users

**Files affected:**
- `packages/conductor/src/connectors/stdio.ts` - Timeout logic and exit code logging

**Tracking:** This workaround can be removed once kiro-cli properly handles stdin EOF.

---

## Historical Workarounds (No Longer In Use)

The following workarounds were used when thinkwell was built on Bun. The project has since migrated to Node.js with pkg for binary distribution. These are preserved for reference.

### Bun: Runtime Plugin `onResolve` Doesn't Intercept URL-like Imports

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

---

### Bun: Runtime Plugin `loader: "ts"` Doesn't Properly Transpile TypeScript

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

---

### Bun: `NODE_PATH` Doesn't Support Subpath Exports

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
