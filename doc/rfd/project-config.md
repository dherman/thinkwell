# RFD: Standalone Binary Should Respect Project Config

- **Depends on:** [explicit-config](completed/explicit-config.md), [node-ux](completed/node-ux.md)
- **Issue:** [#33](https://github.com/dherman/thinkwell/issues/33)

## Summary

The `thinkwell` standalone binary unconditionally uses its bundled versions of thinkwell, TypeScript, and `ts-json-schema-generator` for script execution (`thinkwell run`), bundling (`thinkwell bundle`), and `@JSONSchema` processing — even when the project has a `package.json` with explicit dependency declarations. This violates the principle established in [explicit-config](completed/explicit-config.md): a `package.json` signals user intent to manage dependencies explicitly, and bundled versions should defer to declared versions.

This RFD extends the explicit-config principle to all CLI commands, not just `build` and `check`.

## Problem Statement

The [explicit-config RFD](completed/explicit-config.md) established a clear rule: when a project has a `package.json`, the CLI should use project-declared dependency versions and error if required dependencies are missing. This was implemented for `thinkwell build` and `thinkwell check`, but three gaps remain:

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

### Change 3: Project-local `@JSONSchema` processing

`createSchemaGenerator()` in `schema.ts` currently imports `ts-json-schema-generator` directly (which bundles its own TypeScript). When the project has explicit config, it should use the project-local `typescript` and `ts-json-schema-generator`.

This is the trickiest change because `ts-json-schema-generator` is a build-time dependency of the CLI itself. In the bundled binary, it lives in the pkg snapshot. To use the project-local version, we need to `require.resolve()` it from the project's `node_modules`.

**Approach:** When in explicit-config mode, resolve `ts-json-schema-generator` from the project's `node_modules`. If it's not installed (it's a transitive dependency of `thinkwell`), fall back to the bundled version. The key point is that the project-local `thinkwell` package should bring `ts-json-schema-generator` as a dependency, so resolving it from the project's `node_modules` should work once `thinkwell` is installed as a project dependency.

### Change 4: Dependency checking for `bundle`

Add the same dependency checking to the `bundle` command. When a `package.json` exists:

1. Check for `thinkwell` and `typescript` dependencies
2. Error with remediation guidance if missing

Since `bundle` already reads `package.json` for configuration (`thinkwell.bundle`), this is a natural extension.

### Change 5: Import transformation in `bundle`

When bundling a project with explicit config, the esbuild plugin's `@JSONSchema` processing should use the project-local `ts-json-schema-generator` rather than the bundled one. The esbuild resolver will naturally resolve `thinkwell` imports from the project's `node_modules` since esbuild operates on the real filesystem.

The generated wrapper's `global.__bundled__` setup remains necessary for the *output* binary (which won't have `node_modules` at runtime), but the *build-time* resolution should use project-local versions.

## Architecture

### Module Changes

```
src/cli/
├── loader.ts           # Add explicit-config awareness to module resolution
├── schema.ts           # Support project-local ts-json-schema-generator
├── main.cjs            # Conditional bundled module registration
├── bundle.ts           # Add dependency checking
└── dependency-check.ts # (unchanged, already used by build/check)
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
| `ts-json-schema-generator` resolution complexity | Need to handle the case where it's a transitive dep of thinkwell |

### Migration Path

Same as the explicit-config RFD — existing projects see a clear error message and run `thinkwell init` to add the required dependencies. This is a one-time cost.

## Future Work

### `@thinkwell/build` package

The `@JSONSchema` transformation logic is currently duplicated across four consumers:

1. **CLI loader** (`loader.ts`) — runtime transformation for `thinkwell run`
2. **CompilerHost** (`compiler-host.ts`) — build-time transformation for `thinkwell build`/`check`
3. **esbuild plugin** (`bundle.ts`) — bundle-time transformation for `thinkwell bundle`
4. **VS Code TS plugin** (`packages/vscode-ts-plugin/`) — IDE-time virtual declarations

Each wires up its own pipeline using `transformJsonSchemas()` from `schema.ts` (except the VS Code plugin, which has its own scanner-based approach).

A future `@thinkwell/build` package could encapsulate the transformation pipeline behind a stable interface, allowing:

- Shared logic between all four consumers
- The `ts-json-schema-generator` dependency to be an implementation detail
- Easier testing and versioning of the transformation logic
- A clean extension point if the transformation approach changes (e.g., replacing `ts-json-schema-generator` with a custom solution)

This refactoring is out of scope for the current issue but would simplify the project-config resolution problem: instead of each consumer needing to conditionally resolve `ts-json-schema-generator`, they'd all go through `@thinkwell/build` which handles it internally.

## References

- [Issue #33: Thinkwell standalone binary should respect project config](https://github.com/dherman/thinkwell/issues/33)
- [RFD: Explicit Configuration Experience](completed/explicit-config.md)
- [RFD: Node-Native Developer Experience](completed/node-ux.md)
- [RFD: pkg Migration](completed/pkg-migration.md)
