# Plan: Rename ThinkBuilder to Plan

See [RFD](rfd/rename-thinkbuilder.md) for full design rationale.

## Core library (`packages/thinkwell`)

- [x] Rename class `ThinkBuilder` → `Plan` with deprecated alias (`src/think-builder.ts`)
- [x] Update `think()` return types on `Agent` interface (`src/agent.ts`)
- [x] Update `think()` return types on `Session` class (`src/session.ts`)
- [x] Update exports in `src/index.ts`
- [x] Update tests (`think-builder.test.ts`, `integration.test.ts`, `schema.test.ts`)

## Website (`website/`)

- [ ] Rename `api/think-builder.mdx` → `api/plan.mdx` and update content
- [ ] Update `docs.json` navigation and add redirect
- [ ] Update cross-references in `api/overview.mdx`
- [ ] Update cross-references in `api/agent.mdx`
- [ ] Update cross-references in `api/sessions.mdx`
- [ ] Update cross-references in `get-started/quickstart.mdx`
- [ ] Update cross-references in `get-started/coding-agents.mdx`

## Skill (`skills/thinkwell/`)

- [ ] Update `SKILL.md`
- [ ] Update `references/api-reference.md`
- [ ] Update `references/examples.md`

## ACP comments (`packages/acp/`)

- [ ] Update comments in `src/skill-server.ts` and `src/skill.ts`
