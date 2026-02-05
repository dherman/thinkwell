# Implementation Plan: Remove Bun Remnants

RFD: [doc/rfd/bun-removal.md](rfd/bun-removal.md)

## Phase 1: Remove `@thinkwell/bun-plugin` Package

- [x] Delete `packages/bun-plugin/` directory
- [x] Remove from `pnpm-workspace.yaml` if listed (not needed - uses glob pattern)

## Phase 2: Remove Bun Entry Point

- [x] Delete `packages/thinkwell/src/cli/main.ts`

## Phase 3: Update Dependencies

- [x] Remove `@thinkwell/bun-plugin` from `packages/thinkwell/package.json` dependencies
- [x] Run `pnpm install` to update lockfile

## Phase 4: Update Documentation

- [x] Update `README.md` to remove bun-plugin from packages list
- [x] Simplify `AGENTS.md` Bun warnings to historical note

## Phase 5: Verification

- [ ] Run `pnpm build` to verify build works
- [ ] Run `pnpm --filter thinkwell build:binary` to verify binary build
- [ ] Test CLI commands: `run`, `build`, `init`

## Out of Scope (Future Work)

- Port `types` command to Node.js (currently shows placeholder in pkg binary)
- Port bun-plugin tests to Node.js test runner
