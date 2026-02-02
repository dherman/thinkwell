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

- [ ] Expand `packages/thinkwell/src/cli/main-pkg.cjs` with full CLI functionality
- [ ] Register bundled thinkwell packages to `global.__bundled__`
- [ ] Integrate loader for user script execution
- [ ] Support all existing commands: `init`, `types`, `run` (default)
- [ ] Ensure `init` command works (already pure Node.js)

## Phase 4: TypeScript Support

- [ ] Test Node 24's `--experimental-strip-types` with pkg `--options` flag
- [ ] Verify user `.ts` scripts work with type stripping
- [ ] Test complex TypeScript patterns (generics, type-only imports)
- [ ] Document unsupported TypeScript features (enums, namespaces, decorators)
- [ ] Consider `--experimental-transform-types` as fallback if needed

## Phase 5: @JSONSchema Processing

- [ ] Port schema generation from bun-plugin to work standalone
- [ ] Read TypeScript source, process with ts-json-schema-generator, inject namespace
- [ ] Integrate schema processing into the loader pipeline
- [ ] Test with existing @JSONSchema examples

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
- pkg binary will use Node 24 with `--experimental-strip-types`
- ESM support via `require(esm)` - no top-level await in user scripts
- Binary size expected: ~63 MB (vs ~45 MB for Bun)
