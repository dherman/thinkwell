# RFD: Schema Provider Interface

## Summary

This document proposes a `SchemaProvider<T>` interface to decouple patchwork from specific JSON Schema technologies, enabling users to integrate their preferred schema definition approach (Zod, TypeBox, build-time generators, etc.) without coupling the library to any single solution.

## Problem Statement

The patchwork library needs JSON schemas to describe expected output types to the LLM. Currently, users must manually write JSON schemas and pass them via `.outputSchema()`. This creates several challenges:

1. **Duplication**: Users define TypeScript types for compile-time safety, then must separately define equivalent JSON schemas for runtime
2. **No type inference**: The `Output` type parameter on `think<Output>()` is only used for TypeScript return type checking, not for schema generation
3. **Technology lock-in risk**: If we adopt a specific schema library (Zod, TypeBox, etc.), we couple all users to that choice

## Design Goals

1. **Technology agnostic**: Support multiple schema definition approaches without favoring any
2. **Type safety**: Maintain TypeScript type inference between schema and output type
3. **Separation of concerns**: Enable clean separation between hand-written types and generated schemas
4. **Simple default path**: Keep the API simple for users who just want to pass a JSON schema directly

## Proposal

### SchemaProvider Interface

Define a minimal interface that represents "something that can produce a JSON Schema":

```typescript
/**
 * Interface for types that can provide a JSON Schema representation.
 *
 * This enables integration with various schema technologies:
 * - Schema-first libraries (Zod, TypeBox)
 * - Build-time type-to-schema generators (TypeSpec, ts-json-schema-generator)
 * - Hand-written schemas with type associations
 */
export interface SchemaProvider<T> {
  /**
   * Returns the JSON Schema that describes type T.
   */
  toJsonSchema(): JsonSchema;
}
```

### JsonSchema Type

We define our own structural `JsonSchema` type as a minimal subset of the JSON Schema specification. This type is intentionally simple and structurally compatible with standard JSON Schema, allowing schemas from third-party libraries to be used directly.

```typescript
/**
 * Minimal JSON Schema type for MCP tool definitions.
 *
 * This is a structural subset of JSON Schema, designed to be compatible
 * with schemas produced by third-party libraries without requiring them
 * as dependencies.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: JsonValue[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;  // Allow additional standard JSON Schema properties
}
```

**Rationale**: By using a structural type with an index signature, we accept any object that looks like a JSON Schema. This means schemas from Zod's `zodToJsonSchema()`, TypeBox, or any other library will be assignable to our type without adaptation.

### Updated ThinkBuilder API

The `think()` method accepts a `SchemaProvider<T>`:

```typescript
class Patchwork {
  /**
   * Create a new think builder with a typed output schema.
   *
   * @param schema - A SchemaProvider that defines the expected output structure
   */
  think<T>(schema: SchemaProvider<T>): ThinkBuilder<T>;
}
```

The builder no longer needs a separate `.outputSchema()` method since the schema is provided upfront.

## Integration Patterns

### Pattern 1: Schema-First with Zod

Users define schemas with Zod and use an adapter:

```typescript
// zod-adapter.ts (could be a separate package: @dherman/patchwork-zod)
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { SchemaProvider, JsonSchema } from "@dherman/patchwork";

export function zodSchema<T>(schema: z.ZodType<T>): SchemaProvider<T> {
  return {
    toJsonSchema(): JsonSchema {
      return zodToJsonSchema(schema) as JsonSchema;
    }
  };
}
```

```typescript
// usage.ts
import { z } from "zod";
import { zodSchema } from "./zod-adapter.js";

const Summary = z.object({
  title: z.string(),
  points: z.array(z.string()),
});

const result = await patchwork
  .think(zodSchema(Summary))
  .text("Summarize this document:")
  .display(contents)
  .run();

// result is typed as { title: string; points: string[] }
```

### Pattern 2: Schema-First with TypeBox

```typescript
// typebox-adapter.ts
import { Type, type TSchema } from "@sinclair/typebox";
import type { SchemaProvider, JsonSchema } from "@dherman/patchwork";

export function typeboxSchema<T>(schema: TSchema): SchemaProvider<T> {
  return {
    toJsonSchema(): JsonSchema {
      // TypeBox schemas are already JSON Schema compatible
      return schema as unknown as JsonSchema;
    }
  };
}
```

```typescript
// usage.ts
import { Type } from "@sinclair/typebox";
import { typeboxSchema } from "./typebox-adapter.js";

const Summary = Type.Object({
  title: Type.String(),
  points: Type.Array(Type.String()),
});

const result = await patchwork
  .think(typeboxSchema(Summary))
  .text("Summarize:")
  .run();
```

### Pattern 3: Type-First with Build-Time Generation

For users who prefer to define TypeScript types and generate schemas at build time (using tools like ts-json-schema-generator, TypeSpec, or ts-json-schema-transformer):

```typescript
// types.ts (hand-written)
export interface Summary {
  title: string;
  points: string[];
}

export interface AnalysisResult {
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
  keywords: string[];
}
```

```typescript
// types.schemas.ts (generated by build tool)
import type { SchemaProvider } from "@dherman/patchwork";
import type { Summary, AnalysisResult } from "./types.js";

export const SummarySchema: SchemaProvider<Summary> = {
  toJsonSchema: () => ({
    type: "object",
    properties: {
      title: { type: "string" },
      points: { type: "array", items: { type: "string" } }
    },
    required: ["title", "points"]
  })
};

export const AnalysisResultSchema: SchemaProvider<AnalysisResult> = {
  toJsonSchema: () => ({
    type: "object",
    properties: {
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
      confidence: { type: "number" },
      keywords: { type: "array", items: { type: "string" } }
    },
    required: ["sentiment", "confidence", "keywords"]
  })
};
```

```typescript
// usage.ts
import type { Summary } from "./types.js";
import { SummarySchema } from "./types.schemas.js";

const result = await patchwork
  .think(SummarySchema)
  .text("Summarize:")
  .run();

// result is typed as Summary
```

This pattern maintains clean separation between hand-written types and generated code, satisfying the constraint that a single file should not mix hand-written and tool-generated code.

### Pattern 4: Inline Schema (Simple Cases)

For users who want to pass a raw JSON schema without a wrapper, we need a convenient syntax. Two options are under consideration:

**Option A: Overloaded signatures**

```typescript
class Patchwork {
  think<T>(schema: SchemaProvider<T>): ThinkBuilder<T>;
  think<T = unknown>(schema: JsonSchema): ThinkBuilder<T>;
}

// Usage - explicit type parameter required for type safety
const result = await patchwork
  .think<Summary>({ type: "object", properties: { ... } })
  .run();
```

**Option B: Helper function**

```typescript
// Provided by patchwork
function schemaOf<T>(schema: JsonSchema): SchemaProvider<T> {
  return { toJsonSchema: () => schema };
}

// Usage
const result = await patchwork
  .think(schemaOf<Summary>({ type: "object", properties: { ... } }))
  .run();
```

Both options remain under consideration pending implementation experience.

## Migration Path

### From Current API

The current API:
```typescript
await patchwork.think<Summary>()
  .outputSchema({ ... })
  .run();
```

Becomes:
```typescript
await patchwork.think(schemaOf<Summary>({ ... }))
  .run();
```

Or with a schema library:
```typescript
await patchwork.think(zodSchema(SummarySchema))
  .run();
```

### Deprecation Strategy

1. Add new `think(schema)` signature
2. Deprecate `.outputSchema()` method with console warning
3. Remove in next major version

## Rejected Alternatives

### Option C: JsonSchema Implements SchemaProvider

We considered having plain JSON Schema objects automatically satisfy `SchemaProvider` by treating `toJsonSchema` as optional or using a symbol. This was rejected because:

1. It breaks compatibility with third-party JSON Schema library types (they wouldn't have our method)
2. It muddies the distinction between "a schema" and "something that provides a schema"
3. The explicit wrapper functions (`schemaOf`, `zodSchema`, etc.) are clearer

### Coupling to a Specific Library

We considered adopting Zod or TypeBox as a core dependency. This was rejected because:

1. Forces all users to depend on that library even if they prefer alternatives
2. Libraries evolve at different rates; we'd inherit their breaking changes
3. Build-time generation tools don't need a runtime schema library

## Implementation Notes

### Package Structure

The core `@dherman/patchwork` package exports:
- `SchemaProvider<T>` interface (defined in patchwork)
- `JsonSchema` type (re-exported from @dherman/sacp)
- `schemaOf<T>()` helper (if Option B is chosen)

Adapter packages (optional, community-maintained):
- `@dherman/patchwork-zod` - Zod integration
- `@dherman/patchwork-typebox` - TypeBox integration

### Type Inference

The key to type safety is that `SchemaProvider<T>` carries the type parameter. When you pass a `SchemaProvider<Summary>` to `think()`, TypeScript infers that `run()` returns `Promise<Summary>`.

```typescript
// The schema carries the type
const schema: SchemaProvider<Summary> = zodSchema(SummaryZod);

// think() infers T from the schema parameter
const builder = patchwork.think(schema);  // ThinkBuilder<Summary>

// run() returns the inferred type
const result = await builder.run();  // Summary
```

## Open Questions

1. Should we provide built-in adapters for popular libraries, or leave this to the community/userland?
2. Should `SchemaProvider` have additional optional methods (e.g., `validate(value): T` for runtime validation)?
3. How should we handle schema composition (e.g., extending or combining schemas)?

## References

- [Zod](https://zod.dev) - TypeScript-first schema validation
- [TypeBox](https://github.com/sinclairzx81/typebox) - JSON Schema Type Builder
- [TypeSpec](https://typespec.io) - API-first language for defining APIs
- [ts-json-schema-generator](https://www.npmjs.com/package/ts-json-schema-generator)
- [ts-json-schema-transformer](https://www.npmjs.com/package/@nrfcloud/ts-json-schema-transformer)
- [JSON Schema Specification](https://json-schema.org/specification)
