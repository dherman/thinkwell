/**
 * Scans TypeScript source files for types marked with the @JSONSchema JSDoc tag.
 *
 * Uses a two-pass approach: a fast regex pre-filter to skip files that don't
 * contain the marker, followed by AST traversal for precise detection.
 */

import type ts from "typescript";

const JSONSCHEMA_TAG = "JSONSchema";

/**
 * Information about a type marked with @JSONSchema.
 */
export interface MarkedType {
  /** The type name (interface, type alias, enum, or class) */
  name: string;
  /** Whether the type declaration has an `export` modifier */
  isExported: boolean;
}

/**
 * Fast string check for @JSONSchema markers.
 * Avoids full AST parsing for files that don't use the feature.
 */
export function hasJsonSchemaMarkers(source: string): boolean {
  return source.includes("@JSONSchema");
}

/**
 * Check if a node has a JSDoc comment with the specified tag.
 */
function hasJsDocTag(tsModule: typeof ts, node: ts.Node, tagName: string): boolean {
  const tags = tsModule.getJSDocTags(node);
  return tags.some((tag) => tag.tagName.text === tagName);
}

/**
 * Find all types marked with @JSONSchema in the given source.
 */
export function findMarkedTypes(tsModule: typeof ts, fileName: string, source: string): MarkedType[] {
  const sourceFile = tsModule.createSourceFile(
    fileName,
    source,
    tsModule.ScriptTarget.Latest,
    true, // setParentNodes — needed for JSDoc traversal
  );

  const results: MarkedType[] = [];

  tsModule.forEachChild(sourceFile, function visit(node) {
    if (
      tsModule.isInterfaceDeclaration(node) ||
      tsModule.isTypeAliasDeclaration(node) ||
      tsModule.isEnumDeclaration(node) ||
      tsModule.isClassDeclaration(node)
    ) {
      if (hasJsDocTag(tsModule, node, JSONSCHEMA_TAG)) {
        const name = node.name?.text;
        if (name) {
          const isExported = node.modifiers?.some(
            (m) => m.kind === tsModule.SyntaxKind.ExportKeyword,
          ) ?? false;

          results.push({ name, isExported });
        }
      }
    }
    tsModule.forEachChild(node, visit);
  });

  return results;
}
