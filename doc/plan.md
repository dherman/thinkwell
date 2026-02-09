# Plan: Remove `thinkwell:*` URI Scheme

See [doc/rfd/remove-uri-scheme.md](rfd/remove-uri-scheme.md) for context.

## New `open()` API

- [ ] Define `AgentName` type and agent name → command mapping table
- [ ] Rename `ConnectOptions` to `AgentOptions`, add `cmd` field
- [ ] Implement `open()` with overloads (named agent + custom command)
- [ ] Implement env var override logic (`$THINKWELL_AGENT`, `$THINKWELL_AGENT_CMD`)
- [ ] Wire through `env` and `timeout` options (currently ignored in `connect()`)
- [ ] Export `open`, `AgentName`, and `AgentOptions` from package root (`index.ts`)
- [ ] Remove `Agent.connect()` static method

## Remove connectors module

- [ ] Delete `packages/thinkwell/src/connectors/index.ts`
- [ ] Remove `./connectors` subpath from `package.json` exports

## Loader cleanup (`cli/loader.ts`)

- [ ] Remove `THINKWELL_MODULES` mapping
- [ ] Remove `rewriteThinkwellImports()` function
- [ ] Remove `thinkwell:*` check from `needsTransformation()`
- [ ] Remove the `rewriteThinkwellImports()` call in `loadScript()`

## Build system cleanup (`cli/build.ts`)

- [ ] Remove `thinkwell:*` esbuild `onResolve` hook
- [ ] Remove `thinkwell:*` cases from runtime `require()` patching

## Init template (`cli/init-command.ts`)

- [ ] Update scaffolded script to use `import { open } from "thinkwell"` and `open('claude')`

## Tests

- [ ] Update `test-ts-support/with-thinkwell-imports.ts` to use standard imports
- [ ] Update `cli/cli.test.ts` — remove URI rewriting tests, update remaining fixtures
- [ ] Update `cli/build.test.ts` — remove `thinkwell:*` references

## Examples

- [ ] Update `examples/src/greeting.ts`
- [ ] Update `examples/src/summarize.ts`
- [ ] Update `examples/src/unminify.ts`
- [ ] Update `examples/src/sentiment.ts`

## Website docs

- [ ] Update `website/get-started/introduction.mdx`
- [ ] Update `website/get-started/quickstart.mdx`
- [ ] Update `website/examples/hello-world.mdx`
- [ ] Update `website/api/agent.mdx` — document `open()` instead of `Agent.connect()`
- [ ] Update or remove `website/api/connectors.mdx`
- [ ] Update any other website pages referencing `thinkwell:*` imports

## Verification

- [ ] Run tests (`pnpm test`)
- [ ] Run build (`pnpm build`)
- [ ] Verify no remaining `thinkwell:` URI references in source (excluding docs/RFDs)
