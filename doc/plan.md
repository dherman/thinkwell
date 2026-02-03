# Implementation Plan: `thinkwell build` Command

This plan implements the `thinkwell build` command as described in [RFD: user-build-command.md](rfd/user-build-command.md).

## Phase 1: Core Command

- [x] Add `build` subcommand to CLI parser in `src/cli/main.ts`
- [x] Implement argument parsing for `--output`, `--target`, `--include`, `--verbose`
- [x] Create `src/cli/build.ts` module with build orchestration logic
- [x] Reuse existing `bundle-for-pkg.ts` logic for the bundling stage
- [x] Generate wrapper entry point that sets up `global.__bundled__`
- [x] Invoke pkg programmatically using `@yao-pkg/pkg` API

## Phase 2: User Experience

- [x] Add progress indicators (spinner during bundling, step completion checkmarks)
- [x] Implement `--dry-run` flag to show what would be built
- [x] Add helpful error messages for common failures (missing dependencies, unsupported platform)
- [x] Detect and warn about top-level await usage (not supported)
- [x] Support `--quiet` flag for CI environments

## Phase 3: Compiled Binary Support

Enable the `build` command to work when thinkwell itself is running as a compiled pkg binary.
See [RFD: user-build-command.md](rfd/user-build-command.md#embedding-esbuild-in-the-compiled-binary) for details.

### Stage 1: esbuild Embedding (Complete)

- [x] Add esbuild platform binaries as pkg assets in build configuration
- [x] Implement `isRunningFromCompiledBinary()` detection (check for `process.pkg`)
- [x] Create esbuild binary extraction logic to `~/.cache/thinkwell/esbuild/`
- [x] Set `ESBUILD_BINARY_PATH` environment variable before loading esbuild
- [x] Convert static esbuild import to dynamic import in `build.ts`
- [x] Add version-based cache invalidation (re-extract on thinkwell version change)
- [x] Test build command works from compiled binary end-to-end

### Stage 2: pkg Compilation via Portable Node.js

See [RFD: Chosen Solution](rfd/user-build-command.md#chosen-solution-download-portable-nodejs--bundled-pkg-cli) for full design.

**Build-time preparation:**
- [x] Create `scripts/bundle-pkg-cli.ts` to bundle `@yao-pkg/pkg` CLI into single CJS file
- [x] Add `dist-pkg/pkg-cli.cjs` to pkg assets configuration
- [x] Update `bundle-for-pkg.ts` to run pkg CLI bundling before binary compilation

**Runtime Node.js download:**
- [x] Implement `ensurePortableNode()` in `build.ts` with progress indicator
- [x] Download from nodejs.org with platform/arch detection
- [x] Verify SHA-256 checksum against nodejs.org SHASUMS256.txt
- [x] Extract and cache to `~/.cache/thinkwell/node/v<version>/`
- [x] Support `THINKWELL_CACHE_DIR` environment variable override

**Runtime pkg CLI extraction:**
- [x] Implement `ensurePkgCli()` to extract bundled pkg CLI from snapshot
- [x] Cache to `~/.cache/thinkwell/pkg-cli/<thinkwell-version>/`

**Subprocess execution:**
- [x] Modify `compileWithPkg()` to spawn `<cached-node> <pkg-cli.cjs> ...` when in compiled binary
- [x] Pass through pkg arguments (--targets, --output, --config)
- [x] Set `PKG_CACHE_PATH` for pkg-fetch downloads
- [x] Handle subprocess stdout/stderr for progress and errors

**Error handling:**
- [x] Network failure with retry guidance
- [x] Checksum mismatch with clear error message
- [x] Proxy support via HTTPS_PROXY/HTTP_PROXY (via standard Node.js fetch)

**Testing:**
- [ ] Unit tests for download/extraction with mocks
- [ ] Integration test for cache invalidation logic
- [ ] E2E test: full build from compiled binary (CI only)

## Phase 4: Advanced Features

- [ ] Add `--external` flag to exclude specific packages from bundling
- [ ] Support configuration in `package.json` under `"thinkwell"` key
- [ ] Add `--minify` flag for smaller binaries
- [ ] Implement `--watch` mode for development iteration

## Deferred

- [ ] Disk space detection and helpful message before Node.js download
