# Implementation Plan: CLI Distribution

Based on [RFD: CLI Distribution](rfd/cli-distribution.md)

## Phase 1: Pre-release npm Package

- [x] Create `thinkwell` package structure with Node-compatible CLI entry point
- [x] Implement argument parsing for core commands (`run`, `init`, `types`, `--help`, `--version`)
- [x] Implement Bun runtime detection with helpful error messages
- [x] Implement `run` command that spawns Bun with the thinkwell plugin
- [x] Implement `init` command for project scaffolding (no Bun required)
- [x] Add `engines` field requiring Node >= 18
- [x] Publish pre-release (`0.3.0-alpha.1`) to npm with `next` tag
- [x] Test CLI installation via `npx thinkwell@next`

## Phase 2: Homebrew Distribution

- [x] Create `homebrew/` directory in monorepo with Formula structure
- [x] Write npm-based Homebrew formula with Bun caveat
- [x] Test installation via `brew install dherman/thinkwell/thinkwell`

## Phase 3: Binary Build of Thinkwell CLI

- [x] Create build script using `bun build --compile` for self-contained executables
- [x] Build binaries for darwin-arm64 and darwin-x64
- [x] Test binaries work without Node.js installed
- [x] Verify dynamic import of external TypeScript files works in compiled binary
- [x] Verify @JSONSchema transformation works without external Bun installation
- [x] Verify thinkwell:* import resolution works in compiled binary

## Phase 4: Homebrew Bottles (Self-Contained)

- [ ] Set up GitHub Releases as bottle distribution host
- [ ] Create release automation to build and upload binaries for all platforms
- [ ] Update Homebrew formula to use binary distribution (no npm/Node.js dependency)
- [ ] Remove Bun caveat from formula (binary is fully self-contained)
- [ ] Test `brew install` downloads bottle and runs without external Bun

## Phase 5: Set up Homebrew Account

- [ ] Create Homebrew account for publishing releases
- [ ] Configure authentication for bottle uploads
- [ ] Verify account permissions and tap ownership

## Phase 6: Publish Bottle to Homebrew

- [ ] Publish initial thinkwell bottle to Homebrew
- [ ] Verify bottle installation works for end users
- [ ] Document bottle update process for future releases

## Phase 7: Stable Release

- [ ] Iterate with additional pre-release versions as needed
- [ ] Publish stable `0.3.0` to npm under `latest` tag
- [ ] Update Homebrew formula to point to stable release

## Phase 8: Documentation

- [ ] Write installation guide with tabbed package manager examples
- [ ] Document two-tier distribution: npm (requires Bun) vs binary (self-contained)
- [ ] For npm users: frame Bun requirement as feature (TypeScript-native, schema generation)
- [ ] For Homebrew users: emphasize zero-dependency installation experience
- [ ] Add troubleshooting section for common issues
- [ ] Document CI/CD installation patterns (both npm+Bun and direct binary approaches)
