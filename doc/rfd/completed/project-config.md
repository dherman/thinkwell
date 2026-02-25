# RFD: Standalone Binary Should Respect Project Config

- **Implementation:** [PR #46](https://github.com/dherman/thinkwell/pull/46)
- **Depends on:** [explicit-config](explicit-config.md), [node-ux](node-ux.md)
- **Issue:** [#33](https://github.com/dherman/thinkwell/issues/33)

## Summary

The `thinkwell` standalone binary unconditionally uses its bundled versions of thinkwell, TypeScript, and `ts-json-schema-generator` for script execution (`thinkwell run`), bundling (`thinkwell bundle`), and `@JSONSchema` processing — even when the project has a `package.json` with explicit dependency declarations. This violates the principle established in [explicit-config](explicit-config.md): a `package.json` signals user intent to manage dependencies explicitly, and bundled versions should defer to declared versions.

This RFD extends the explicit-config principle to all CLI commands, not just `build` and `check`.

## Problem Statement

The [explicit-config RFD](explicit-config.md) established a clear rule: when a project has a `package.json`, the CLI should use project-declared dependency versions and error if required dependencies are missing. This was implemented for `thinkwell build` and `thinkwell check`, but three gaps remain:

### 1. `thinkwell run` (script execution)

When running `thinkwell myscript.ts`, the binary:

- **Always uses bundled thinkwell packages** — `registerBundledModules()` in `main.cjs` populates `global.__bundled__` from the pkg snapshot, and `createCustomRequire()` in `loader.ts` checks bundled modules first. Even if the project declares `"thinkwell": "^0.4.0"`, the user gets whatever version is baked into the binary.

- **Always uses bundled TypeScript for `@JSONSchema`** — `createSchemaGenerator()` in `schema.ts` uses the bundled `ts-json-schema-generator` (which brings its own TypeScript). It does find the project's `tsconfig.json` for configuration, but the compiler version doing schema generation is always the bundled one.

- **Has no dependency checking** — Unlike `build`/`check`, the `run` path never calls `checkDependencies()`. There's no gating and no error if the project config is incomplete.

### 2. `thinkwell bundle`

The bundle command has the same problems:

- Uses bundled `transformJsonSchemas()` → bundled `ts-json-schema-generator` for `@JSONSchema` processing in the esbuild plugin.
- Generates a wrapper that always wires `global.__bundled__` to bundled thinkwell/acp/protocol copies.
- Has no dependency checking at all.

### 3. `@JSONSchema` processing in `build`/`check`

While `build` and `check` correctly gate on dependency availability and use the project's TypeScript for compilation via the custom CompilerHost, the `@JSONSchema` schema generation path (`transformJsonSchemas()` → `createSchemaGenerator()`) still uses the bundled `ts-json-schema-generator` and its bundled TypeScript. This means the type analysis for schema generation may use a different TypeScript version than the one doing compilation — a subtle inconsistency.

### Concrete Consequences

| Scenario | Expected | Actual |
|----------|----------|--------|
| Project has `"thinkwell": "^0.4.0"` in package.json | `thinkwell run` uses 0.4.x API | Uses whatever version is in the binary |
| Project has `"typescript": "^5.4.0"` | `@JSONSchema` schema generation uses TS 5.4.x | Uses bundled TS (may be 5.7.x) |
| Project has package.json but missing thinkwell dep | `thinkwell run` errors with guidance | Silently uses bundled version |

## Design Goals

1. **Consistent behavior** — All commands (`run`, `build`, `check`, `bundle`) follow the same explicit-config principle: `package.json` present → use declared versions; no `package.json` → use bundled versions.

2. **Minimal disruption** — The zero-config experience (no `package.json`) is unchanged. Only projects with explicit configuration are affected.

3. **Actionable errors** — When a project has a `package.json` but is missing required dependencies, provide the same clear error messages and `thinkwell init` guidance that `build`/`check` already use.

4. **Correctness over convenience** — It's better to error early than to silently use the wrong version of a dependency.

## Proposal

### Decision Tree (all commands)

Apply the same decision tree from the explicit-config RFD to all commands:

```
Has package.json?
├── No  → Use bundled versions (zero-config convenience)
└── Yes → Check for required dependencies
    ├── thinkwell declared? → Use project-local version
    ├── typescript declared? → Use project-local version for @JSONSchema
    └── Missing deps? → Error with remediation guidance
```

The specific dependencies required vary by command:

| Command | Requires `thinkwell` | Requires `typescript` |
|---------|---------------------|-----------------------|
| `run`   | Yes (if script imports thinkwell) | Yes (if `@JSONSchema` used) |
| `build` | Yes | Yes |
| `check` | Yes | Yes |
| `bundle`| Yes | Yes (if `@JSONSchema` used) |

### Change 1: Conditional bundled module resolution in `run`

Currently, `createCustomRequire()` in `loader.ts` always checks `global.__bundled__` first. When a project has explicit deps, it should skip the bundled registry and resolve from `node_modules` instead.

**Before:**
```typescript
function customRequire(moduleName: string): unknown {
  // Always check bundled first
  if (global.__bundled__ && isBundledPackage(moduleName)) {
    return global.__bundled__[moduleName];
  }
  // Fall back to node_modules
  ...
}
```

**After:**
```typescript
function customRequire(moduleName: string): unknown {
  // Only use bundled modules in zero-config mode
  if (global.__bundled__ && !projectHasExplicitConfig && isBundledPackage(moduleName)) {
    return global.__bundled__[moduleName];
  }
  // Resolve from project's node_modules
  ...
}
```

The `projectHasExplicitConfig` flag is determined once at startup based on whether a `package.json` exists in the script's directory (or its ancestors).

In explicit-config mode, the `transformVirtualImports()` step in `loader.ts` also needs to change: instead of rewriting thinkwell imports to `global.__bundled__["thinkwell"]`, they should be left as standard imports that resolve through `node_modules`.

### Change 2: Dependency checking for `run`

Add the same dependency checking that `build`/`check` use. When a `package.json` exists and the script imports thinkwell packages:

1. Check for `thinkwell` in dependencies (fast path: package.json, slow path: `<pm> why`)
2. If the script contains `@JSONSchema` markers, also check for `typescript`
3. If missing, error with the same remediation guidance

Since `run` should remain fast for the zero-config case, dependency checking only runs when a `package.json` is detected.

### Change 3: Project-local `@JSONSchema` processing via build API

`createSchemaGenerator()` in `schema.ts` currently imports `ts-json-schema-generator` directly (which bundles its own TypeScript). When the project has explicit config, it should use the project-local version.

The challenge is that `ts-json-schema-generator` is a transitive dependency of `thinkwell`, not something the user declares directly. Resolving it from the project root is unreliable under strict package managers like pnpm, and requiring users to add it as a direct dependency would leak an implementation detail into their contract.

**Approach:** Export a public build API from the `thinkwell` package itself (e.g., `thinkwell/build`) that exposes schema generation functionality. In explicit-config mode, the CLI resolves `thinkwell` from the project's `node_modules` — which is already guaranteed by the dependency check — and calls its exported build API. The `thinkwell` package uses its own `ts-json-schema-generator` dependency internally, so version coordination is automatic and resolution is guaranteed by normal Node.js module resolution.

This avoids:
- Leaking `ts-json-schema-generator` into the user's dependency contract
- Fragile cross-package `require.resolve()` tricks
- Silent fallback to a potentially incompatible bundled version
- The need for a separate `@thinkwell/build` package (the build API ships with `thinkwell` itself, so one dependency covers both runtime and build-time)

### Change 4: Dependency checking for `bundle`

Add the same dependency checking to the `bundle` command. When a `package.json` exists:

1. Check for `thinkwell` and `typescript` dependencies
2. Error with remediation guidance if missing

Since `bundle` already reads `package.json` for configuration (`thinkwell.bundle`), this is a natural extension.

### Change 5: Import transformation in `bundle`

When bundling a project with explicit config, the esbuild plugin's `@JSONSchema` processing should use the project-local `thinkwell` build API rather than the bundled `ts-json-schema-generator`. The esbuild resolver will naturally resolve `thinkwell` imports from the project's `node_modules` since esbuild operates on the real filesystem.

The generated wrapper's `global.__bundled__` setup remains necessary for the *output* binary (which won't have `node_modules` at runtime), but the *build-time* resolution should use project-local versions.

## Architecture

### Module Changes

```
src/cli/
├── loader.ts           # Add explicit-config awareness to module resolution
├── schema.ts           # Support project-local build API for schema generation
├── main.cjs            # Conditional bundled module registration
├── bundle.ts           # Add dependency checking
└── dependency-check.ts # (unchanged, already used by build/check)

src/
├── build.ts            # Public build API (schema generation) exported as thinkwell/build
```

### Config Detection

Reuse the existing `hasPackageJson()` from `dependency-check.ts`. The detection runs once at command startup and the result is threaded through to the loader and schema generator.

For `run`, the relevant `package.json` is found by walking up from the script's directory (not necessarily `cwd`), since the script may be in a subdirectory of the project.

### Phased Implementation

To manage risk, this can be implemented in phases:

1. **Phase 1: Dependency gating** — Add `checkDependencies()` to `run` and `bundle`. This catches the "missing deps" case with actionable errors, without changing resolution behavior.

2. **Phase 2: Conditional bundled module resolution** — Make `global.__bundled__` and `transformVirtualImports()` conditional on explicit-config detection. In explicit-config mode, resolve thinkwell packages from `node_modules`.

3. **Phase 3: Project-local `@JSONSchema` processing** — Resolve `ts-json-schema-generator` from the project's `node_modules` when in explicit-config mode. This ensures schema generation uses the same TypeScript version as the rest of the project.

## Trade-offs

### Advantages

| Aspect | Benefit |
|--------|---------|
| Consistent behavior | All commands follow the same principle |
| Version predictability | Users get the versions they declared |
| Early error detection | Missing deps caught before runtime surprises |
| Existing infrastructure | Reuses `checkDependencies()`, `detectPackageManager()`, etc. |

### Disadvantages

| Aspect | Impact |
|--------|--------|
| Breaking change for `run` | Projects with package.json that relied on bundled versions will see new errors |
| Startup cost for `run` | Dependency checking adds a small overhead when package.json exists |
| New public API surface | `thinkwell/build` export needs to be designed and maintained |

### Migration Path

Same as the explicit-config RFD — existing projects see a clear error message and run `thinkwell init` to add the required dependencies. This is a one-time cost.

## Future Work

### `@thinkwell/build` package

The `thinkwell/build` export introduced in Change 3 solves the immediate problem: the CLI can call the project-local build API without leaking `ts-json-schema-generator` into the user contract.

A future `@thinkwell/build` *package* could go further by encapsulating the full transformation pipeline behind a stable interface, shared across all four consumers:

1. **CLI loader** (`loader.ts`) — runtime transformation for `thinkwell run`
2. **CompilerHost** (`compiler-host.ts`) — build-time transformation for `thinkwell build`/`check`
3. **esbuild plugin** (`bundle.ts`) — bundle-time transformation for `thinkwell bundle`
4. **VS Code TS plugin** (`packages/vscode-ts-plugin/`) — IDE-time virtual declarations

This would allow easier testing, versioning, and a clean extension point if the transformation approach changes. However, it introduces version coordination concerns between packages, so it's deferred until the API surface stabilizes.

## References

- [Issue #33: Thinkwell standalone binary should respect project config](https://github.com/dherman/thinkwell/issues/33)
- [RFD: Explicit Configuration Experience](explicit-config.md)
- [RFD: Node-Native Developer Experience](node-ux.md)
- [RFD: pkg Migration](pkg-migration.md)
