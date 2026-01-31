/**
 * TypeScript AST utilities for finding types marked with @JSONSchema.
 */

import ts from "typescript";

const JSONSCHEMA_TAG = "JSONSchema";

/**
 * Check if a node has a JSDoc comment with the specified tag.
 *
 * This is a standalone implementation that doesn't require a TypeChecker,
 * suitable for parsing individual source files.
 */
function hasJsDocTag(node: ts.Node, tagName: string): boolean {
  const jsDocNodes = ts.getJSDocTags(node);
  return jsDocNodes.some((tag) => tag.tagName.text === tagName);
}

/**
 * Information about a type marked with @JSONSchema.
 */
export interface TypeInfo {
  /** The name of the type (interface, type alias, enum, or class) */
  name: string;
  /** The TypeScript AST node */
  node: ts.Node;
  /** The end position of the type declaration in the source */
  endPosition: number;
}

/**
 * Find all types marked with @JSONSchema in the given source.
 *
 * This function parses the source using the TypeScript compiler API
 * and walks the AST to find interface declarations, type aliases,
 * enum declarations, and class declarations that have the @JSONSchema
 * JSDoc tag.
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
        // For class declarations, the name might be undefined (anonymous class)
        const name = node.name?.text;
        if (name) {
          results.push({ name, node, endPosition: node.getEnd() });
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  return results;
}
