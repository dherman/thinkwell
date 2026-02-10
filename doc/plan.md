# Plan: `thinkwell check` Command

## Overview

Implement `thinkwell check` per [the RFD](rfd/check-command.md). The custom CompilerHost and single-package type-checking infrastructure already exist from the node-ux PR (`compiler-host.ts`, `build.ts`). The remaining work is the check command itself and workspace detection.

## Tasks

### Workspace Detection

- [x] Create `packages/thinkwell/src/cli/workspace.ts` with logic to detect pnpm workspaces (`pnpm-workspace.yaml`) and npm workspaces (`package.json` `"workspaces"`)
- [x] Enumerate workspace member directories (expand glob patterns), read each `package.json` for name and each directory for `tsconfig.json` presence
- [x] Package name resolution: exact match on full name, short-name fallback on last segment of scoped names, ambiguity detection
- [x] Unit tests for workspace detection and package resolution

### Check Command

- [x] Create `packages/thinkwell/src/cli/check.ts` implementing the check logic:
  - Parse `--package`/`-p` and `--pretty`/`--no-pretty` flags
  - Single-package path: resolve `tsconfig.json`, call `createThinkwellProgram()`, run `getPreEmitDiagnostics()`, format and print diagnostics
  - Workspace path: detect workspace, resolve packages, iterate and check each
  - Exit codes: 0 (pass), 1 (type errors), 2 (config error)
  - Diagnostic output formatting matching the RFD examples (`Checking <pkg>... ok` / error details / summary)
- [x] Wire `check` subcommand into `main.cjs` command routing

### Integration Tests

- [x] Integration test with a minimal fixture project (no `@JSONSchema`) — expect clean check
- [x] Integration test with `@JSONSchema` fixture — expect clean check (reuse existing `node-ux-project` fixture)
- [x] Integration test with intentional type error — expect exit code 1 and error output
- [x] Integration test for workspace mode with multiple packages
