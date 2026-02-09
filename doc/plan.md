# Plan: `thinkwell check` Command

See [RFD](rfd/check-command.md) for design rationale.

## Phase 1: Core Implementation

- [ ] Custom CompilerHost with thinkwell language extension support
  - [ ] `thinkwell:*` import specifier resolution
  - [ ] `@JSONSchema` ambient namespace declaration injection
- [ ] Workspace detection (pnpm-workspace.yaml, package.json workspaces)
- [ ] Package name resolution (`--package` flag with full and short names)
- [ ] Multi-package sequential checking with per-package status reporting
- [ ] `check` command handler in `packages/thinkwell/src/cli/check.ts`
- [ ] Command dispatch in `main.cjs`
- [ ] Add `check` to help text
- [ ] Bundle as `cli-check.cjs` in `scripts/bundle.ts`

## Deferred

- `@JSONSchema` deep validation (actually running `ts-json-schema-generator`)
- Conductor protocol compliance checking
- Parallel type checking across workspace packages
