# RFD: Smoke Tests

## Summary

Add a small suite of end-to-end smoke tests that run thinkwell scripts against a live Claude backend, validating that the core `open()` → `think()` → structured output pipeline works. The tests use structural assertions (schema validity, non-empty fields, correct discriminant types) rather than semantic content checks, making them effectively deterministic despite the nondeterministic LLM backend. The suite runs on a weekly schedule in GitHub Actions and can be triggered manually as part of the release process.

## Background

Today the only smoke test is a single manual step in the release runbook: run the greeting example and eyeball the output. This has several problems:

1. **Regressions hide until release time.** A breaking change to the agent protocol, structured output handling, or tool dispatch could land on `main` and go undetected for weeks.
2. **The manual test is subjective.** "It should show a status spinner followed by a greeting with no errors" is not a reliable assertion.
3. **No CI coverage of the live agent path.** The existing `integration.test.ts` tests are skipped in CI (`SKIP_INTEGRATION_TESTS=1`) because they require API credentials.

### Requirements

1. **Automated weekly runs** to catch regressions between releases
2. **Manual trigger** for pre-release verification
3. **Secure credential management** for the Anthropic API key
4. **Cost control** — the test suite must not risk significant API charges
5. **Low flakiness** — tests must be reliable enough to trust in CI without human review

## Proposal

### Authentication

Thinkwell's `open('claude')` spawns `@agentclientprotocol/claude-agent-acp`, which uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The Agent SDK supports two authentication methods:

1. **`ANTHROPIC_API_KEY`** — Pay-per-use API billing. Recommended for CI/CD by Anthropic's docs.
2. **Subscription auth** — Uses credentials from `claude auth login` stored in `~/.claude/`. Works with Pro/Max plans.

#### Workaround: ToolSearch interference with MCP tool schemas

As of April 2026, Claude Code's ToolSearch feature (dynamically discovers and provides additional tools to the model) interferes with MCP tool schema handling when using API key auth. With ToolSearch enabled, the model ignores MCP tool `inputSchema` definitions and wraps results in a generic `{"result": "..."}` envelope instead of matching the declared schema.

**Root cause:** The Claude Code CLI enables ToolSearch by default for first-party Anthropic API endpoints. ToolSearch changes how tools are presented to the model, which causes the model to ignore MCP tool input schemas. Subscription auth is unaffected because it uses a different server-side pipeline.

**Workaround:** Set `ENABLE_TOOL_SEARCH=0` in the environment when running with API key auth. This disables the ToolSearch feature and allows MCP tool schemas to work correctly. The CI workflow includes this env var.

**Discovery:** This was identified by building an HTTP proxy to intercept API requests, which revealed that setting `ANTHROPIC_BASE_URL` to a non-Anthropic host inadvertently disabled ToolSearch (the CLI skips ToolSearch for non-first-party hosts). The upstream issues below may be related:

- [claude-agent-sdk-python#502](https://github.com/anthropics/claude-agent-sdk-python/issues/502) — Agent wraps structured output in `{"output": {...}}` / `{"result": {...}}` envelopes
- [claude-agent-sdk-typescript#277](https://github.com/anthropics/claude-agent-sdk-typescript/issues/277) — `structured_output` undefined despite correct JSON in result text

### Cost Control (once CI is enabled)

Smoke tests use small prompts and return small structured JSON responses. Estimated cost per test at Sonnet API rates ($3/MTok input, $15/MTok output):

| Test | Input (~tokens) | Output (~tokens) | Cost |
|------|----------------|-------------------|------|
| Greeting (tool use) | 200 | 50 | ~$0.001 |
| Classification (3 turns) | 600 | 150 | ~$0.004 |
| Simple structured output | 300 | 100 | ~$0.003 |
| **Suite total** | | | **~$0.01** |

At weekly frequency: ~$0.04/month. Even daily: ~$0.30/month. This is negligible.

Safety measures:
- **API key spending limit**: Set a $5/month cap in the Anthropic console. This is a hard ceiling — requests are blocked once the limit is reached.
- **Workflow timeout**: 10-minute timeout on the entire workflow to catch hangs.
- **Per-test timeout**: 90-second timeout per test case.
- **Model selection**: Set `ANTHROPIC_MODEL=claude-sonnet-4-20250514` (or current Sonnet) to avoid accidentally using Opus pricing.

### Assertion Strategy

Thinkwell's `think()` API returns structured JSON validated against a user-defined schema. This is the key insight that makes these tests non-flaky: the schema validation itself is the strongest possible assertion. The LLM either returns valid JSON matching the schema, or the call fails. There is no gray area.

The tests assert:
1. **Exit code 0** — the script runs to completion
2. **Schema validity** — the result parses against the declared schema (this is handled by thinkwell itself)
3. **Structural properties** — non-empty strings, arrays with entries, numbers in valid ranges, correct discriminant values

What the tests do NOT assert:
- Specific text content (e.g., "the greeting should mention the time of day")
- Semantic correctness (e.g., "the classification is accurate")
- Output length or formatting

This makes the tests effectively deterministic. The only realistic failure mode is the LLM failing to produce valid structured output at all, which would indicate a real regression in thinkwell's structured output pipeline, the agent protocol, or the backend.

### Test Cases

The tests reuse and extend the existing `integration.test.ts` pattern. Three test cases cover the core functionality:

1. **Simple structured output** (already exists in `integration.test.ts`): Call `think()` with a greeting schema, assert the result has a non-empty `greeting` string.

2. **Tool use**: Call `think()` with a schema and a custom tool, assert the result is structurally valid and that the tool was invoked. This covers the tool dispatch path through the agent protocol.

3. **Discriminated union** (already exists in `integration.test.ts`): Call `think()` with a union schema (`respond | escalate`), assert the discriminant is one of the expected values and the variant-specific fields are present.

These three cases cover the critical paths: basic structured output, tool dispatch, and union type handling.

### Implementation

#### Test file

The existing `packages/thinkwell/src/integration.test.ts` already contains the greeting and union tests. Add a tool-use test case to cover that path. No new test files needed.

Create a convenience script in the root `package.json`:

```json
{
  "scripts": {
    "smoke": "pnpm --filter thinkwell test:smoke"
  }
}
```

And in `packages/thinkwell/package.json`:

```json
{
  "scripts": {
    "test:smoke": "node --test --import tsx src/integration.test.ts"
  }
}
```

#### GitHub Actions workflow

New file `.github/workflows/smoke.yml`:

```yaml
name: Smoke Tests

on:
  schedule:
    - cron: '0 6 * * 0'  # Sunday 6am UTC
  workflow_dispatch:       # Manual trigger

jobs:
  smoke:
    name: Smoke Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js 24
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Run smoke tests
        run: pnpm smoke
        timeout-minutes: 5
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ANTHROPIC_MODEL: claude-sonnet-4-6
          ENABLE_TOOL_SEARCH: '0'
```

A single runner (ubuntu-latest) is sufficient — the smoke tests validate the library logic and agent protocol, not platform-specific binary behavior. Platform-specific testing is already covered by the existing CI matrix.

#### Release runbook update

Replace the manual greeting step in `doc/runbook/release.md` with `pnpm smoke`, which runs the integration tests using the developer's local subscription auth.

Once the upstream structured output bug is fixed, the runbook can switch to triggering the GitHub Actions workflow instead:

```bash
gh workflow run smoke.yml --ref main
gh run watch --exit-status
```

### Setup Steps

**Today (local smoke tests):**

No setup needed — `pnpm smoke` uses the developer's existing Claude Code subscription auth.

**Future (CI automation, once upstream blocker is resolved):**

1. **Create an API key** at [console.anthropic.com](https://console.anthropic.com/) (or reuse an existing one)
2. **Set a spending limit** of $5/month on the key in the Anthropic console
3. **Add the key as a GitHub Actions secret** named `ANTHROPIC_API_KEY` in the repo settings

## Trade-offs

**Advantages:**
- Catches regressions in the live agent path that unit tests cannot (protocol changes, SDK updates, backend model changes)
- Near-zero flakiness due to structural-only assertions on schema-validated output
- Negligible cost once CI is enabled (~$0.01/run)
- Reuses existing test infrastructure — no new test framework or harness
- Replaces a subjective manual step with a reproducible automated one

**Disadvantages:**
- Requires `ENABLE_TOOL_SEARCH=0` workaround for API key auth (Claude Code's ToolSearch interferes with MCP tool schemas)
- Tests can fail due to external factors (Anthropic API outages, rate limits) that are not thinkwell bugs
- Does not validate the examples themselves (greeting.ts, classify.ts, etc.) — only the underlying library paths they exercise

## Scope

**In scope:**
- Tool-use test case added to `integration.test.ts`
- `pnpm smoke` convenience script
- `.github/workflows/smoke.yml` workflow
- Release runbook update
- One-time API key and secret setup (documented, not automated)

**Not in scope:**
- Testing the compiled binary (`pkg` output) against the live backend
- Testing all example scripts end-to-end
- Semantic evaluation of LLM output quality
- Cost dashboards or alerting on API spend
