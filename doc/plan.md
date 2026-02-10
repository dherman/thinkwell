# Plan: Node-Native Developer Experience

Implements the [node-ux](rfd/node-ux.md) RFD.

**Prerequisite:** remove-uri-scheme (PR #28, merged).

**Follow-up:** `thinkwell check` will be implemented in a separate PR following the [check-command](rfd/check-command.md) RFD. The CompilerHost infrastructure built here is designed to be shared by both `build` and `check`.

## Phase 1: Rename `build` → `bundle`

- [x] Rename `src/cli/build.ts` → `src/cli/bundle.ts`, update exported function names (`runBuild` → `runBundle`, `parseBuildArgs` → `parseBundleArgs`, `showBuildHelp` → `showBundleHelp`)
- [x] Rename `thinkwell.build` config key to `thinkwell.bundle` in config reading logic
- [x] Update `main.cjs` command routing: `"build"` → `"bundle"`, add `"build"` as a placeholder that errors with a migration message until Phase 3 reclaims it
- [x] Update help text to reflect new `bundle` command name
- [x] Update any references in tests, examples, and scripts

## Phase 2: Custom CompilerHost

The shared infrastructure for both `thinkwell build` and `thinkwell check`.

- [x] Create `src/cli/compiler-host.ts` — custom `ts.CompilerHost` that wraps the default host and intercepts `getSourceFile()` to apply `transformJsonSchemas()` on project files
- [x] Handle the hybrid pattern: transform project source files, pass through `node_modules` / lib files unchanged
- [x] Add helper to read and parse user's `tsconfig.json` via `ts.readConfigFile()` + `ts.parseJsonConfigFileContent()`
- [x] Expose a `createThinkwellProgram(configPath)` function that returns a `ts.Program` wired to the custom host

## Phase 3: `thinkwell build` command (tsc-based)

- [x] Create `src/cli/build.ts` (the new build, reclaiming the name) with `runBuild()`, `parseBuildArgs()`, `showBuildHelp()`
- [x] Implement: resolve `tsconfig.json`, create program via CompilerHost, call `program.emit()`, report diagnostics
- [x] Support `thinkwell.build` config in package.json (`include`/`exclude` globs for controlling which files receive `@JSONSchema` processing)
- [x] Update `main.cjs` to route `"build"` to the new tsc-based build

## Phase 4: Watch mode

- [x] Add `--watch` flag to `thinkwell build`
- [x] Use TypeScript's `ts.createWatchProgram()` with the custom CompilerHost
- [x] Support incremental compilation (`--incremental` / `.tsbuildinfo`)
