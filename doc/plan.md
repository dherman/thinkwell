# Plan: VSCode Extension with TypeScript Plugin for `@JSONSchema`

RFD: [vscode-ts-plugin](rfd/vscode-ts-plugin.md)

## Phase 1: TypeScript Plugin Core

- [ ] Scaffold `packages/vscode-ts-plugin` with `package.json`, `tsconfig.json`
- [ ] Implement plugin entry point (`create` function from `ts.server.PluginModule`)
- [ ] Scan project source files for `@JSONSchema`-marked interfaces (regex pre-filter + AST confirmation)
- [ ] Generate virtual `__thinkwell_augmentations__.d.ts` content from discovered types
- [ ] Register virtual file via `getExternalFiles()` and serve its content by monkey-patching `getScriptSnapshot()`
- [ ] Invalidate and regenerate virtual declarations on file changes
- [ ] Add diagnostic filter for residual "Property does not exist" errors (code 2339) on known augmented types

## Phase 2: Standalone Script Module Resolution

- [ ] Monkey-patch `resolveModuleNameLiterals` on the `LanguageServiceHost`
- [ ] Detect standalone scripts (shebang or missing `node_modules` resolution for `thinkwell`)
- [ ] Locate the `thinkwell` CLI binary and resolve its bundled `.d.ts` files
- [ ] Resolve `thinkwell`, `@thinkwell/acp`, and `@thinkwell/protocol` imports to bundled declarations

## Phase 3: VSCode Extension Wrapper

- [ ] Scaffold `packages/vscode-extension` with `package.json` and extension manifest (`contributes.typescriptServerPlugins`)
- [ ] Implement activation logic: detect `thinkwell` in `package.json` deps or `#!/usr/bin/env thinkwell` shebangs
- [ ] Auto-inject TS plugin via `typescript.tsserver.pluginPaths`
- [ ] Add status bar indicator when the plugin is active

## Phase 4: Testing and Packaging

- [ ] Write integration tests: completions, diagnostics, hover for `.Schema` on `@JSONSchema` types
- [ ] Test standalone script module resolution (no `node_modules`)
- [ ] Test incremental updates (add/remove `@JSONSchema` marker, see diagnostics update)
- [ ] Package the extension as `.vsix` for local install and marketplace publishing
