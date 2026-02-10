# RFD: Thought Stream API

**Implementation:** [PR #25](https://github.com/dherman/thinkwell/pull/25)

## Summary

Add a `stream()` method to `ThinkBuilder` that returns a `ThoughtStream<Output>` — a lightweight handle providing both the final typed result (as a promise) and an async iterable of intermediate progress events. This exposes ACP's rich session update notifications to Thinkwell users, enabling use cases like streaming reasoning to a terminal, showing tool activity in a UI, or displaying execution plans.

## Motivation

ACP delivers **10 distinct session update notification types** during a prompt turn. Five of these carry intermediate progress:

| ACP Update | What It Carries |
|---|---|
| `agent_thought_chunk` | Streaming internal reasoning / chain-of-thought |
| `agent_message_chunk` | Streaming visible response text |
| `tool_call` | Agent starts using a tool (id, title, kind, status) |
| `tool_call_update` | Tool progress/completion (status changes, content, diffs) |
| `plan` | Agent's execution plan (entries with priority and status) |

Today, all of this data flows through Thinkwell's internals and is **discarded**. The `run()` method's update loop watches only for `return_result` tool calls, silently consuming everything else. Notably, `agent_thought_chunk` and `agent_message_chunk` are even collapsed into the same internal `{ type: "text" }` variant, losing the semantic distinction between reasoning and response.

Users who want to provide feedback during long-running agent operations — streaming thoughts to stderr, showing a spinner with tool names, rendering a plan checklist — have no way to access this information.

## Design

### API Surface

A new `stream()` method on `ThinkBuilder` returns a `ThoughtStream<Output>`:

```typescript
// Today (unchanged):
const result = await agent.think(schema).text("...").run();

// New streaming API:
const stream = agent.think(schema).text("...").stream();
```

`ThoughtStream<Output>` provides two things:

1. **`.result`** — a `Promise<Output>` that resolves when the agent calls `return_result`, identical to what `run()` returns today.
2. **`[Symbol.asyncIterator]`** — an async iterator yielding `ThoughtEvent` values as they arrive from ACP.

```typescript
interface ThoughtStream<Output> extends AsyncIterable<ThoughtEvent> {
  /** Resolves with the final typed result. */
  readonly result: Promise<Output>;
}
```

### Event Types

`ThoughtEvent` is a Thinkwell-level discriminated union — not a raw ACP type. This gives us freedom to evolve the event vocabulary independently of the protocol.

Events do not carry timestamps. ACP content chunks have no standard timestamp field, so any timestamp would be client-side receipt time — Thinkwell-generated rather than agent-generated. This can be revisited if ACP adds timestamps to content chunks.

```typescript
type ThoughtEvent =
  | { type: "thought"; text: string }
  | { type: "message"; text: string }
  | { type: "tool_start"; id: string; title: string; kind?: ToolKind }
  | { type: "tool_update"; id: string; status: string; content?: ToolContent[] }
  | { type: "tool_done"; id: string; status: "completed" | "failed" }
  | { type: "plan"; entries: PlanEntry[] };

/**
 * Parsed from ACP's ToolCallContent discriminated union.
 * Exposed as typed variants so users get structured access to
 * file diffs, terminal output, etc. without raw ACP types.
 */
type ToolContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string; newText: string }
  | { type: "terminal"; terminalId: string };

/** A standard ACP content block (text, image, etc.). */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string };

interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

type ToolKind =
  | "read" | "edit" | "delete" | "move"
  | "search" | "execute" | "think" | "fetch"
  | "switch_mode" | "other";
```

The mapping from ACP session updates to `ThoughtEvent`:

| ACP Update | ThoughtEvent |
|---|---|
| `agent_thought_chunk` (text) | `{ type: "thought", text }` |
| `agent_message_chunk` (text) | `{ type: "message", text }` |
| `tool_call` | `{ type: "tool_start", id, title, kind }` |
| `tool_call_update` (in_progress) | `{ type: "tool_update", id, status, content }` |
| `tool_call_update` (completed/failed) | `{ type: "tool_done", id, status }` |
| `plan` | `{ type: "plan", entries }` |
| `user_message_chunk`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update` | Not emitted (session plumbing, not progress) |

### Usage Examples

**Streaming reasoning to the terminal:**

```typescript
const stream = agent.think(schema).text("Analyze this codebase").stream();

for await (const event of stream) {
  if (event.type === "thought") {
    process.stderr.write(event.text);
  }
}

const result = await stream.result;
```

**Rich progress display:**

```typescript
const stream = agent.think(schema)
  .text("Refactor this module")
  .tool("read_file", "Read a file", readFileSchema, readFile)
  .stream();

for await (const event of stream) {
  switch (event.type) {
    case "thought":
      ui.updateThinking(event.text);
      break;
    case "tool_start":
      ui.showToolActivity(event.title, event.kind);
      break;
    case "tool_done":
      ui.clearToolActivity(event.id);
      break;
    case "plan":
      ui.renderPlan(event.entries);
      break;
  }
}
```

**Fire-and-forget (don't consume events):**

```typescript
const stream = agent.think(schema).text("...").stream();
// Operation runs eagerly — events buffer internally
const result = await stream.result;
```

**Early termination:**

```typescript
const stream = agent.think(schema).text("...").stream();

for await (const event of stream) {
  if (event.type === "thought") {
    process.stderr.write(event.text);
  }
  // Breaking out of the loop calls the iterator's return() method
  if (someCondition) break;
}

// Result is still available even after breaking out of iteration
const result = await stream.result;
```

### Execution Semantics

**Eager start.** Calling `stream()` begins execution immediately, just like `run()`. The agent connection, session creation, MCP server registration, and prompt sending all happen synchronously with the call. You don't need to iterate to kick things off.

**Independent lifecycles.** The async iterator and the result promise are independent — `.result` resolves as soon as `return_result` fires, regardless of whether events have been consumed. This is essential: the drain-first alternative (where `.result` waits for the iterator to complete) would deadlock the most common case (`await stream.result` without iterating), break early termination via `break`, and create surprising timing dependencies when iterating and awaiting concurrently. If the user chose not to iterate, they opted out of events intentionally.

You can:
- Iterate without awaiting `.result` (it resolves in the background)
- Await `.result` without iterating (events buffer internally)
- Do both concurrently
- Break out of iteration and still await `.result`

**Iterator termination.** The async iterator yields events until the prompt turn completes (i.e., the `session/prompt` response arrives with a `stopReason`). After that, the iterator returns `{ done: true }`. If the consumer breaks out of `for await` early, the iterator's `return()` method is called, but the underlying operation continues — the result promise will still resolve.

**Backpressure.** If the consumer doesn't iterate (or iterates slowly), events accumulate in an internal buffer. This is consistent with the existing `_pendingUpdates` queue mechanism. Since ACP transport is stdio-based and the push is synchronous, there is no risk of event loss.

## Relationship to `run()`

Once `stream()` exists, `run()` becomes a convenience wrapper:

```typescript
async run(): Promise<Output> {
  return this.stream().result;
}
```

This makes `stream()` the primitive and `run()` the simple path. The implementation can be refactored this way, or `run()` can remain as a separate code path that avoids allocating the event queue — this is an implementation detail.

## Implementation Strategy

### Internal Changes Required

1. **Preserve update type distinctions.** The `convertNotification` function in `agent.ts` currently collapses `agent_thought_chunk`, `agent_message_chunk`, and `user_message_chunk` into a single `{ type: "text" }` variant. It also drops `tool_call_update` and `plan` entirely. This needs to change.

   The cleanest approach: define `ThoughtEvent` at the `thinkwell` package level and perform the ACP-to-ThoughtEvent mapping directly in the notification handler, bypassing the current `SessionUpdate` intermediate type for streaming purposes.

2. **Split the update loop.** Today `_executeRun` reads updates in a loop, watching only for `return_result`. With streaming, each update must be:
   - Checked for `return_result` → resolve the result promise
   - Mapped to a `ThoughtEvent` → pushed into the async iterator's queue
   - Checked for `stop` → close the iterator

3. **Async iterator implementation.** A simple producer-consumer queue with deferred promises — the same pattern already used by `ThinkSession._pendingUpdates` / `_updateResolvers`, but producing `ThoughtEvent` values and signaling completion.

4. **`ThoughtStream` class.** A small class that holds the result promise, the event queue, and implements `AsyncIterable<ThoughtEvent>`. No complex state machine needed.

### Packages Affected

- **`thinkwell`** — `ThinkBuilder.stream()`, `ThoughtStream`, `ThoughtEvent` types, refactored update loop
- **`@thinkwell/acp`** — Potentially expand `SessionUpdate` to carry richer type information, or leave as-is if the mapping happens entirely in the `thinkwell` package

### What Changes for Existing Users

Nothing. `run()` continues to work exactly as before. `ThoughtStream` and `ThoughtEvent` are new exports. This is purely additive.

## Future Extensions

These are explicitly **not** part of this proposal but are natural follow-ons:

### Cancellation

ACP supports `session/cancel`. `ThoughtStream` could expose an `abort()` method or accept an `AbortSignal`:

```typescript
const controller = new AbortController();
const stream = agent.think(schema).text("...").stream({ signal: controller.signal });

// Later:
controller.abort();
```

### Event Filtering

If users commonly want only a subset of events, a filter option could avoid buffering unwanted events:

```typescript
const stream = agent.think(schema).text("...").stream({
  include: ["thought", "plan"],
});
```

### Web Streams Adapter

For browser or Deno environments, a `ReadableStream<ThoughtEvent>` adapter:

```typescript
const readable = stream.toReadableStream();
```

### Observable / RxJS Interop

Since `ThoughtStream` implements `AsyncIterable`, it already works with RxJS's `from()` and similar reactive libraries. No special adapter needed.

## Alternatives Considered

### Callbacks / Event Emitter

```typescript
agent.think(schema).text("...").run({
  onThought: (text) => { ... },
  onToolStart: (id, title) => { ... },
});
```

Rejected because:
- Callback bags don't compose well
- No backpressure
- Can't be used with `for await`
- Forces users to handle events they don't care about (even if as no-ops)

### Single Merged Stream (No Separate `.result`)

```typescript
for await (const event of agent.think(schema).text("...").stream()) {
  if (event.type === "result") {
    // final result here
  }
}
```

Rejected because:
- Forces iteration even when you only want the result
- Loses the clean `Promise<Output>` type — result type is mixed into the event union
- Makes the simple "just get the answer" case more complex than `run()`

### Returning an Object from `run()`

```typescript
const { result, events } = agent.think(schema).text("...").run();
```

Rejected because:
- Changes the return type of `run()`, which is a breaking change
- The name `run()` strongly implies "execute and return the answer"
- A separate method name (`stream()`) makes the intent explicit

### Node.js Readable Stream

```typescript
const stream = agent.think(schema).text("...").stream();
// stream instanceof Readable
stream.on("data", (event) => { ... });
```

Rejected because:
- Couples to Node.js — not portable to Deno, browsers, or edge runtimes
- Event emitter patterns lose type safety (events are `any`)
- `AsyncIterable` is the standard cross-runtime iteration protocol

## References

- [ACP Specification](https://agentclientprotocol.com)
- [ACP Session Updates](https://agentclientprotocol.com/protocol/prompt-turn) — prompt turn lifecycle
- [ACP Tool Calls](https://agentclientprotocol.com/protocol/tool-calls) — tool_call and tool_call_update
- [ACP Agent Plan](https://agentclientprotocol.com/protocol/agent-plan) — plan notification semantics
- [TC39 Async Iteration](https://tc39.es/ecma262/#sec-asynciterable-interface) — the `AsyncIterable` protocol
- [RFD: Agent-Centric API](agent-api.md) — the current `Agent` / `ThinkBuilder` / `run()` design
