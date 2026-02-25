# Plan: Functional (Immutable) Plan API

Reference: [doc/rfd/functional-plan.md](rfd/functional-plan.md)

## Tasks

- [x] Extract `Plan<Output>` interface from the class in `think-builder.ts`
  - All public builder methods (`text`, `textln`, `quote`, `code`, `tool`, `defineTool`, `skill`, `cwd`) return `Plan<Output>` instead of `this`
  - Execution methods `run()` and `stream()`
- [x] Rename class to `PlanImpl<Output>`, make it non-exported
  - All mutable fields (`_promptParts`, `_tools`, `_skills`, `_cwd`) become `readonly`
  - Add private constructor/clone helper that accepts previous state + override bag
  - Each builder method returns a new `PlanImpl` with shallow-copied updated state
  - `_conn`, `_schemaProvider`, `_existingSessionId` are shared (not copied) across instances
- [x] Export `createPlan` factory function from `think-builder.ts`
- [x] Update `ThinkBuilder` alias: value export removed, becomes type-only alias for `Plan<Output>`
- [x] Update `agent.ts`: import `createPlan` + `Plan` interface, use `createPlan()` in `think()`
- [x] Update `session.ts`: same changes as `agent.ts`
- [x] Update `index.ts`: export `Plan` as type (interface), export `createPlan` as value
- [x] Update `TestableThinkBuilder` in `think-builder.test.ts` to use immutable pattern (each builder method returns a new instance)
- [x] Add immutability tests: capture intermediate plan references and assert they're unchanged after further chaining
- [x] Verify integration tests pass unchanged (they use linear chaining)
