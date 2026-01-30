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
 * Transpile TypeScript/TSX to JavaScript.
 *
 * Due to a Bun bug (as of 1.2.x), returning `loader: "ts"` from onLoad
 * doesn't properly transpile TypeScript in runtime plugins. As a workaround,
 * we use Bun.Transpiler to manually convert to JS before returning.
 */
function transpile(source: string, loader: "ts" | "tsx"): string {
  const transpiler = new Bun.Transpiler({ loader });
  return transpiler.transformSync(source);
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
        throw new Error(
          `Unknown thinkwell module: "${args.path}". ` +
            `Available modules: ${Object.keys(THINKWELL_MODULES)
              .map((m) => `thinkwell:${m}`)
              .join(", ")}`
        );
      }

      // Resolve to the npm package - Bun will handle the actual resolution
      return {
        path: npmPackage,
        external: true,
      };
    });

    build.onLoad({ filter: /\.tsx?$/ }, async ({ path }) => {
      const rawSource = await Bun.file(path).text();
      const loader = path.endsWith(".tsx") ? "tsx" : "ts";

      // Extract shebang if present - we'll strip it since we're transpiling to JS
      const [, source] = extractShebang(rawSource);

      // Fast path: skip files without @JSONSchema
      if (!source.includes(JSONSCHEMA_TAG)) {
        // Transpile to JS as a workaround for Bun's loader bug
        return { contents: transpile(source, loader), loader: "js" };
      }

      // Check cache (use rawSource mtime, but process without shebang)
      const stat = Bun.file(path);
      const mtime = (await stat.stat()).mtime.getTime();
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
          return { contents: transpile(source, loader), loader: "js" };
        }

        // Generate schemas using ts-json-schema-generator
        schemas = generateSchemas(path, markedTypes);

        // Cache the results
        schemaCache.set(path, mtime, markedTypes, schemas);
      }

      if (markedTypes.length === 0) {
        return { contents: transpile(source, loader), loader: "js" };
      }

      // Generate namespace insertions positioned right after each type
      const insertions = generateInsertions(markedTypes, schemas);

      // Apply insertions to the source (insertions are sorted descending by position)
      let modifiedSource = applyInsertions(source, insertions);

      // Add the import statement at the top of the file
      modifiedSource = generateImport() + "\n" + modifiedSource;

      // Transpile the modified source to JS
      return {
        contents: transpile(modifiedSource, loader),
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
