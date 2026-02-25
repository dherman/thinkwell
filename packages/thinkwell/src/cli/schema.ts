/**
 * Standalone schema generation for the compiled binary.
 *
 * This module provides schema generation functionality for the CLI. It handles:
 *
 * 1. **Type Discovery**: Finding types marked with @JSONSchema JSDoc tag
 * 2. **Schema Generation**: Delegating to the thinkwell/build API
 * 3. **Code Injection**: Generating namespace declarations with SchemaProvider
 *
 * Schema generation is handled by the `thinkwell/build` module, which
 * encapsulates all interaction with `ts-json-schema-generator`. In
 * explicit-config mode, the build API is resolved from the project's
 * `node_modules` so the project-local version is used. In zero-config mode,
 * the bundled version is used directly.
 *
 * Unlike the bun-plugin which operates at bundle time with caching across files,
 * this module operates at runtime on individual user scripts.
 */

import ts from "typescript";
import { join } from "node:path";
import { createRequire } from "node:module";
import { generateSchemas as bundledGenerateSchemas } from "../build.js";

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
  /** Whether the type declaration has an `export` modifier */
  isExported: boolean;
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

          const isExported = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
          ) ?? false;

          results.push({
            name,
            node,
            startPosition: node.getStart(),
            endPosition: node.getEnd(),
            line: line + 1,
            column: character + 1,
            declarationLength,
            isExported,
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
 * Resolve the `generateSchemas` function from the thinkwell/build API.
 *
 * When `projectDir` is provided (explicit-config mode), resolves
 * `thinkwell/build` from the project's `node_modules` and uses its
 * exported `generateSchemas`. This ensures schema generation uses the
 * project-local version of `ts-json-schema-generator` (encapsulated
 * inside `thinkwell/build`), without leaking it into the user's contract.
 *
 * In explicit-config mode, resolution failure is an error — `thinkwell`
 * is a checked dependency, so `thinkwell/build` is guaranteed available.
 * Silently falling back to the bundled version would hide version
 * mismatches.
 *
 * Returns the bundled version only in zero-config mode (no projectDir).
 */
function resolveGenerateSchemas(projectDir?: string): typeof bundledGenerateSchemas {
  if (projectDir) {
    const projectRequire = createRequire(join(projectDir, "package.json"));
    const buildMod = projectRequire("thinkwell/build");
    if (typeof buildMod.generateSchemas === "function") {
      return buildMod.generateSchemas;
    }
    throw new Error(
      `thinkwell/build resolved from ${projectDir} but does not export generateSchemas. ` +
      `This may indicate a version mismatch — try updating the thinkwell dependency.`
    );
  }
  return bundledGenerateSchemas;
}

/**
 * Generate JSON schemas for the given types.
 *
 * Delegates to the `thinkwell/build` API (project-local or bundled) for
 * the actual schema generation. This module only handles type discovery,
 * error formatting, and code injection.
 *
 * @param path - The path to the TypeScript file
 * @param types - The types to generate schemas for
 * @param sourceCode - The source code (for error messages)
 * @param projectDir - Optional project root for resolving project-local build API
 * @returns Map from type name to JSON schema object
 */
export function generateSchemas(
  path: string,
  types: TypeInfo[],
  sourceCode?: string,
  projectDir?: string,
): Map<string, object> {
  const schemas = new Map<string, object>();

  if (types.length === 0) {
    return schemas;
  }

  const buildGenerateSchemas = resolveGenerateSchemas(projectDir);

  for (const typeInfo of types) {
    const { name, line, column } = typeInfo;
    try {
      const result = buildGenerateSchemas(path, [name]);
      const schema = result.get(name);
      if (schema) {
        schemas.set(name, schema);
      }
    } catch (error) {
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
 *
 * If the original type declaration is exported, the namespace is also exported
 * so that cross-file imports (e.g. `import { Greeting } from "./types.js"`)
 * can access `Greeting.Schema`.
 */
function generateNamespace(name: string, schema: object, isExported: boolean): string {
  const schemaJson = JSON.stringify(schema, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "      " + line))
    .join("\n");

  const exportPrefix = isExported ? "export " : "";
  return [
    `${exportPrefix}namespace ${name} {`,
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

  for (const { name, endPosition, isExported } of types) {
    const schema = schemas.get(name);
    if (!schema) {
      continue;
    }

    insertions.push({
      position: endPosition,
      code: "\n" + generateNamespace(name, schema, isExported),
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
 * @param projectDir - Optional project root for resolving project-local ts-json-schema-generator
 * @returns The transformed source code, or the original if no transforms needed
 */
export function transformJsonSchemas(path: string, source: string, projectDir?: string): string {
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
  const schemas = generateSchemas(path, markedTypes, source, projectDir);

  // Generate and apply insertions
  const insertions = generateInsertions(markedTypes, schemas);
  let modifiedSource = applyInsertions(source, insertions);

  // Add the type import at the beginning
  modifiedSource = generateSchemaImport() + "\n" + modifiedSource;

  return modifiedSource;
}
