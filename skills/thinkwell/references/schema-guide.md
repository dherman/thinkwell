# @JSONSchema Guide

The `@JSONSchema` JSDoc annotation is Thinkwell's mechanism for connecting TypeScript types to JSON Schema at runtime. When you annotate a type with `@JSONSchema`, the Thinkwell CLI automatically generates a companion namespace with a `Schema` property that provides the JSON schema.

## Basic Usage

```typescript
/**
 * A friendly greeting.
 * @JSONSchema
 */
export interface Greeting {
  /** The greeting message */
  message: string;
}

// Auto-generated at runtime:
// namespace Greeting {
//   export const Schema: SchemaProvider<Greeting> = { ... };
// }

const result = await agent.think(Greeting.Schema).text("Say hello").run();
// result is typed as Greeting
```

## Supported Type Constructs

### Interfaces

The most common form. Properties become JSON Schema properties:

```typescript
/** @JSONSchema */
export interface UserProfile {
  name: string;
  age: number;
  email?: string;        // Optional → not in "required" array
  tags: string[];         // Array type
  role: "admin" | "user"; // String literal union → enum
}
```

### Type Aliases

Type aliases work identically:

```typescript
/** @JSONSchema */
export type Coordinate = {
  x: number;
  y: number;
};

/** @JSONSchema */
export type Status = "pending" | "active" | "completed";
```

### Enums

TypeScript enums map to JSON Schema enums:

```typescript
/** @JSONSchema */
export enum Priority {
  Low = "low",
  Medium = "medium",
  High = "high",
}
```

### Classes

Class properties become schema properties (methods are ignored):

```typescript
/** @JSONSchema */
export class Config {
  host: string = "localhost";
  port: number = 3000;
}
```

### Non-Exported Types

The `export` keyword is not required. Non-exported types work the same way:

```typescript
/** @JSONSchema */
interface InternalResult {
  success: boolean;
  data: string;
}
```

## JSDoc Annotations

JSDoc comments on the type and its properties are used in the generated schema:

### Type-Level Description

The JSDoc comment on the type itself becomes the schema's `description`:

```typescript
/**
 * Analysis of a document's sentiment and content.
 * @JSONSchema
 */
export interface DocumentAnalysis {
  // ...
}
```

### Property Descriptions

JSDoc comments on properties become property descriptions:

```typescript
/** @JSONSchema */
export interface Summary {
  /** A brief title for the summary */
  title: string;
  /** Key points extracted from the content */
  points: string[];
}
```

### Validation Annotations

Standard `ts-json-schema-generator` annotations map to JSON Schema validation keywords:

| Annotation | JSON Schema Keyword | Applies To |
|-----------|-------------------|-----------|
| `@minimum N` | `minimum` | `number` |
| `@maximum N` | `maximum` | `number` |
| `@exclusiveMinimum N` | `exclusiveMinimum` | `number` |
| `@exclusiveMaximum N` | `exclusiveMaximum` | `number` |
| `@multipleOf N` | `multipleOf` | `number` |
| `@minLength N` | `minLength` | `string` |
| `@maxLength N` | `maxLength` | `string` |
| `@pattern REGEX` | `pattern` | `string` |
| `@format FORMAT` | `format` | `string` |
| `@minItems N` | `minItems` | `array` |
| `@maxItems N` | `maxItems` | `array` |

Example:

```typescript
/** @JSONSchema */
export interface Product {
  /**
   * Product name
   * @minLength 1
   * @maxLength 100
   */
  name: string;

  /**
   * Price in cents
   * @minimum 0
   */
  price: number;

  /**
   * Product tags
   * @minItems 1
   * @maxItems 10
   */
  tags: string[];

  /**
   * Contact email
   * @format email
   */
  contactEmail?: string;
}
```

## Complex Types

### Nested Objects

Types can reference other types. The schema generator inlines `$ref` references to produce self-contained schemas:

```typescript
/** @JSONSchema */
export interface DocumentSection {
  title: string;
  sentimentScore: number;
  summary: string;
}

/** @JSONSchema */
export interface DocumentAnalysis {
  overallTone: "positive" | "negative" | "mixed" | "neutral";
  sections: DocumentSection[];
  recommendation: string;
}
```

### Union Types

```typescript
/** @JSONSchema */
export type Result =
  | { type: "success"; data: string }
  | { type: "error"; message: string };
```

### Tuple Types

```typescript
/** @JSONSchema */
export type Point = [number, number];
```

### Record Types

```typescript
/** @JSONSchema */
export interface Config {
  settings: Record<string, string>;
}
```

## SchemaProvider Interface

Under the hood, `TypeName.Schema` implements the `SchemaProvider<T>` interface:

```typescript
interface SchemaProvider<T> {
  toJsonSchema(): JsonSchema;
}
```

You can use `SchemaProvider` as a type when passing schemas around:

```typescript
import type { SchemaProvider } from "thinkwell";

async function analyze<T>(agent: Agent, schema: SchemaProvider<T>, prompt: string): Promise<T> {
  return agent.think(schema).text(prompt).run();
}
```

## schemaOf() Alternative

When you don't want to use `@JSONSchema` (e.g., for inline schemas or dynamic schemas), use `schemaOf()`:

```typescript
import { schemaOf } from "thinkwell";

const result = await agent
  .think(schemaOf<{ answer: string }>({
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"]
  }))
  .text("What is 2 + 2?")
  .run();
```

## IDE Support

### Option 1: thinkwell types (file-based)

Generate `.thinkwell.d.ts` declaration files that give your editor autocomplete for `TypeName.Schema`:

```bash
thinkwell types          # One-time generation
thinkwell types --watch  # Watch mode during development
```

Then add to your `tsconfig.json`:
```json
{
  "include": ["src/**/*.ts", "src/**/*.thinkwell.d.ts"]
}
```

And `.gitignore`:
```
*.thinkwell.d.ts
```

### Option 2: VSCode Extension (zero-config)

Install the Thinkwell VSCode extension. It injects `TypeName.Schema` declarations automatically via a TypeScript language service plugin — no generated files needed.

## Type Checking

Use `thinkwell check` to type-check your project. It understands `@JSONSchema` and won't report false errors for `TypeName.Schema` references:

```bash
thinkwell check
```

This is equivalent to `tsc --noEmit` but with `@JSONSchema` support.
