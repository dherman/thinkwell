# Thought Stream API

Implementation plan for the [Thought Stream RFD](rfd/thought-stream.md).

## Types and Core Infrastructure

- [x] Define `ThoughtEvent` discriminated union, `ToolContent`, `ContentBlock`, `PlanEntry`, `ToolKind` types in `packages/thinkwell/src/thought-event.ts`
- [x] Implement `ThoughtStream<Output>` class with `.result` promise and `AsyncIterable<ThoughtEvent>` (producer-consumer queue pattern)
- [x] Export new types from `packages/thinkwell/src/index.ts`

## Notification Mapping

- [x] Expand `convertNotification` in `packages/thinkwell/src/agent.ts` to preserve `agent_thought_chunk` vs `agent_message_chunk` distinction (currently both map to `"text"`)
- [x] Add mapping for `tool_call_update` (currently dropped)
- [x] Add mapping for `plan` (currently dropped)
- [x] Parse `ToolCallContent` into typed `ToolContent` variants (content, diff, terminal)

## Stream Method

- [x] Add `ThinkBuilder.stream()` method that returns `ThoughtStream<Output>`
- [x] Refactor `_executeRun` update loop to fork events: check for `return_result` (resolve result promise) and map to `ThoughtEvent` (push to iterator queue)
- [x] Refactor `run()` to delegate to `stream().result`

## Tests

- [ ] Unit tests for `ThoughtStream` async iteration and `.result` independence
- [ ] Unit tests for `ThoughtEvent` mapping from ACP notification types
- [ ] Integration test: `stream()` with agent, verify events arrive and `.result` resolves
- [ ] Integration test: `run()` still works after refactor (backward compat)
- [ ] Test early termination (`break` from `for await`) doesn't break `.result`
- [ ] Test fire-and-forget (`await stream.result` without iterating)
