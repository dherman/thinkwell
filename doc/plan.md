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

## Phase 3: Advanced Features

- [ ] Add `--external` flag to exclude specific packages from bundling
- [ ] Support configuration in `package.json` under `"thinkwell"` key
- [ ] Add `--minify` flag for smaller binaries
- [ ] Implement `--watch` mode for development iteration
