# Smoke Tests

## Implementation Plan

- [x] Add tool-use test case to `packages/thinkwell/src/integration.test.ts`
- [x] Add `test:smoke` script to `packages/thinkwell/package.json`
- [x] Add `smoke` script to root `package.json`
- [x] Create `.github/workflows/smoke.yml` (weekly cron + manual dispatch)
- [x] Update `doc/runbook/release.md` — replace manual greeting step with `pnpm smoke`
- [x] Verify: `pnpm smoke` passes locally with subscription auth
- [x] Root-cause ToolSearch interference with MCP tool schemas; add `ENABLE_TOOL_SEARCH=0` workaround to workflow
- [x] Remove debug logging from `packages/acp/src/mcp-server.ts`
- [ ] One-time setup: create Anthropic API key, set $5/month spending limit, add as GitHub secret
- [x] Update release runbook to use `gh workflow run smoke.yml` instead of local `pnpm smoke`
