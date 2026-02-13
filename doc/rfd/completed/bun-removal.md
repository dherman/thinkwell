# RFD: Remove Bun Remnants from Codebase

- **Depends on:** [pkg-migration](./pkg-migration.md)
- **Implemented:** [PR #20](https://github.com/dherman/thinkwell/pull/20)

## Summary

Following the successful migration from Bun to pkg for binary distribution (see [pkg-migration.md](./pkg-migration.md)), this document proposes removing all remaining Bun references from the codebase. The `@thinkwell/bun-plugin` package and associated code are now deprecated and should be removed to reduce maintenance burden and eliminate confusion.

## Background

The project previously used Bun for:
1. **Binary distribution** via `bun build --compile`
2. **@JSONSchema processing** via Bun plugins that intercepted TypeScript imports
3. **File watching** via Bun's `Glob` API for the `types --watch` command
4. **Testing** via `bun:test`

The pkg migration (completed in [pkg-migration.md](./pkg-migration.md)) replaced the binary distribution approach, but left the `@thinkwell/bun-plugin` package in place. That package is no longer used by the pkg-based binary and should be removed.

## Current State

### Files/Packages to Remove

#### 1. `@thinkwell/bun-plugin` Package (entire directory)
**Location:** `packages/bun-plugin/`

This package contains ~18 source files with Bun-specific code:
- `index.ts` - Bun plugin registration (`import { plugin, type BunPlugin } from "bun"`)
- `watcher.ts` - Uses `Glob` from Bun
- `declarations.ts` - Uses `Glob` from Bun
- `codegen.ts`, `transform.ts`, `schema-generator.ts`, etc.
- 7 test files using `bun:test`

**Why remove:** The pkg binary uses `dist-pkg/cli-loader.cjs` for @JSONSchema processing, which is a standalone implementation that doesn't depend on Bun APIs.

#### 2. `main.ts` - Bun Entry Point
**Location:** `packages/thinkwell/src/cli/main.ts`

This is the original Bun-native CLI entry point with:
- Line 1: `#!/usr/bin/env bun` shebang
- Lines 3-12: Comments referencing Bun compilation
- Line 20: `import { registerModule } from "@thinkwell/bun-plugin"`
- Lines 62-65: Import from `@thinkwell/bun-plugin` for types command

**Why remove:** The pkg binary uses `main-pkg.cjs` as its entry point. This file is dead code.

### Dependencies to Remove

#### From `packages/thinkwell/package.json`
```json
"@thinkwell/bun-plugin": "workspace:*"
```

#### From `packages/bun-plugin/package.json` (entire file deleted with package)
```json
"@types/bun": "^1.2.4"
```

#### From root `pnpm-lock.yaml`
- `bun-types` entries
- `@types/bun` entries

### Documentation Updates

#### 1. `README.md`
Line 32 lists `@thinkwell/bun-plugin` in the monorepo packages list.

#### 2. `AGENTS.md`
Lines 7-18 contain warnings about not using Bun. After removal, these warnings can be simplified or converted to historical context.

### Archived RFDs (keep for historical reference)
- `doc/rfd/rejected/bun-schema-plugin.md`
- `doc/rfd/rejected/cli-distribution-bun.md`
- `doc/rfd/rejected/binary-module-resolution.md`

These should remain in the archive as they document the decision-making process.

## Proposal

### Phase 1: Remove `@thinkwell/bun-plugin` Package

1. Delete `packages/bun-plugin/` directory entirely
2. Remove workspace reference from root `pnpm-workspace.yaml` (if present)
3. Run `pnpm install` to update lockfile

### Phase 2: Remove Bun Entry Point

1. Delete `packages/thinkwell/src/cli/main.ts`
2. Rename `main-pkg.cjs` to `main.cjs` (optional, for clarity)

### Phase 3: Update Dependencies

1. Remove `@thinkwell/bun-plugin` from `packages/thinkwell/package.json` dependencies
2. Verify no other packages reference bun-plugin
3. Run `pnpm install` to clean up lockfile

### Phase 4: Update Documentation

1. Update `README.md` to remove bun-plugin from package list
2. Simplify `AGENTS.md` Bun warnings to a brief historical note:
   ```markdown
   ## Historical Note: Bun Migration

   This project previously used Bun for binary distribution but migrated to pkg
   due to module resolution limitations. See [doc/rfd/pkg-migration.md](doc/rfd/pkg-migration.md)
   for details.
   ```

### Phase 5: Verify `types` Command

The `types` command in `main-pkg.cjs` currently shows a placeholder message:
```javascript
console.log("The 'types' command requires @JSONSchema processing.");
console.log("This feature will be available in a future release.");
```

**Options:**
1. **Remove the command** - If `types` is not needed for the pkg binary
2. **Implement it** - Port the declaration generation from bun-plugin to work with Node.js

**Recommendation:** Implement the `types` command using Node.js APIs. The core logic in `bun-plugin/src/declarations.ts` is mostly Bun-agnostic except for:
- `Glob` usage → Replace with `node:fs` + glob patterns or `fast-glob` package
- File watching → Replace with `node:fs/promises` watch or `chokidar`

## Migration Checklist

- [ ] Delete `packages/bun-plugin/` directory
- [ ] Delete `packages/thinkwell/src/cli/main.ts`
- [ ] Remove `@thinkwell/bun-plugin` from thinkwell package.json
- [ ] Update `README.md` package list
- [ ] Simplify `AGENTS.md` Bun warnings
- [ ] Run `pnpm install` to update lockfile
- [ ] Verify build still works: `pnpm build`
- [ ] Verify binary build: `pnpm --filter thinkwell build:binary`
- [ ] Decide on `types` command implementation (separate task)

## Impact Assessment

### Breaking Changes
- **None** - The `@thinkwell/bun-plugin` package was internal and not published to npm
- Users of the pkg binary or npm distribution are unaffected

### Risk Assessment
- **Low** - The code being removed is dead code that isn't executed by either the pkg binary or npm distribution
- The pkg binary already has its own implementation of @JSONSchema processing

### Testing
- Run existing test suite after removal
- Build and test pkg binary
- Verify `thinkwell run`, `thinkwell build`, and `thinkwell init` commands work

## Alternatives Considered

### Keep bun-plugin as deprecated
**Pros:** No immediate work required
**Cons:** Ongoing maintenance burden, confusion about which code is active, Bun API drift

### Extract reusable code before deletion
**Pros:** Could reuse schema generation logic
**Cons:** The pkg loader already has its own implementation; adding complexity for marginal benefit

## Open Questions

1. **Should `types` command be ported?** The declaration generation for IDE support is useful, but may warrant a separate implementation task.

2. **Should tests be ported?** The bun-plugin tests cover schema generation logic. Some may be worth porting to Node.js test runner for the cli-loader.

## References

- [RFD: pkg Migration](./pkg-migration.md) - Documents the migration from Bun to pkg
- [RFD: Bun Schema Plugin](../rejected/bun-schema-plugin.md) - Original Bun plugin design
- [RFD: CLI Distribution (Bun)](../rejected/cli-distribution-bun.md) - Original Bun distribution approach
