# Plan: Remove `thinkwell:*` URI Scheme

See [doc/rfd/remove-uri-scheme.md](rfd/remove-uri-scheme.md) for context.

## New `open()` API

- [x] Define `AgentName` type and agent name → command mapping table
- [x] Rename `ConnectOptions` to `AgentOptions`, add `cmd` field
- [x] Implement `open()` with overloads (named agent + custom command)
- [x] Implement env var override logic (`$THINKWELL_AGENT`, `$THINKWELL_AGENT_CMD`)
- [x] Wire through `env` and `timeout` options (currently ignored in `connect()`)
- [x] Export `open`, `AgentName`, and `AgentOptions` from package root (`index.ts`)
- [x] Remove `Agent.connect()` static method (kept as `@internal` until callers are migrated)

## Remove connectors module

- [x] Delete `packages/thinkwell/src/connectors/index.ts`
- [x] Remove `./connectors` subpath from `package.json` exports

## Loader cleanup (`cli/loader.ts`)

- [x] Remove `THINKWELL_MODULES` mapping
- [x] Remove `rewriteThinkwellImports()` function
- [x] Remove `thinkwell:*` check from `needsTransformation()`
- [x] Remove the `rewriteThinkwellImports()` call in `loadScript()`

## Build system cleanup (`cli/build.ts`)

- [x] Remove `thinkwell:*` esbuild `onResolve` hook
- [x] Remove `thinkwell:*` cases from runtime `require()` patching

## Init template (`cli/init-command.ts`)

- [x] Update scaffolded script to use `import { open } from "thinkwell"` and `open('claude')`

## Tests

- [x] Update `test-ts-support/with-thinkwell-imports.ts` to use standard imports
- [x] Update `cli/cli.test.ts` — remove URI rewriting tests, update remaining fixtures
- [x] Update `cli/build.test.ts` — remove `thinkwell:*` references

## Examples

- [x] Update `examples/src/greeting.ts`
- [x] Update `examples/src/summarize.ts`
- [x] Update `examples/src/unminify.ts`
- [x] Update `examples/src/sentiment.ts`

## Website docs

- [x] Update `website/get-started/introduction.mdx`
- [x] Update `website/get-started/quickstart.mdx`
- [x] Update `website/examples/hello-world.mdx`
- [x] Update `website/api/agent.mdx` — document `open()` instead of `Agent.connect()`
- [x] Update or remove `website/api/connectors.mdx`
- [x] Update any other website pages referencing `thinkwell:*` imports

## Verification

- [x] Run tests (`pnpm test`)
- [x] Run build (`pnpm build`)
- [x] Verify no remaining `thinkwell:` URI references in source (excluding docs/RFDs)
