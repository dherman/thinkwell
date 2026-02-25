# RFD: Thinkwell Coding Skill

**Implementation:** [PR #45](https://github.com/dherman/thinkwell/pull/45)

## Summary

Publish an [Agent Skill](https://agentskills.io/) that teaches coding agents how to write TypeScript code using the Thinkwell framework. The skill covers the `@JSONSchema` syntax, the ThinkBuilder fluent API, agent lifecycle, tools, skills, thought streams, and the `thinkwell` CLI. It targets any agent that supports the Agent Skills standard — Claude Code, Cursor, Gemini CLI, OpenCode, Codex, and others.

## Background

Thinkwell's API has a small but specific surface area that coding agents don't know about out of the box. The `@JSONSchema` JSDoc annotation, the `TypeName.Schema` namespace pattern, the `open()` → `think()` → `run()` lifecycle, and the `.tool()` / `.skill()` builder methods are all Thinkwell-specific conventions that agents need guidance to use correctly.

The [Agent Skills standard](https://agentskills.io/) is an open specification for giving AI agents new capabilities through portable, file-based instruction packages. A skill is a directory containing a `SKILL.md` file with YAML frontmatter and a Markdown body, plus optional reference files. The standard is supported by 30+ agent products and uses progressive disclosure: only the skill name and description are loaded at startup, with the full body loaded on demand when the agent activates the skill.

## Goals

1. **Accuracy** — The skill should teach agents to write correct Thinkwell code that matches the current API surface
2. **Cross-agent** — A single skill that works across all major coding agents via the Agent Skills standard
3. **Maintainability** — The skill lives in the Thinkwell monorepo so it stays in sync with API changes
4. **Easy installation** — A single command to install, regardless of which agent the user runs

## Non-Goals

1. **Contributing to Thinkwell** — The skill is for users writing Thinkwell scripts, not for Thinkwell contributors working on the framework internals
2. **Interactive tools** — The skill provides instructions and reference material only; it does not include executable tool handlers
3. **Agent-specific features** — We don't use Claude Code extensions like `context: fork`, `disable-model-invocation`, or `!`command`` syntax, since these are not part of the core Agent Skills standard

## Design

### Skill Structure

```
skills/thinkwell/
├── SKILL.md              # Frontmatter + core patterns (~350 lines)
└── references/
    ├── api-reference.md  # Full API surface
    ├── schema-guide.md   # @JSONSchema deep dive
    └── examples.md       # Complete working examples
```

The `SKILL.md` body covers the essential patterns an agent needs for most tasks: the `@JSONSchema` annotation, agent lifecycle, ThinkBuilder chain, tools, streaming, and CLI usage. The reference files provide detailed material that agents can load on demand when they need specifics (full method signatures, all overloads, schema annotation details, etc.).

### Content Strategy

The skill content is **hand-written but informed by existing documentation**. Sources include:

- `website/api/think-builder.mdx` — ThinkBuilder API docs
- `website/get-started/quickstart.mdx` — Getting started guide
- `examples/src/*.ts` — Working example scripts
- Source code in `packages/thinkwell/src/` — Canonical API surface

The content is optimized for agent consumption: concise, pattern-oriented, with complete code examples that can be adapted directly. We avoid UI-specific markup (Tabs, Cards) that exists in the website docs.

### Distribution

The skill lives at `skills/thinkwell/` in the monorepo root — not inside a dotfile directory like `.claude/skills/` or `.agents/skills/`. This is intentional: dotfile skill directories are scanned as *project-level* skills, which would auto-activate for anyone working on the Thinkwell repo itself (a contributor context, not a user context). The `skills/` directory is a plain distributable artifact.

#### Installation

Users install via [`npx skills`](https://github.com/vercel-labs/skills) (by Vercel Labs), which supports 45+ agents including Claude Code, Cursor, Gemini CLI, OpenCode, and Codex:

```bash
npx skills add dherman/thinkwell --skill thinkwell
```

This single command auto-detects which agents the user has installed and creates the appropriate directory entries (e.g., `~/.claude/skills/thinkwell/`, `.agents/skills/thinkwell/`, etc.). It supports both project-level (default) and global (`-g`) installation, and uses symlinks by default for easy updates.

#### Why a single install workflow

Each agent has its own discovery paths and install mechanisms:

| Agent | Native install? |
|-------|----------------|
| Claude Code | Manual copy/symlink only |
| Cursor | GitHub import UI (buggy) |
| Gemini CLI | `gemini skills install` from URL |
| OpenCode | Manual copy only |
| Codex | `$skill-installer` from URL |

Rather than documenting five different workflows, we recommend `npx skills add` universally. It works with all agents, handles the directory layout differences, and provides a consistent experience.

### Keeping the Skill in Sync

Since the skill lives alongside the code it documents, any PR that changes the Thinkwell API surface is a natural reminder to update the skill. The skill contains hand-written Markdown with code examples — when an API changes, stale examples will be obvious during review.

### Frontmatter

```yaml
---
name: thinkwell
description: >-
  Write TypeScript code using the Thinkwell framework. Covers the @JSONSchema
  syntax, ThinkBuilder fluent API, agent lifecycle, tools, skills, thought
  streams, and the thinkwell CLI.
---
```

The `name` field follows the Agent Skills spec (lowercase, hyphens allowed, 1-64 chars). The `description` is keyword-rich to enable auto-invocation when an agent sees a relevant task.

## Alternatives Considered

### Store the skill in `.agents/skills/` in the repo

This would make the skill auto-discoverable for anyone who clones the Thinkwell repo. But the Thinkwell repo is for *contributors*, not end users writing Thinkwell scripts. Auto-activating a "how to write Thinkwell code" skill for people working on Thinkwell internals is the wrong audience.

### Publish to a separate `dherman/thinkwell-skill` repo

This would provide a cleaner install URL but introduces sync overhead — two repos to keep in sync when the API changes. Starting in-monorepo keeps things simple. We can always split later if the skill grows popular enough to warrant its own repo.

### Generate skill content from source code or docs

Auto-generating from JSDoc or website MDX would reduce manual maintenance. But the content needs to be optimized for agent consumption (concise, pattern-oriented, no UI markup), which is a different goal than human-readable API docs. The maintenance cost of hand-written Markdown is low given the small API surface.

### Provide per-agent install instructions

We could document `gemini skills install`, `$skill-installer`, manual `cp` commands, etc. But `npx skills add` covers all agents with a single command, and adding per-agent alternatives creates maintenance burden in the README without meaningfully improving the user experience.
