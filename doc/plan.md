# Implementation Plan: Migrate Binary Distribution from Bun to pkg

This plan implements the design in [doc/rfd/pkg-migration.md](rfd/pkg-migration.md).

## Phase 1: Build Infrastructure

- [x] Add `@yao-pkg/pkg` as a dev dependency to `packages/thinkwell`
- [x] Create `packages/thinkwell/scripts/build-binary-pkg.ts` build script
- [x] Add pkg build scripts to package.json (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
- [x] Configure pkg in package.json (assets, scripts, targets)
- [x] Test that pkg can bundle the existing CLI entry point

## Phase 2: Loader Implementation

- [x] Create `packages/thinkwell/src/cli/loader.ts` with custom require function
- [x] Implement `createCustomRequire(scriptDir)` for bundled vs external resolution
- [x] Create `global.__bundled__` registry initialization
- [x] Port `transformVirtualImports()` from bun-plugin to work with string replacement
- [x] Implement script loading via `vm.runInThisContext()` with custom require injection
- [x] Handle shebang stripping for executable user scripts

## Phase 3: CLI Entry Point

- [x] Expand `packages/thinkwell/src/cli/main-pkg.cjs` with full CLI functionality
- [x] Register bundled thinkwell packages to `global.__bundled__`
- [x] Integrate loader for user script execution
- [x] Support all existing commands: `init`, `types`, `run` (default)
- [x] Ensure `init` command works (already pure Node.js)

Note: Script execution now works after Phase 4 resolved pkg's ESM bundling
limitations by pre-bundling thinkwell packages into CJS format.

## Phase 4: TypeScript Support

- [x] Test Node 24's `--experimental-strip-types` with pkg `--options` flag
- [x] Verify user `.ts` scripts work with type stripping
- [x] Test complex TypeScript patterns (generics, type-only imports)
- [x] Document unsupported TypeScript features (enums, namespaces, decorators)
- [x] Consider `--experimental-transform-types` as fallback if needed

### Implementation Notes (Phase 4)

**ESM bundling solution**: pkg doesn't properly resolve ESM imports inside its
`/snapshot/` virtual filesystem. Solution: pre-bundle thinkwell packages into
CJS format using esbuild (`scripts/bundle-for-pkg.ts` → `dist-pkg/*.cjs`).

**TypeScript loading strategy**: Two paths based on whether transformation needed:
1. **Direct require()** - Scripts without thinkwell imports use Node's native
   type stripping via direct `require()`.
2. **Transform + temp file** - Scripts with `thinkwell:*` or bundled package
   imports are transformed, written to a temp file, then required.

**Supported TypeScript features** (strip-only mode):
- Type annotations, interfaces, type aliases
- Generic functions and classes (no parameter properties)
- Type-only imports (`import type {...}`, inline `type` specifier)
- Type assertions (`as` keyword)

**Unsupported features** (require `--experimental-transform-types`):
- Enums (regular and const)
- Namespaces
- Parameter properties (`constructor(public x: number)`)
- Legacy decorators
- JSX in `.ts` files

**Decision on transform-types**: Not implementing as fallback. The unsupported
features are uncommon in modern TypeScript, and documenting them is sufficient.
Users needing these features can pre-compile their scripts.

## Phase 5: @JSONSchema Processing

- [x] Port schema generation from bun-plugin to work standalone
- [x] Read TypeScript source, process with ts-json-schema-generator, inject namespace
- [x] Integrate schema processing into the loader pipeline
- [x] Test with existing @JSONSchema examples

### Implementation Notes (Phase 5)

**Schema module location**: Created `packages/thinkwell/src/cli/schema.ts` as a
standalone port of the schema generation from bun-plugin. The module includes:
- `findMarkedTypes()` - TypeScript AST traversal to find @JSONSchema-marked types
- `generateSchemas()` - Uses ts-json-schema-generator to create JSON schemas
- `generateInsertions()` - Creates namespace declarations with SchemaProvider
- `transformJsonSchemas()` - Main entry point that orchestrates the pipeline

**Bundling approach**: The CLI loader (including schema module) is pre-bundled
into `dist-pkg/cli-loader.cjs` using esbuild. This bundles ts-json-schema-generator
and typescript into a single CJS file (~11MB) that pkg can resolve correctly.

**TypeScript mode change**: Switched from `--experimental-strip-types` to
`--experimental-transform-types` because @JSONSchema generates TypeScript
namespace declarations, which require transformation (not just stripping).
This enables full TypeScript support including namespaces, enums, and decorators.

**Dependencies added**: Added `ts-json-schema-generator` and `typescript` as
direct dependencies of the thinkwell package (previously only in bun-plugin).

## Phase 6: npm Distribution Update

- [ ] Update `packages/thinkwell/bin/thinkwell` launcher to detect pkg vs npm mode
- [ ] Maintain Bun subprocess spawn for npm distribution (existing behavior)
- [ ] Add detection for running as pkg binary (`process.pkg` check)
- [ ] Ensure identical behavior between npm and binary distributions

## Phase 7: Testing

- [ ] Port existing binary tests to use pkg-built binaries
- [ ] Add integration test: user script imports from node_modules
- [ ] Add integration test: ESM user script via require(esm)
- [ ] Add integration test: TypeScript user script
- [ ] Add integration test: @JSONSchema type processing
- [ ] Test on all target platforms (CI matrix)

## Phase 8: Documentation & Cleanup

- [ ] Update installation documentation with pkg binary instructions
- [ ] Document top-level await limitation for ESM scripts
- [ ] Document unsupported TypeScript features
- [ ] Remove or deprecate Bun-specific binary build scripts
- [ ] Update cli-distribution.md RFD with new architecture

## Notes

- Keep existing npm distribution working throughout migration
- pkg binary uses Node 24 with `--experimental-transform-types` (for namespace support)
- ESM support via `require(esm)` - no top-level await in user scripts
- Binary size expected: ~63 MB (vs ~45 MB for Bun)
