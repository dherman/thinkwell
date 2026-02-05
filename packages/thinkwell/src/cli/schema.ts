/**
 * Standalone schema generation for the compiled binary.
 *
 * This module provides schema generation functionality for the CLI. It handles:
 *
 * 1. **Type Discovery**: Finding types marked with @JSONSchema JSDoc tag
 * 2. **Schema Generation**: Using ts-json-schema-generator to create JSON schemas
 * 3. **Code Injection**: Generating namespace declarations with SchemaProvider
 *
 * Unlike the bun-plugin which operates at bundle time with caching across files,
 * this module operates at runtime on individual user scripts.
 */

import ts from "typescript";
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createGenerator, type Config, type SchemaGenerator } from "ts-json-schema-generator";

// =============================================================================
// Type Discovery
// =============================================================================

const JSONSCHEMA_TAG = "JSONSchema";

/**
 * Information about a type marked with @JSONSchema.
 */
export interface TypeInfo {
  /** The name of the type (interface, type alias, enum, or class) */
  name: string;
  /** The TypeScript AST node */
  node: ts.Node;
  /** The start position of the type declaration in the source */
  startPosition: number;
  /** The end position of the type declaration in the source */
  endPosition: number;
  /** 1-based line number of the type declaration */
  line: number;
  /** 1-based column number of the type declaration */
  column: number;
  /** Length of the type declaration keyword + name (for error underlining) */
  declarationLength: number;
}

/**
 * Check if a node has a JSDoc comment with the specified tag.
 */
function hasJsDocTag(node: ts.Node, tagName: string): boolean {
  const jsDocNodes = ts.getJSDocTags(node);
  return jsDocNodes.some((tag) => tag.tagName.text === tagName);
}

/**
 * Find all types marked with @JSONSchema in the given source.
 *
 * @param path - The file path (used for source file creation)
 * @param source - The TypeScript source code
 * @returns Array of TypeInfo for each marked type
 */
export function findMarkedTypes(path: string, source: string): TypeInfo[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true // setParentNodes - needed for JSDoc traversal
  );

  const results: TypeInfo[] = [];

  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      if (hasJsDocTag(node, JSONSCHEMA_TAG)) {
        const name = node.name?.text;
        if (name) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart()
          );

          // Calculate declaration length for error underlining
          let keyword = "interface";
          if (ts.isTypeAliasDeclaration(node)) keyword = "type";
          else if (ts.isEnumDeclaration(node)) keyword = "enum";
          else if (ts.isClassDeclaration(node)) keyword = "class";
          const declarationLength = keyword.length + 1 + name.length;

          results.push({
            name,
            node,
            startPosition: node.getStart(),
            endPosition: node.getEnd(),
            line: line + 1,
            column: character + 1,
            declarationLength,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  return results;
}

// =============================================================================
// Schema Generation
// =============================================================================

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
 * Create a schema generator for a single file.
 */
function createSchemaGenerator(filePath: string): SchemaGenerator {
  const configPath = findTsConfig(dirname(filePath));

  const config: Config = {
    path: filePath,
    ...(configPath && { tsconfig: configPath }),
    skipTypeCheck: true,
    encodeRefs: false,
  };

  return createGenerator(config);
}

/**
 * Generate JSON schemas for the given types.
 *
 * @param path - The path to the TypeScript file
 * @param types - The types to generate schemas for
 * @param sourceCode - The source code (for error messages)
 * @returns Map from type name to JSON schema object
 */
export function generateSchemas(
  path: string,
  types: TypeInfo[],
  sourceCode?: string
): Map<string, object> {
  const schemas = new Map<string, object>();

  if (types.length === 0) {
    return schemas;
  }

  const generator = createSchemaGenerator(path);

  for (const typeInfo of types) {
    const { name, line, column, declarationLength } = typeInfo;
    try {
      const schema = generator.createSchema(name);
      const definitions = (schema.definitions || {}) as Record<string, unknown>;

      // Get the schema for this specific type
      let result: unknown = definitions[name] || schema;

      // Inline all $ref references
      result = inlineRefs(result, definitions);

      // Clean up root-level properties
      if (typeof result === "object" && result !== null) {
        const cleaned = { ...(result as Record<string, unknown>) };
        delete cleaned["$schema"];
        delete cleaned["definitions"];
        schemas.set(name, cleaned as object);
      } else {
        schemas.set(name, result as object);
      }
    } catch (error) {
      // Format error with location information
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to generate schema for type '${name}' at ${path}:${line}:${column}\n` +
        `  ${errorMessage}\n` +
        `  Ensure the type is exported and uses only JSON-compatible features.`
      );
    }
  }

  return schemas;
}

// =============================================================================
// Code Generation
// =============================================================================

/**
 * Mangled namespace name for the thinkwell/acp import.
 */
const ACP_NAMESPACE = "$$__thinkwell__acp__$$";

/**
 * An insertion to be made into the source code.
 */
export interface Insertion {
  /** Position in the source to insert after */
  position: number;
  /** The code to insert */
  code: string;
}

/**
 * Generate a namespace declaration for a single type.
 */
function generateNamespace(name: string, schema: object): string {
  const schemaJson = JSON.stringify(schema, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "      " + line))
    .join("\n");

  return [
    `namespace ${name} {`,
    `  export const Schema: ${ACP_NAMESPACE}.SchemaProvider<${name}> = {`,
    `    toJsonSchema: () => (${schemaJson}) as ${ACP_NAMESPACE}.JsonSchema,`,
    `  };`,
    `}`,
  ].join("\n");
}

/**
 * Generate insertions for namespace declarations.
 *
 * @param types - The types to generate namespaces for
 * @param schemas - Map from type name to JSON schema object
 * @returns Array of insertions sorted by position (descending)
 */
export function generateInsertions(
  types: TypeInfo[],
  schemas: Map<string, object>
): Insertion[] {
  const insertions: Insertion[] = [];

  for (const { name, endPosition } of types) {
    const schema = schemas.get(name);
    if (!schema) {
      continue;
    }

    insertions.push({
      position: endPosition,
      code: "\n" + generateNamespace(name, schema),
    });
  }

  // Sort by position descending for safe end-to-start insertion
  return insertions.sort((a, b) => b.position - a.position);
}

/**
 * Generate the import statement for injected code.
 *
 * For the compiled binary, we use the bundled module registry instead of
 * a real import, since the types are available at runtime via global.__bundled__.
 */
export function generateSchemaImport(): string {
  // In the compiled binary context, we transform this to use global.__bundled__
  // but we still need the type declaration for TypeScript
  return `import type * as ${ACP_NAMESPACE} from "@thinkwell/acp";`;
}

/**
 * Apply insertions to source code.
 *
 * @param source - The original source code
 * @param insertions - Insertions to apply (must be sorted by position descending)
 * @returns The modified source code
 */
export function applyInsertions(source: string, insertions: Insertion[]): string {
  let result = source;
  for (const { position, code } of insertions) {
    result = result.slice(0, position) + code + result.slice(position);
  }
  return result;
}

// =============================================================================
// Main Transform Function
// =============================================================================

/**
 * Check if source code contains @JSONSchema markers.
 *
 * This is a fast string check to avoid full AST parsing for files
 * that don't use the feature.
 *
 * @param source - The script source code
 * @returns true if the source may contain @JSONSchema types
 */
export function hasJsonSchemaMarkers(source: string): boolean {
  return source.includes("@JSONSchema");
}

/**
 * Transform source code by processing @JSONSchema types.
 *
 * This function:
 * 1. Finds types marked with @JSONSchema
 * 2. Generates JSON schemas for each type
 * 3. Injects namespace declarations with SchemaProvider implementations
 * 4. Adds the necessary type import
 *
 * @param path - The file path
 * @param source - The TypeScript source code
 * @returns The transformed source code, or the original if no transforms needed
 */
export function transformJsonSchemas(path: string, source: string): string {
  // Fast path: no @JSONSchema markers
  if (!hasJsonSchemaMarkers(source)) {
    return source;
  }

  // Find marked types
  const markedTypes = findMarkedTypes(path, source);
  if (markedTypes.length === 0) {
    return source;
  }

  // Generate schemas
  const schemas = generateSchemas(path, markedTypes, source);

  // Generate and apply insertions
  const insertions = generateInsertions(markedTypes, schemas);
  let modifiedSource = applyInsertions(source, insertions);

  // Add the type import at the beginning
  modifiedSource = generateSchemaImport() + "\n" + modifiedSource;

  return modifiedSource;
}
