# Explicit Configuration Experience

Implementation plan for [RFD: Explicit Configuration Experience](rfd/explicit-config.md).

## Phase 1: Package Manager Detection

- [ ] Create `src/cli/package-manager.ts` module
- [ ] Implement lockfile detection (pnpm-lock.yaml, yarn.lock, package-lock.json)
- [ ] Implement `packageManager` field parsing as fallback
- [ ] Export `detectPackageManager()` function
- [ ] Add unit tests for detection logic

## Phase 2: Dependency Check

- [ ] Create `src/cli/dependency-check.ts` module
- [ ] Implement fast path: check `package.json` for deps directly
- [ ] Implement slow path: `pnpm why --json` parsing
- [ ] Implement slow path: `npm why --json` parsing
- [ ] Implement slow path: `yarn why --json` parsing
- [ ] Export `checkDependencies()` function
- [ ] Add unit tests for each package manager's output format

## Phase 3: Error Messages

- [ ] Create error message templates with package-manager-specific commands
- [ ] Integrate dependency check into `thinkwell build`
- [ ] Integrate dependency check into `thinkwell check`
- [ ] Add integration tests for error scenarios

## Phase 4: `thinkwell init` Command

- [ ] Create `src/cli/init.ts` module
- [ ] Implement interactive mode (TTY detection, prompts)
- [ ] Implement `--yes` flag for non-interactive mode
- [ ] Add version detection (match CLI binary versions)
- [ ] Wire up to CLI argument parser
- [ ] Add integration tests

## Phase 5: Test Fixture Updates

- [ ] Update `test-fixtures/node-ux-project` to have explicit dependencies
- [ ] Update test setup to use proper dependency resolution
- [ ] Verify all existing tests pass with new behavior
