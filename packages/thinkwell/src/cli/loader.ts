/**
 * Custom script loader for the pkg-compiled binary.
 *
 * This module provides the runtime infrastructure for loading and executing
 * user scripts in the pkg binary. It handles:
 *
 * 1. **Module Resolution**: Routes imports to the appropriate source:
 *    - `thinkwell:*` imports → bundled packages via `global.__bundled__`
 *    - thinkwell packages → bundled packages via `global.__bundled__`
 *    - External packages → user's node_modules via `require.resolve()`
 *
 * 2. **Import Transformation**: Rewrites user script imports before execution:
 *    - `import { Agent } from "thinkwell:agent"` → bundled thinkwell
 *    - `import { Agent } from "thinkwell"` → bundled thinkwell
 *
 * 3. **@JSONSchema Processing**: Generates JSON schemas for marked types and
 *    injects namespace declarations with SchemaProvider implementations.
 *
 * 4. **Script Loading**: Uses Node's require() with temp files for transformed scripts
 *
 * Unlike the Bun plugin which runs at bundle time, this loader operates at
 * runtime when the user script is executed.
 */

import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";
import { hasJsonSchemaMarkers, transformJsonSchemas } from "./schema.js";

/**
 * Extended Module interface with internal Node.js methods.
 * These methods exist at runtime but aren't in the public type definitions.
 */
interface ModuleInternal extends Module {
  _compile(source: string, filename: string): void;
}

interface ModuleConstructorInternal {
  new (id: string, parent?: Module): ModuleInternal;
  _nodeModulePaths(from: string): string[];
}

/**
 * Maps thinkwell:* URI scheme to npm package names.
 * Duplicated from bun-plugin for pkg binary independence.
 */
const THINKWELL_MODULES: Record<string, string> = {
  agent: "thinkwell",
  acp: "@thinkwell/acp",
  protocol: "@thinkwell/protocol",
  connectors: "thinkwell",
};

/**
 * Package names that should be resolved from bundled modules.
 */
const BUNDLED_PACKAGES = ["thinkwell", "@thinkwell/acp", "@thinkwell/protocol"];

/**
 * Global registry for bundled modules.
 * This is populated by main-pkg.cjs before loading user scripts.
 */
declare global {
  // eslint-disable-next-line no-var
  var __bundled__: Record<string, unknown> | undefined;
}

/**
 * Initialize the bundled module registry.
 *
 * This should be called from main-pkg.cjs with the bundled package exports.
 * The registry is used by createCustomRequire to route thinkwell imports.
 *
 * @param modules - Map of package names to their exports
 */
export function initializeBundledRegistry(
  modules: Record<string, unknown>
): void {
  global.__bundled__ = modules;
}

/**
 * Check if a module name refers to a bundled package.
 */
function isBundledPackage(moduleName: string): boolean {
  return BUNDLED_PACKAGES.includes(moduleName);
}

/**
 * Strip shebang line from source if present.
 *
 * Shebangs are valid for executable scripts but not valid JS/TS syntax.
 * We need to strip them before Module._compile processes the source.
 *
 * @param source - The script source code
 * @returns Tuple of [shebang line or empty string, rest of source]
 */
export function extractShebang(source: string): [string, string] {
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
 * Transform thinkwell:* imports to use bundled packages.
 *
 * Rewrites import specifiers from the thinkwell:* URI scheme to
 * their corresponding npm package names.
 *
 * @example
 * ```typescript
 * // Input:
 * import { Agent } from "thinkwell:agent";
 *
 * // Output:
 * import { Agent } from "thinkwell";
 * ```
 *
 * @param source - The script source code
 * @returns The source with thinkwell:* imports rewritten
 */
export function rewriteThinkwellImports(source: string): string {
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

/**
 * Transform imports to use the bundled module registry.
 *
 * In the pkg binary, we can't rely on Node's normal module resolution
 * for bundled packages (they're in the /snapshot/ virtual filesystem).
 * This transform rewrites imports to use global.__bundled__ directly.
 *
 * @example
 * ```typescript
 * // Input:
 * import { Agent } from "thinkwell";
 *
 * // Output:
 * const { Agent } = global.__bundled__["thinkwell"];
 * ```
 *
 * @param source - The script source code
 * @returns The source with bundled package imports transformed
 */
export function transformVirtualImports(source: string): string {
  // Match named imports from thinkwell packages
  // Pattern: import { x, y } from "thinkwell" or import { x } from "@thinkwell/acp"
  const importPattern =
    /import\s+\{([^}]+)\}\s+from\s+['"](@thinkwell\/(?:acp|protocol)|thinkwell)['"]/g;

  source = source.replace(importPattern, (_, imports, packageName) => {
    const cleanImports = imports.trim();
    return `const {${cleanImports}} = global.__bundled__["${packageName}"]`;
  });

  // Match default imports from thinkwell packages
  // Pattern: import Foo from "thinkwell" or import Foo from "@thinkwell/acp"
  const defaultImportPattern =
    /import\s+(\w+)\s+from\s+['"](@thinkwell\/(?:acp|protocol)|thinkwell)['"]/g;

  source = source.replace(defaultImportPattern, (_, importName, packageName) => {
    return `const ${importName} = global.__bundled__["${packageName}"].default || global.__bundled__["${packageName}"]`;
  });

  // Match namespace imports from thinkwell packages
  // Pattern: import * as Foo from "thinkwell"
  const namespaceImportPattern =
    /import\s+\*\s+as\s+(\w+)\s+from\s+['"](@thinkwell\/(?:acp|protocol)|thinkwell)['"]/g;

  source = source.replace(namespaceImportPattern, (_, importName, packageName) => {
    return `const ${importName} = global.__bundled__["${packageName}"]`;
  });

  // Match type-only imports (remove them - they're only for TypeScript)
  // Pattern: import type { Foo } from "thinkwell"
  const typeImportPattern =
    /import\s+type\s+\{[^}]+\}\s+from\s+['"](@thinkwell\/(?:acp|protocol)|thinkwell)['"]\s*;?/g;

  source = source.replace(typeImportPattern, "");

  return source;
}

/**
 * Create a custom require function that routes imports appropriately.
 *
 * This function creates a require implementation that:
 * 1. Checks bundled modules first (thinkwell packages)
 * 2. Falls back to require.resolve from the script's directory
 * 3. Falls back to global require for built-in modules
 *
 * @param scriptPath - Absolute path to the user script
 * @returns A require function bound to the script's directory
 */
export function createCustomRequire(
  scriptPath: string
): NodeJS.Require {
  const scriptDir = dirname(scriptPath);
  const nodeModulesPath = join(scriptDir, "node_modules");

  // Create a base require function using Node's createRequire
  const baseRequire = createRequire(scriptPath);

  function customRequire(moduleName: string): unknown {
    // First check if it's a bundled module
    if (global.__bundled__ && isBundledPackage(moduleName)) {
      const bundled = global.__bundled__[moduleName];
      if (bundled) {
        return bundled;
      }
    }

    // Try to resolve from the script's directory using baseRequire
    try {
      const resolved = baseRequire.resolve(moduleName, {
        paths: [scriptDir, nodeModulesPath],
      });
      return baseRequire(resolved);
    } catch {
      // Fall back to the base require without custom paths
      return baseRequire(moduleName);
    }
  }

  // Copy over require properties that modules might depend on
  customRequire.resolve = ((id: string, options?: { paths?: string[] }) => {
    // Check bundled first
    if (global.__bundled__ && isBundledPackage(id)) {
      // Return a fake path for bundled modules
      return `/__bundled__/${id}`;
    }

    // Try script directory paths first
    const paths = options?.paths ?? [scriptDir, nodeModulesPath];
    try {
      return baseRequire.resolve(id, { paths });
    } catch {
      return baseRequire.resolve(id, options);
    }
  }) as NodeJS.RequireResolve;

  // Stub paths property
  customRequire.resolve.paths = baseRequire.resolve.paths;

  customRequire.cache = baseRequire.cache;
  customRequire.extensions = baseRequire.extensions;
  customRequire.main = baseRequire.main;

  return customRequire as NodeJS.Require;
}

/**
 * Check if source code needs transformation.
 *
 * @param source - The script source code
 * @returns true if the source contains thinkwell imports or @JSONSchema markers
 */
function needsTransformation(source: string): boolean {
  // Check for thinkwell:* URI scheme imports
  if (/from\s+['"]thinkwell:\w+['"]/.test(source)) {
    return true;
  }
  // Check for bundled package imports
  if (/from\s+['"](?:thinkwell|@thinkwell\/(?:acp|protocol))['"]/.test(source)) {
    return true;
  }
  // Check for @JSONSchema markers
  if (hasJsonSchemaMarkers(source)) {
    return true;
  }
  return false;
}

/**
 * Load and execute a user script with custom module resolution.
 *
 * This function handles two loading strategies:
 *
 * 1. **Direct require()** - For scripts that don't use thinkwell imports.
 *    This leverages Node's --experimental-strip-types for TypeScript support.
 *
 * 2. **Transform and compile** - For scripts that use thinkwell:* imports
 *    or import from bundled packages. The script is transformed and written
 *    to a temp file, then required (which applies type stripping).
 *
 * @param scriptPath - Absolute path to the script to load
 * @returns The module exports from the script
 * @throws Error if the script cannot be loaded or executed
 */
export function loadScript(scriptPath: string): unknown {
  // Ensure absolute path
  const absolutePath = isAbsolute(scriptPath)
    ? scriptPath
    : resolve(process.cwd(), scriptPath);

  // Read the script source to check if transformation is needed
  const rawSource = readFileSync(absolutePath, "utf-8");

  // Strip shebang for analysis (shebang is stripped by Node's loader anyway)
  const [, sourceWithoutShebang] = extractShebang(rawSource);

  // Check if source needs our transformation
  if (!needsTransformation(sourceWithoutShebang)) {
    // No transformation needed - use direct require()
    // This preserves Node's type stripping for TypeScript files
    const baseRequire = createRequire(absolutePath);
    return baseRequire(absolutePath);
  }

  // Source needs transformation - apply transforms and use a temp file
  // Rewrite thinkwell:* imports to npm package names
  let source = rewriteThinkwellImports(sourceWithoutShebang);

  // Process @JSONSchema types (must happen before import transformation
  // because it adds an import statement that also needs transformation)
  source = transformJsonSchemas(absolutePath, source);

  // Transform imports to use bundled modules (global.__bundled__)
  source = transformVirtualImports(source);

  // Write transformed source to a temp file
  // Use the same extension to ensure Node applies the right loader
  const ext = absolutePath.endsWith(".ts") ? ".ts" : ".js";
  const tempDir = join(dirname(absolutePath), ".thinkwell-cache");
  const tempFile = join(tempDir, `_transformed_${Date.now()}${ext}`);

  try {
    // Ensure temp directory exists
    mkdirSync(tempDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  try {
    // Write transformed source
    writeFileSync(tempFile, source, "utf-8");

    // Require the transformed file - this uses Node's type stripping
    const baseRequire = createRequire(absolutePath);
    const result = baseRequire(tempFile);

    return result;
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Load and execute a user script, handling both sync and async exports.
 *
 * After loading, this function checks if the script exports a main function
 * or default export and executes it if present.
 *
 * @param scriptPath - Absolute path to the script to load
 * @param args - Additional arguments to pass to the script's argv
 * @returns Promise that resolves when script execution completes
 */
export async function runScript(
  scriptPath: string,
  args: string[] = []
): Promise<void> {
  // Set up process.argv for the script
  const originalArgv = process.argv;
  process.argv = [process.execPath, scriptPath, ...args];

  try {
    const exports = loadScript(scriptPath);

    // Check for common entry point patterns
    if (exports && typeof exports === "object") {
      const mod = exports as Record<string, unknown>;

      // Pattern 1: default export function
      if (typeof mod.default === "function") {
        await mod.default();
        return;
      }

      // Pattern 2: main function
      if (typeof mod.main === "function") {
        await mod.main();
        return;
      }

      // Pattern 3: run function
      if (typeof mod.run === "function") {
        await mod.run();
        return;
      }
    }

    // Pattern 4: direct function export
    if (typeof exports === "function") {
      await exports();
    }

    // Otherwise, the script executed its code at module level
  } finally {
    // Restore original argv
    process.argv = originalArgv;
  }
}
