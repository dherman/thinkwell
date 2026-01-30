# Implementation Plan: Thinkwell CLI and Bun Plugin

This plan tracks the implementation of the `thinkwell` CLI and Bun plugin for automatic schema generation, as described in [RFD: Thinkwell CLI and Bun Plugin](./rfd/bun-schema-plugin.md).

## Phase 1: Core Plugin

- [x] Create `@thinkwell/bun-plugin` package structure
- [x] Implement `onLoad` hook with `@JSONSchema` detection
- [x] Integrate ts-json-schema-generator for schema extraction
- [x] Generate namespace injections
- [x] Add basic mtime-based caching
- [x] Implement `onResolve` hook for `thinkwell:*` URI scheme
- [x] Update codegen to import from `thinkwell:acp` instead of `@thinkwell/acp`

## Phase 2: CLI

- [x] Create `@thinkwell/cli` package structure
- [x] Bundle thinkwell modules for `thinkwell:*` resolution (via workspace dependencies)
- [x] Implement Bun delegation with plugin preload
- [x] Add `--help` and `--version` flags
- [x] Set up npm distribution with Node.js launcher (`bin/thinkwell`)
- [x] Test shebang support (macOS verified)
- [x] Fix bun-plugin for Bun runtime plugin compatibility (transpile workaround)
- [x] Handle shebang stripping in plugin

## Phase 3: IDE Support

- [x] Generate ambient `.d.ts` files for type checking
- [x] Add file watcher to regenerate declarations on changes
- [x] Document tsconfig.json setup for IDE integration (see README.md)

## Phase 4: Cross-File Types

- [ ] Use `ts.createProgram()` for full type resolution
- [ ] Handle imported types with `@JSONSchema`
- [ ] Cache TypeScript program for performance

## Phase 5: Polish

- [ ] Error messages and diagnostics
- [ ] Source map support (if needed)
- [ ] Performance profiling and optimization
- [ ] Documentation and examples
