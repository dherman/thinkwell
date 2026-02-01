/**
 * Schema generation using ts-json-schema-generator.
 *
 * Uses fail-fast semantics: any schema generation error immediately throws
 * rather than logging warnings and continuing with partial results.
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createGenerator, type Config } from "ts-json-schema-generator";
import type { TypeInfo } from "./transform.js";
import { programCache, findTsConfig } from "./program-cache.js";
import { SchemaGenerationError } from "./errors.js";

/**
 * Recursively inline $ref references to make schemas self-contained.
 *
 * ts-json-schema-generator produces schemas with $ref references to
 * a definitions section. For our use case (injecting schemas inline),
 * we need self-contained schemas without external references.
 */
function inlineRefs(
  obj: unknown,
  definitions: Record<string, unknown>
): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => inlineRefs(item, definitions));
  }

  const record = obj as Record<string, unknown>;

  // If this object has a $ref, replace it with the referenced definition
  if (typeof record["$ref"] === "string") {
    const ref = record["$ref"];
    const match = ref.match(/^#\/definitions\/(.+)$/);
    if (match && definitions[match[1]]) {
      return inlineRefs(definitions[match[1]], definitions);
    }
  }

  // Otherwise, recursively process all properties
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = inlineRefs(value, definitions);
  }
  return result;
}

/**
 * Generate JSON schemas for the given types using ts-json-schema-generator.
 *
 * This function uses a cached generator when possible, significantly improving
 * performance for projects with multiple files containing @JSONSchema types.
 *
 * @param path - The path to the TypeScript file
 * @param types - The types to generate schemas for
 * @param sourceCode - The source code (for error messages)
 * @param useCache - Whether to use the program cache (default: true)
 * @returns Map from type name to JSON schema object
 */
export function generateSchemas(
  path: string,
  types: TypeInfo[],
  sourceCode?: string,
  useCache: boolean = true
): Map<string, object> {
  const schemas = new Map<string, object>();

  if (types.length === 0) {
    return schemas;
  }

  // Get or create a generator - uses cache for better performance
  const generator = useCache
    ? programCache.getGenerator(path)
    : createUncachedGenerator(path);

  for (const typeInfo of types) {
    const { name, line, column, declarationLength } = typeInfo;
    try {
      const schema = generator.createSchema(name);
      const definitions = (schema.definitions || {}) as Record<string, unknown>;

      // Get the schema for this specific type (may be in definitions or at root)
      let result: unknown = definitions[name] || schema;

      // Inline all $ref references to make the schema self-contained
      result = inlineRefs(result, definitions);

      // Remove the $schema and definitions properties from root if present
      if (typeof result === "object" && result !== null) {
        const cleaned = { ...(result as Record<string, unknown>) };
        delete cleaned["$schema"];
        delete cleaned["definitions"];
        schemas.set(name, cleaned as object);
      } else {
        schemas.set(name, result as object);
      }
    } catch (error) {
      // Fail fast with a clear, actionable error message
      throw new SchemaGenerationError({
        typeName: name,
        filePath: path,
        sourceCode,
        line,
        column,
        length: declarationLength,
        cause: error,
      });
    }
  }

  return schemas;
}

/**
 * Create an uncached generator for a single file.
 * Used when caching is disabled or for testing.
 */
function createUncachedGenerator(path: string) {
  const configPath = findTsConfig(dirname(path));

  const config: Config = {
    path,
    ...(configPath && { tsconfig: configPath }),
    skipTypeCheck: true,
    encodeRefs: false,
  };

  return createGenerator(config);
}

/**
 * Invalidate the program cache for a file's project.
 * Call this when a TypeScript file is modified.
 */
export function invalidateProgramCache(filePath: string): void {
  programCache.invalidateForFile(filePath);
}

/**
 * Clear the entire program cache.
 */
export function clearProgramCache(): void {
  programCache.clear();
}
