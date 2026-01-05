# Implementation Plan: SchemaProvider Interface

This plan implements the `SchemaProvider<T>` interface from [schema-providers.md](rfd/schema-providers.md).

## Phase 1: Core Types

- [x] Add `SchemaProvider<T>` interface to `packages/sacp/src/types.ts`
- [x] Ensure `JsonSchema` type has index signature for third-party compatibility
- [x] Export `SchemaProvider` from `packages/sacp/src/index.ts`
- [x] Re-export `SchemaProvider` from `packages/patchwork/src/index.ts`

## Phase 2: Helper Function

- [x] Add `schemaOf<T>()` helper function to patchwork (new file `packages/patchwork/src/schema.ts`)
- [x] Export `schemaOf` from patchwork index

## Phase 3: Update ThinkBuilder API

- [x] Add new `think(schema: SchemaProvider<T>)` overload to Patchwork class
- [x] Update ThinkBuilder to accept schema in constructor
- [x] Deprecate `.outputSchema()` method with console warning
- [x] Update internal schema handling to use `toJsonSchema()` when building request

## Phase 4: Tests

- [x] Add unit tests for `schemaOf<T>()` helper
- [x] Add unit tests for `think(schema)` signature
- [x] Add test demonstrating type inference flow
- [x] Verify deprecation warning fires for `.outputSchema()`

## Phase 5: Documentation

- [x] Update patchwork README with new usage patterns
- [x] Add JSDoc comments to `SchemaProvider` and `schemaOf`

## Phase 6: Integration Examples

Create `examples/` directory with end-to-end examples that demonstrate each schema provider pattern and serve as integration tests.

- [ ] Example 1: Inline schema with `schemaOf<T>()` helper
- [ ] Example 2: Zod adapter (`zodSchema()`)
- [ ] Example 3: TypeBox adapter (`typeboxSchema()`)
- [ ] Example 4: Build-time generated schemas (type-first pattern)
