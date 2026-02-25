# RFD: Functional (Immutable) Plan API

## Summary

Change `Plan` from a mutable class to an interface backed by an immutable implementation. Every builder method (`text`, `textln`, `quote`, `code`, `tool`, `defineTool`, `skill`, `cwd`) returns a **new** `Plan` object with the updated state, rather than mutating `this`. The fluent chaining API looks identical to callers — only code that depends on mutation through aliased references would break.

## Background

The `Plan` class currently uses a mutable builder pattern: each method mutates internal state and returns `this`. This works for the common chained-call pattern:

```typescript
const result = await agent
  .think(Schema)
  .text("Summarize this")
  .quote(content)
  .run();
```

But mutation makes certain patterns awkward or error-prone:

- **Sharing a base plan** — you can't create a partially-configured plan and derive variants from it without cloning:
  ```typescript
  // BROKEN with mutable Plan — both calls mutate the same object
  const base = agent.think(Schema).text("Analyze this document").quote(doc);
  const brief = base.text("Be brief.");
  const detailed = base.text("Be thorough and detailed.");
  ```

- **Predictability** — immutable objects are easier to reason about. Once you have a reference to a `Plan`, its configuration won't change out from under you.

- **Composability** — helper functions that accept a `Plan` and return an enhanced version are cleaner when they don't modify their input.

## Goals

1. **Immutable builder** — every builder method returns a new `Plan` with the updated state
2. **Interface-based** — `Plan<Output>` becomes an interface; the concrete implementation is internal
3. **Preserve the fluent API** — chained calls look identical; no changes required for the common case
4. **Preserve execution semantics** — `run()` and `stream()` behave identically

## Non-Goals

1. **Persistent data structures** — the internal collections (`_promptParts`, `_tools`, `_skills`) are small; shallow copies are sufficient. We don't need structural sharing or libraries like Immer.
2. **Deep freezing** — we won't `Object.freeze()` internal state. The immutability guarantee comes from the API contract (returning new objects), not runtime enforcement.
3. **Rename the file** — `think-builder.ts` stays as-is, consistent with the decision made in the ThinkBuilder→Plan rename RFD.

## Design

### Interface extraction

Define `Plan<Output>` as an interface with all public builder and execution methods:

```typescript
export interface Plan<Output> {
  text(content: string): Plan<Output>;
  textln(content: string): Plan<Output>;
  quote(content: string, tag?: string): Plan<Output>;
  code(content: string, language?: string): Plan<Output>;
  tool(name: string, description: string, handler: ToolHandler): Plan<Output>;
  // ... additional tool() overloads
  defineTool(name: string, description: string, handler: ToolHandler): Plan<Output>;
  // ... additional defineTool() overloads
  skill(pathOrDef: string | VirtualSkillDefinition): Plan<Output>;
  cwd(path: string): Plan<Output>;
  run(): Promise<Output>;
  stream(): ThoughtStream<Output>;
}
```

### Internal implementation

A private `PlanImpl<Output>` class implements the interface. All mutable fields become `readonly`, and each builder method constructs a new `PlanImpl` with updated state:

```typescript
class PlanImpl<Output> implements Plan<Output> {
  private readonly _conn: AgentConnection;
  private readonly _promptParts: readonly string[];
  private readonly _tools: ReadonlyMap<string, ToolDefinition>;
  private readonly _skills: readonly DeferredSkill[];
  private readonly _schemaProvider: SchemaProvider<Output> | undefined;
  private readonly _cwd: string | undefined;
  private readonly _existingSessionId: string | undefined;

  text(content: string): Plan<Output> {
    return new PlanImpl(this, {
      promptParts: [...this._promptParts, content],
    });
  }

  // ... etc.
}
```

The constructor (or a private `_clone`-style helper) accepts the previous state plus an override bag, keeping the copy logic centralized.

### Factory functions

`Agent.think()` and `Session.think()` currently call `new Plan(...)`. These change to return `Plan<Output>` (the interface) while internally constructing a `PlanImpl`:

```typescript
// In agent.ts
think<Output>(schema: SchemaProvider<Output>): Plan<Output> {
  return createPlan<Output>(this._conn, schema);
}
```

The `createPlan` factory lives in `think-builder.ts` alongside `PlanImpl` and is the only public way to create an initial `Plan`.

### Backward compatibility

- The `ThinkBuilder` deprecated alias changes from a class alias to a type alias for the `Plan` interface. Anyone using `ThinkBuilder<Output>` as a type annotation is unaffected.
- `instanceof Plan` checks would break, but `Plan` was never designed for runtime type checks and no such usage exists in the codebase.
- Direct `new Plan(...)` calls break, but `Plan` is only instantiated internally in `agent.ts` and `session.ts` — never by external consumers.

## Scope of Changes

### `packages/thinkwell/src/think-builder.ts`
- Extract `Plan<Output>` interface from the class
- Rename the class to `PlanImpl<Output>`, make it non-exported
- Convert every builder method to return a new `PlanImpl` via shallow copy
- Make all internal state `readonly`
- Export a `createPlan` factory function
- Update the `ThinkBuilder` deprecated alias to reference the interface

### `packages/thinkwell/src/agent.ts`
- Import `createPlan` instead of `Plan` class (for construction)
- Import `Plan` interface (for return type)
- Change `think()` to call `createPlan()`

### `packages/thinkwell/src/session.ts`
- Same changes as `agent.ts`

### `packages/thinkwell/src/index.ts`
- Export `Plan` as a type (interface) instead of a class
- Export `createPlan` if we want it public, or keep it internal

### `packages/thinkwell/src/think-builder.test.ts`
- Update `TestableThinkBuilder` helper to work with the new immutable API
- Tests that inspect state after chained calls need to capture the returned value rather than checking the original reference
- Add new tests validating immutability (original plan unchanged after builder call)

### `packages/thinkwell/src/integration.test.ts`
- Likely no changes — tests use the fluent chaining pattern which is unchanged

### Examples, skills, website docs
- No changes needed — the chained API is identical

## Alternatives Considered

### Mutation + explicit `clone()` method

Keep the mutable builder and add a `clone()` method for creating variants. This is simpler to implement but puts the burden on users to remember to clone, and the failure mode (silent shared mutation) is subtle. The functional approach makes the safe behavior the default.

### Immer-style produce

Use a library like Immer for structural sharing. Overkill for the small collections involved — `Plan` objects hold a handful of strings, a small map of tools, and a short array of skills. Shallow copies are effectively free.

### Keep it mutable

The current API works. But we're at an early stage where changing it is cheap, and the immutable version is strictly more capable (you can always ignore the return value and pretend it's mutable, but you can't get immutability from a mutable API).
