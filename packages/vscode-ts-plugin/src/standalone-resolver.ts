/**
 * Module resolution for standalone thinkwell scripts and the virtual
 * augmentations file.
 *
 * Standalone scripts use `#!/usr/bin/env thinkwell` and don't have
 * node_modules — the CLI bundles all dependencies internally. This module
 * resolves `thinkwell`, `@thinkwell/acp`, and `@thinkwell/protocol` imports
 * to bundled .d.ts declarations embedded in the plugin at build time.
 *
 * The augmentations file (`.thinkwell/augmentations.d.ts`) also needs
 * custom resolution because it uses `import("thinkwell").SchemaProvider`
 * type references that must resolve to the same `SchemaProvider` generic
 * interface used by `think()`.
 */

import type ts from "typescript";
import path from "node:path";
import { BUNDLED_TYPES } from "./generated/bundled-types";

/** Module specifiers we intercept. */
const THINKWELL_MODULES = new Set([
  "thinkwell",
  "@thinkwell/acp",
  "@thinkwell/protocol",
]);

/**
 * Virtual path prefix for bundled type declarations.
 * Absolute path that won't collide with real filesystem paths.
 */
export const VIRTUAL_TYPES_PREFIX = "/__thinkwell_types__";

/**
 * Get the virtual file path for a bundled .d.ts file.
 *
 * @param moduleName - e.g., "thinkwell" or "@thinkwell/acp"
 * @param fileName - e.g., "index.d.ts" or "agent.d.ts"
 */
export function virtualTypePath(moduleName: string, fileName: string): string {
  return `${VIRTUAL_TYPES_PREFIX}/${moduleName}/${fileName}`;
}

/**
 * Check if a path is a virtual bundled type path and return the content
 * if it exists, or undefined otherwise.
 */
export function getVirtualTypeContent(filePath: string): string | undefined {
  if (!filePath.startsWith(VIRTUAL_TYPES_PREFIX + "/")) return undefined;

  const rest = filePath.slice(VIRTUAL_TYPES_PREFIX.length + 1);

  // Try each module to see if the path matches
  for (const [moduleName, pkg] of Object.entries(BUNDLED_TYPES)) {
    const prefix = moduleName + "/";
    if (rest.startsWith(prefix)) {
      const fileName = rest.slice(prefix.length);
      return pkg.files[fileName];
    }
  }

  return undefined;
}

/**
 * Check whether a file is a standalone thinkwell script by looking for
 * a `#!/usr/bin/env thinkwell` shebang on the first line.
 */
export function isStandaloneScript(
  fileName: string,
  host: ts.LanguageServiceHost,
): boolean {
  const snapshot = host.getScriptSnapshot(fileName);
  if (!snapshot) return false;

  // Only need to read the first line
  const head = snapshot.getText(0, Math.min(snapshot.getLength(), 256));
  const firstLine = head.split("\n")[0];
  return /^#!.*\bthinkwell\b/.test(firstLine);
}

/**
 * Try to resolve a relative import specifier (e.g., `./agent.js`) from
 * within a virtual type file to another virtual type file.
 *
 * Returns the virtual path if the target exists in the bundled types,
 * or undefined otherwise.
 */
function resolveRelativeVirtualImport(
  specifier: string,
  containingFile: string,
): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  if (!containingFile.startsWith(VIRTUAL_TYPES_PREFIX + "/")) return undefined;

  const containingDir = path.posix.dirname(containingFile);
  let resolved = path.posix.resolve(containingDir, specifier);

  // TypeScript's .js → .d.ts extension mapping: ./agent.js → ./agent.d.ts
  if (resolved.endsWith(".js")) {
    resolved = resolved.slice(0, -3) + ".d.ts";
  } else if (!resolved.endsWith(".d.ts")) {
    resolved = resolved + ".d.ts";
  }

  // Check if this virtual path has content
  if (getVirtualTypeContent(resolved) !== undefined) {
    return resolved;
  }

  return undefined;
}

/**
 * Install the `resolveModuleNameLiterals` monkey-patch on the
 * LanguageServiceHost.
 *
 * This intercepts module resolution for thinkwell imports in standalone
 * scripts and in the virtual augmentations file, redirecting them to
 * bundled .d.ts declarations.
 */
export function patchModuleResolution(
  info: ts.server.PluginCreateInfo,
  tsModule: typeof ts,
): void {
  const log = (msg: string) => info.project.log(msg);

  // Cache per-file standalone detection
  const standaloneCache = new Map<string, boolean>();

  function isStandalone(fileName: string): boolean {
    let result = standaloneCache.get(fileName);
    if (result === undefined) {
      result = isStandaloneScript(fileName, info.languageServiceHost);
      standaloneCache.set(fileName, result);
    }
    return result;
  }

  /** Check if a file is the virtual augmentations file. */
  function isAugmentationsFile(fileName: string): boolean {
    return fileName.endsWith(".thinkwell/augmentations.d.ts");
  }

  /** Check if a file is a bundled virtual type file. */
  function isVirtualTypeFile(fileName: string): boolean {
    return fileName.startsWith(VIRTUAL_TYPES_PREFIX + "/");
  }

  const original = info.languageServiceHost.resolveModuleNameLiterals?.bind(
    info.languageServiceHost,
  );

  info.languageServiceHost.resolveModuleNameLiterals = (
    moduleLiterals,
    containingFile,
    redirectedReference,
    options,
    containingSourceFile,
    reusedNames,
  ) => {
    // Call the original resolver first
    const results = original
      ? [...original(
          moduleLiterals,
          containingFile,
          redirectedReference,
          options,
          containingSourceFile,
          reusedNames,
        )]
      : moduleLiterals.map(() => ({ resolvedModule: undefined } as ts.ResolvedModuleWithFailedLookupLocations));

    const getText = (literal: ts.StringLiteralLike): string => literal.text;

    // For virtual type files, resolve relative imports between bundled files
    if (isVirtualTypeFile(containingFile)) {
      for (let i = 0; i < moduleLiterals.length; i++) {
        if (results[i].resolvedModule) continue;

        const specifier = getText(moduleLiterals[i]);

        // Handle relative imports (./agent.js → virtual agent.d.ts)
        const virtualPath = resolveRelativeVirtualImport(specifier, containingFile);
        if (virtualPath) {
          results[i] = {
            resolvedModule: {
              resolvedFileName: virtualPath,
              isExternalLibraryImport: true,
              extension: tsModule.Extension.Dts,
            },
          } as ts.ResolvedModuleWithFailedLookupLocations;
          continue;
        }

        // Handle bare thinkwell module imports (cross-package references)
        if (THINKWELL_MODULES.has(specifier)) {
          const pkg = BUNDLED_TYPES[specifier];
          if (pkg?.files["index.d.ts"]) {
            const resolvedPath = virtualTypePath(specifier, "index.d.ts");
            results[i] = {
              resolvedModule: {
                resolvedFileName: resolvedPath,
                isExternalLibraryImport: true,
                extension: tsModule.Extension.Dts,
              },
            } as ts.ResolvedModuleWithFailedLookupLocations;
          }
        }
      }

      return results;
    }

    // For non-virtual files: only activate for standalone scripts and
    // the augmentations file, and only for bare thinkwell module imports
    let needsCustomResolution = false;
    for (let i = 0; i < moduleLiterals.length; i++) {
      const specifier = getText(moduleLiterals[i]);
      if (THINKWELL_MODULES.has(specifier) && !results[i].resolvedModule) {
        needsCustomResolution = true;
        break;
      }
    }

    if (!needsCustomResolution) return results;

    if (!isStandalone(containingFile) && !isAugmentationsFile(containingFile)) {
      return results;
    }

    // Resolve each unresolved thinkwell import to a virtual path
    for (let i = 0; i < moduleLiterals.length; i++) {
      const specifier = getText(moduleLiterals[i]);

      if (!THINKWELL_MODULES.has(specifier)) continue;
      if (results[i].resolvedModule) continue;

      const pkg = BUNDLED_TYPES[specifier];
      if (!pkg?.files["index.d.ts"]) continue;

      const resolvedPath = virtualTypePath(specifier, "index.d.ts");
      log(`[thinkwell] Resolved import '${specifier}' in ${path.basename(containingFile)} → ${resolvedPath}`);
      results[i] = {
        resolvedModule: {
          resolvedFileName: resolvedPath,
          isExternalLibraryImport: true,
          extension: tsModule.Extension.Dts,
        },
      } as ts.ResolvedModuleWithFailedLookupLocations;
    }

    return results;
  };

  log("[thinkwell] Module resolution patch installed (bundled types)");
}
