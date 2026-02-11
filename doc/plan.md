# Explicit Configuration Experience

Implementation plan for [RFD: Explicit Configuration Experience](rfd/explicit-config.md).

## Phase 1: Package Manager Detection

- [x] Create `src/cli/package-manager.ts` module
- [x] Implement lockfile detection (pnpm-lock.yaml, yarn.lock, package-lock.json)
- [x] Implement `packageManager` field parsing as fallback
- [x] Export `detectPackageManager()` function
- [x] Add unit tests for detection logic

## Phase 2: Dependency Check

- [x] Create `src/cli/dependency-check.ts` module
- [x] Implement fast path: check `package.json` for deps directly
- [x] Implement slow path: `pnpm why --json` parsing
- [x] Implement slow path: `npm why --json` parsing
- [x] Implement slow path: `yarn why --json` parsing
- [x] Export `checkDependencies()` function
- [x] Add unit tests for each package manager's output format

## Phase 3: Error Messages

- [x] Create error message templates with package-manager-specific commands
- [x] Integrate dependency check into `thinkwell build`
- [x] Integrate dependency check into `thinkwell check`
- [x] Add integration tests for error scenarios

## Phase 4: `thinkwell init` Command

- [ ] Create `src/cli/init.ts` module
- [ ] Implement interactive mode (TTY detection, prompts)
- [ ] Implement `--yes` flag for non-interactive mode
- [ ] Add version detection (match CLI binary versions)
- [ ] Wire up to CLI argument parser
- [ ] Add integration tests

## Phase 5: Test Fixture Updates

- [x] Update `test-fixtures/node-ux-project` to have explicit dependencies
- [x] Update test setup to use proper dependency resolution
- [x] Verify all existing tests pass with new behavior
