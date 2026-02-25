/**
 * Public build API for thinkwell.
 *
 * This module exposes schema generation functionality for use by the CLI
 * when running in explicit-config mode. By resolving `thinkwell/build` from
 * a project's `node_modules`, the CLI uses the project-local version of
 * `ts-json-schema-generator` (a transitive dependency of `thinkwell`)
 * without leaking it into the user's dependency contract.
 *
 * The API is intentionally narrow: a single `generateSchemas()` function that
 * takes a file path and type names and returns self-contained JSON schema
 * objects. All details of `ts-json-schema-generator` are encapsulated here.
 *
 * @module thinkwell/build
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createGenerator } from "ts-json-schema-generator";

/**
 * Find tsconfig.json by walking up from the given directory.
 */
function findTsConfig(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    const configPath = join(dir, "tsconfig.json");
    if (existsSync(configPath)) {
      return configPath;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Recursively inline $ref references to make schemas self-contained.
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
 * Clean a raw schema by inlining `$ref` references and removing root-level
 * `$schema` and `definitions` properties.
 */
function cleanSchema(typeName: string, schema: object): object {
  const definitions = ((schema as Record<string, unknown>).definitions || {}) as Record<string, unknown>;

  // Get the schema for this specific type
  let result: unknown = definitions[typeName] || schema;

  // Inline all $ref references
  result = inlineRefs(result, definitions);

  // Clean up root-level properties
  if (typeof result === "object" && result !== null) {
    const cleaned = { ...(result as Record<string, unknown>) };
    delete cleaned["$schema"];
    delete cleaned["definitions"];
    return cleaned as object;
  }

  return result as object;
}

/**
 * Generate self-contained JSON schemas for named types in a TypeScript file.
 *
 * Creates a single schema generator for the file and produces a clean,
 * self-contained schema for each requested type (no `$ref`, `$schema`,
 * or `definitions` in the output).
 *
 * @param filePath - Absolute path to the TypeScript file containing the types
 * @param typeNames - The names of the types to generate schemas for
 * @returns Map from type name to self-contained JSON schema object
 */
export function generateSchemas(filePath: string, typeNames: string[]): Map<string, object> {
  const schemas = new Map<string, object>();

  if (typeNames.length === 0) {
    return schemas;
  }

  const configPath = findTsConfig(dirname(filePath));

  const generator = createGenerator({
    path: filePath,
    ...(configPath && { tsconfig: configPath }),
    skipTypeCheck: true,
    encodeRefs: false,
  });

  for (const typeName of typeNames) {
    const schema = generator.createSchema(typeName);
    schemas.set(typeName, cleanSchema(typeName, schema));
  }

  return schemas;
}
