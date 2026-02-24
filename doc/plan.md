# Plan: Standalone Binary Should Respect Project Config

**Issue:** [#33](https://github.com/dherman/thinkwell/issues/33)
**RFD:** [doc/rfd/project-config.md](rfd/project-config.md)

## Phase 1: Dependency gating for `run` and `bundle`

- [x] Add `findProjectRoot(startDir)` utility that walks up from a directory to find the nearest `package.json` (reusable across `run` and `bundle`)
- [x] Add dependency checking to `runUserScript()` in `main.cjs` — when `package.json` found, call `checkDependencies()` and error if missing
- [x] Add dependency checking to `runBundle()` in `bundle.ts` — same pattern as `build`/`check`
- [x] For `run`, only require `typescript` if the script contains `@JSONSchema` markers (read + check before gating)

## Phase 2: Conditional bundled module resolution in `run`

- [x] Thread an `explicitConfig` flag from `main.cjs` into the loader (via `runScript()` parameter or a module-level setter)
- [x] In `createCustomRequire()`: skip `global.__bundled__` lookup when `explicitConfig` is true, resolve thinkwell packages from `node_modules` instead
- [x] In `loadScript()`: skip `transformVirtualImports()` when `explicitConfig` is true — leave thinkwell imports as-is so they resolve through `node_modules` via the custom require
- [x] Skip `registerBundledModules()` in `main.cjs` when explicit config detected (no need to populate `global.__bundled__`)

## Phase 3: Project-local `@JSONSchema` processing

- [x] In `createSchemaGenerator()` in `schema.ts`: accept an optional `projectDir` parameter for resolving `ts-json-schema-generator` from `node_modules`
- [x] When `explicitConfig` is true, use `require.resolve('ts-json-schema-generator', { paths: [projectDir] })` to load the project-local version
- [x] Fall back to bundled version if project-local resolution fails (transitive dep may not be directly resolvable)
- [x] Thread `projectDir` through `transformJsonSchemas()` → `generateSchemas()` → `createSchemaGenerator()`
- [x] Update callers in `loader.ts`, `compiler-host.ts`, and `bundle.ts` to pass project dir when in explicit-config mode

## Testing

- [ ] Add test: `run` with no `package.json` uses bundled modules (zero-config unchanged)
- [ ] Add test: `run` with `package.json` missing thinkwell dep errors with guidance
- [ ] Add test: `run` with `package.json` and deps resolves from `node_modules`
- [ ] Add test: `bundle` with `package.json` missing deps errors with guidance
- [ ] Add test: `@JSONSchema` processing uses project-local TS when available
