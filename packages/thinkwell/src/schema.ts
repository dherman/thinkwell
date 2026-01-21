import type { JsonSchema, SchemaProvider } from "@thinkwell/acp";

/**
 * Creates a SchemaProvider from a raw JSON Schema object.
 *
 * This is a convenience function for users who want to pass a JSON schema
 * directly without using a schema library like Zod or TypeBox.
 *
 * @typeParam T - The TypeScript type that this schema describes
 * @param schema - A JSON Schema object describing the expected output structure
 * @returns A SchemaProvider that wraps the given schema
 *
 * @example
 * ```typescript
 * interface Summary {
 *   title: string;
 *   points: string[];
 * }
 *
 * const result = await patchwork
 *   .think(schemaOf<Summary>({
 *     type: "object",
 *     properties: {
 *       title: { type: "string" },
 *       points: { type: "array", items: { type: "string" } }
 *     },
 *     required: ["title", "points"]
 *   }))
 *   .text("Summarize this document")
 *   .run();
 *
 * // result is typed as Summary
 * ```
 */
export function schemaOf<T>(schema: JsonSchema): SchemaProvider<T> {
  return {
    toJsonSchema: () => schema,
  };
}
