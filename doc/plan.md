# Build-Time Feature Flags

## Implementation Plan

- [x] Create `features.json` at monorepo root (empty initial config)
- [x] Add `ts-morph` as a root dev dependency
- [x] Create `scripts/generate-features.ts` — reads `features.json`, writes `src/generated/features.ts` per package
- [x] Create `scripts/strip-features.ts` — ts-morph for declaration stripping + esbuild transform for dead branch elimination
- [x] Update `.gitignore` to exclude `src/generated/`
- [x] Update root `package.json` scripts (`build`, `build:debug`, `generate-features`)
- [x] Update per-package `package.json` scripts (`build`, `build:debug`)
- [x] Update `.github/workflows/ci.yml` to add debug-mode test job
- [x] Verify: `pnpm build` (release) and `pnpm build:debug` both succeed
- [x] Verify: tests pass in both modes
