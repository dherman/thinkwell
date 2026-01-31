/**
 * Bun plugin for automatic JSON Schema generation from TypeScript types
 * marked with @JSONSchema.
 *
 * This plugin intercepts TypeScript file loads and injects namespace
 * declarations containing SchemaProvider implementations for each
 * marked type.
 *
 * @example
 * ```typescript
 * // In bunfig.toml:
 * // preload = ["@thinkwell/bun-plugin"]
 *
 * // Or via CLI:
 * // bun --preload @thinkwell/bun-plugin script.ts
 *
 * // In your script:
 * /** @JSONSchema *\/
 * interface Greeting {
 *   message: string;
 * }
 *
 * // Greeting.Schema is automatically available!
 * console.log(Greeting.Schema.toJsonSchema());
 * ```
 *
 * @packageDocumentation
 */

import { plugin, type BunPlugin } from "bun";
import { findMarkedTypes, type TypeInfo } from "./transform.js";
import { generateSchemas } from "./schema-generator.js";
import {
  generateInsertions,
  generateImport,
  applyInsertions,
} from "./codegen.js";
import { SchemaCache } from "./schema-cache.js";
import { THINKWELL_MODULES } from "./modules.js";

const JSONSCHEMA_TAG = "@JSONSchema";

/**
 * Rewrite thinkwell:* imports to their actual npm package names.
 *
 * This is necessary because Bun's runtime plugins have a bug where
 * URL-like imports (containing ':') are validated as URLs before
 * the plugin's onResolve hook can intercept them. By rewriting
 * in onLoad, we avoid this issue.
 */
function rewriteThinkwellImports(source: string): string {
  // Match import/export statements with thinkwell:* specifiers
  // Handles: import { x } from "thinkwell:foo"
  //          import x from 'thinkwell:foo'
  //          export { x } from "thinkwell:foo"
  return source.replace(
    /(from\s+['"])thinkwell:(\w+)(['"])/g,
    (_, prefix, moduleName, suffix) => {
      const npmPackage = THINKWELL_MODULES[moduleName];
      if (npmPackage) {
        return `${prefix}${npmPackage}${suffix}`;
      }
      // Unknown module - leave as is (will error at resolution)
      return `${prefix}thinkwell:${moduleName}${suffix}`;
    }
  );
}

const schemaCache = new SchemaCache();

/**
 * Strip shebang line from source if present.
 * Returns tuple of [shebang line or empty string, rest of source].
 * Shebangs are valid for executable scripts but not valid JS/TS syntax.
 */
function extractShebang(source: string): [string, string] {
  if (source.startsWith("#!")) {
    const newlineIndex = source.indexOf("\n");
    if (newlineIndex !== -1) {
      return [source.slice(0, newlineIndex + 1), source.slice(newlineIndex + 1)];
    }
    return [source, ""];
  }
  return ["", source];
}

/**
 * Transpile TypeScript/TSX to JavaScript with error handling.
 *
 * Due to a Bun bug (as of 1.2.x), returning `loader: "ts"` from onLoad
 * doesn't properly transpile TypeScript in runtime plugins. As a workaround,
 * we use Bun.Transpiler to manually convert to JS before returning.
 *
 * @param source - The TypeScript source code
 * @param loader - The loader type ("ts" or "tsx")
 * @param filePath - The file path (for error messages)
 * @throws Error with helpful message if transpilation fails
 */
function safeTranspile(source: string, loader: "ts" | "tsx", filePath: string): string {
  try {
    const transpiler = new Bun.Transpiler({ loader });
    return transpiler.transformSync(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[@thinkwell/bun-plugin] Failed to transpile: ${filePath}\n` +
        `  Error: ${message}\n` +
        `  Hint: Check for syntax errors in the file`
    );
  }
}

/**
 * The thinkwell Bun plugin for automatic schema generation.
 */
export const thinkwellPlugin: BunPlugin = {
  name: "thinkwell-schema",

  setup(build) {
    // Handle thinkwell:* URI scheme imports
    build.onResolve({ filter: /^thinkwell:/ }, (args) => {
      const moduleName = args.path.replace("thinkwell:", "");
      const npmPackage = THINKWELL_MODULES[moduleName];

      if (!npmPackage) {
        const available = Object.keys(THINKWELL_MODULES)
          .map((m) => `thinkwell:${m}`)
          .join(", ");
        throw new Error(
          `[@thinkwell/bun-plugin] Unknown module: "${args.path}"\n` +
            `  Available modules: ${available}\n` +
            `  Imported from: ${args.importer || "unknown"}`
        );
      }

      // Resolve to the npm package - Bun will handle the actual resolution
      return {
        path: npmPackage,
        external: true,
      };
    });

    build.onLoad({ filter: /\.tsx?$/ }, async ({ path }) => {
      // Read file with error handling
      let rawSource: string;
      try {
        rawSource = await Bun.file(path).text();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[@thinkwell/bun-plugin] Failed to read file: ${path}\n` +
            `  Error: ${message}`
        );
      }

      const loader = path.endsWith(".tsx") ? "tsx" : "ts";

      // Extract shebang if present - we'll strip it since we're transpiling to JS
      let [, source] = extractShebang(rawSource);

      // Rewrite thinkwell:* imports to npm packages (must happen before transpilation)
      source = rewriteThinkwellImports(source);

      // Fast path: skip files without @JSONSchema
      if (!source.includes(JSONSCHEMA_TAG)) {
        // Transpile to JS as a workaround for Bun's loader bug
        return { contents: safeTranspile(source, loader, path), loader: "js" };
      }

      // Check cache (use rawSource mtime, but process without shebang)
      let mtime: number;
      try {
        const stat = await Bun.file(path).stat();
        mtime = stat.mtime.getTime();
      } catch (error) {
        // If stat fails, use current time (no caching for this run)
        mtime = Date.now();
      }

      const cached = schemaCache.get(path, mtime);

      let markedTypes: TypeInfo[];
      let schemas: Map<string, object>;

      if (cached) {
        markedTypes = cached.types;
        schemas = cached.schemas;
      } else {
        // Parse with TypeScript to find marked types
        markedTypes = findMarkedTypes(path, source);

        if (markedTypes.length === 0) {
          return { contents: safeTranspile(source, loader, path), loader: "js" };
        }

        // Generate schemas using ts-json-schema-generator
        schemas = generateSchemas(path, markedTypes);

        // Cache the results
        schemaCache.set(path, mtime, markedTypes, schemas);
      }

      if (markedTypes.length === 0) {
        return { contents: safeTranspile(source, loader, path), loader: "js" };
      }

      // Generate namespace insertions positioned right after each type
      const insertions = generateInsertions(markedTypes, schemas);

      // Apply insertions to the source (insertions are sorted descending by position)
      let modifiedSource = applyInsertions(source, insertions);

      // Add the import statement at the top of the file
      modifiedSource = generateImport() + "\n" + modifiedSource;

      // Transpile the modified source to JS
      return {
        contents: safeTranspile(modifiedSource, loader, path),
        loader: "js",
      };
    });
  },
};

// Register the plugin when this module is preloaded
plugin(thinkwellPlugin);

export default thinkwellPlugin;
export type { TypeInfo } from "./transform.js";
export { THINKWELL_MODULES } from "./modules.js";

// Declaration file generation for IDE support
export {
  generateDeclarationContent,
  getDeclarationPath,
  writeDeclarationFile,
  removeDeclarationFile,
  generateDeclarations,
  type DeclarationGeneratorOptions,
} from "./declarations.js";

// File watcher for automatic declaration regeneration
export {
  DeclarationWatcher,
  watchDeclarations,
  type WatcherOptions,
} from "./watcher.js";

// Schema generation utilities
export {
  generateSchemas,
  invalidateProgramCache,
  clearProgramCache,
} from "./schema-generator.js";

// Program cache for performance
export { ProgramCache, programCache, findTsConfig } from "./program-cache.js";
