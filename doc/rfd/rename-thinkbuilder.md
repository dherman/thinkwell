# RFD: Rename ThinkBuilder to Plan

## Summary

Rename the `ThinkBuilder` class to `Plan`, keeping `ThinkBuilder` as a deprecated alias for backwards compatibility. The name "Plan" better describes what the object represents — a plan for the agent — rather than how it's implemented (a builder API). The `think()` method on `Agent` and `Session` stays as-is — it's central to the Thinkwell brand and still accurately describes what the plan is for: getting the agent to think.

## Background

The `ThinkBuilder` class is the central fluent API for composing prompts:

```typescript
const result = await agent
  .think(Summary.Schema)
  .text("Summarize this document")
  .quote(content)
  .run();
```

The name "ThinkBuilder" describes implementation mechanics (it's a builder). But what the user is constructing is a *plan* — a description of what the agent should do, including the prompt text, tools, skills, and output schema. Naming it `Plan` foregrounds the concept over the pattern.

## Goals

1. **Rename `ThinkBuilder` to `Plan`** as the primary, documented name
2. **Backwards compatibility** — keep `ThinkBuilder` as a deprecated alias
3. **Update all documentation** to use the new name exclusively
4. **Update the skill** to teach agents the new API

## Non-Goals

1. **Rename the file** — `think-builder.ts` stays as-is to keep `git blame` useful and avoid churn in import paths. The file can be renamed in a future cleanup pass after the deprecation period.
2. **Rename internal/private identifiers** — internal class names like `ThinkSession`, private variables, and test helper classes don't need renaming since they aren't part of the public API.
3. **Rename `PlanEntry`** — the existing `PlanEntry` type in `thought-event.ts` is a different concept (streaming execution plan events) and is unrelated to this rename. No changes needed there.

## Design

### Naming conflict with `PlanEntry`

The `ThoughtEvent` union already has a `{ type: "plan"; entries: PlanEntry[] }` variant representing streaming execution-plan events. This is a different concept from the `Plan` class (which is the prompt builder). The two don't conflict in practice:

- `Plan` is a class you construct and chain methods on
- `PlanEntry` is a type describing streaming event data
- They never appear in the same context — `Plan` is used at prompt-construction time, `PlanEntry` at stream-consumption time
- TypeScript's structural type system has no issue with a class and an interface sharing a word in their names

If we find the naming confusing in practice, we could rename `PlanEntry` to `TaskEntry` or `StepEntry` in a future pass, but this is out of scope for this change.

### Core library changes (`packages/thinkwell`)

#### 1. Rename the class (`src/think-builder.ts`)

- Rename `export class ThinkBuilder<Output>` to `export class Plan<Output>`
- Add deprecated alias: `/** @deprecated Use Plan instead */ export const ThinkBuilder = Plan;`
- Also export the type alias: `/** @deprecated Use Plan instead */ export type ThinkBuilder<Output> = Plan<Output>;`
- Update the JSDoc on the class to reference `Plan` instead of `ThinkBuilder`

#### 2. Update return types on `think()` (`src/agent.ts`, `src/session.ts`)

- Change return type of `think()` from `ThinkBuilder<Output>` to `Plan<Output>` on both `Agent` interface and `Session` class
- Update JSDoc to reference `Plan` instead of "think builder"
- The `think()` method name stays — it's the Thinkwell brand verb

#### 3. Update exports (`src/index.ts`)

- Export `Plan` as the primary export
- Keep `ThinkBuilder` as a deprecated re-export
- Update the comment from `// Think builder` to `// Plan`

#### 5. Update tests

- `src/think-builder.test.ts`: Update describe blocks and test names to reference `Plan`. The `TestableThinkBuilder` helper class can stay as-is (it's internal to tests).
- `src/integration.test.ts`: Update any references in comments
- `src/schema.test.ts`: Update describe block name

### Website changes (`website/`)

#### 1. Rename the API page (`api/think-builder.mdx`)

- Rename file to `api/plan.mdx`
- Update frontmatter: `title: "Plan"`
- Replace all references from `ThinkBuilder` to `Plan` throughout
- Mention the deprecated aliases briefly (one sentence)

#### 2. Update navigation (`docs.json`)

- Change `"api/think-builder"` to `"api/plan"` in the navigation tabs
- Add a redirect from `/api/think-builder` to `/api/plan`

#### 3. Update cross-references

- `api/overview.mdx`: Update table entry, description, and link
- `api/agent.mdx`: Update return type references from `ThinkBuilder` to `Plan`
- `api/sessions.mdx`: Same
- `get-started/quickstart.mdx`: Update API reference link text
- `get-started/coding-agents.mdx`: Update ThinkBuilder references

### Skill changes (`skills/thinkwell/`)

#### 1. Update `SKILL.md`

- Rename `ThinkBuilder` → `Plan` throughout
- Update the frontmatter description
- Update section header from "ThinkBuilder Fluent API" to "Plan Fluent API"

#### 2. Update `references/api-reference.md`

- Rename class definition and return types from `ThinkBuilder` to `Plan`

#### 3. Update `references/examples.md`

- Update any `ThinkBuilder` type references to `Plan`

### VSCode extension and TS plugin

No changes needed — neither `packages/vscode-extension` nor `packages/vscode-ts-plugin` reference `ThinkBuilder`.

### ACP package (`packages/acp/`)

- `src/skill-server.ts` and `src/skill.ts`: Update comments that mention `ThinkBuilder` to say `Plan`

### RFD documents (`doc/rfd/`)

No changes. RFDs are historical records of design decisions. Updating them to reflect later renames would undermine their value as point-in-time documents.

## Alternatives Considered

### `Thought`

Leans into the Thinkwell brand — `think()` returns a `Thought`. But this conflates build-time and run-time: the builder methods compose a description of what *will be thought*, while `.run()` and `.stream()` actually execute it. The run-time side already has first-class "thought" constructs: `.stream()` produces a `ThoughtStream` of `ThoughtEvent`s. Naming the build-time object `Thought` would blur this phase distinction.

### `Script`

Fits the "scripting environment for AI agents" tagline. But in Thinkwell, the *entire TypeScript program* is the script — the `Plan` is just one prompt within it. Calling a single prompt a `Script` overstates its scope. The word also carries strong existing connotations (shell scripts, `<script>` tags, scripting languages) that would suggest the object executes code rather than orchestrates an LLM.

### `Prompt`

The most literal description, but too reductive. A `Plan` isn't just prompt text — it bundles tools, skills, an output schema, and a working directory. `Prompt` undersells the object and makes it sound like you're composing a string.

### Keep `ThinkBuilder`

The status quo works, but "Builder" describes the implementation pattern rather than the concept. Users don't think of themselves as "building a builder" — they're describing what they want the agent to do. `Plan` foregrounds the what over the how.

## Migration Guide

For users upgrading, the only visible change is the return type name:

```typescript
// This still works — think() is unchanged
const result = await agent
  .think(Schema)
  .text("prompt")
  .run();

// If you reference the type directly, use Plan instead of ThinkBuilder
function buildPrompt(plan: Plan<MyOutput>) {
  plan.text("...");
}
```

The `ThinkBuilder` type export continues to work as a deprecated alias. TypeScript users will see deprecation warnings via `@deprecated` JSDoc tags. The deprecated alias can be removed in a future major version.