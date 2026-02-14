/**
 * Module resolution for standalone thinkwell scripts and the virtual
 * augmentations file.
 *
 * Standalone scripts use `#!/usr/bin/env thinkwell` and don't have
 * node_modules — the CLI bundles all dependencies internally. This module
 * locates the thinkwell CLI installation and resolves `thinkwell`,
 * `@thinkwell/acp`, and `@thinkwell/protocol` imports to the .d.ts files
 * shipped with the npm package.
 *
 * The augmentations file (`.thinkwell/augmentations.d.ts`) also needs
 * custom resolution because it uses `import("thinkwell").SchemaProvider`
 * type references that must resolve to the same `SchemaProvider` generic
 * interface used by `think()`.
 *
 * Layout of an npm-installed thinkwell package:
 *
 *   <prefix>/lib/node_modules/thinkwell/
 *     bin/thinkwell          (CLI launcher)
 *     dist/index.d.ts        (thinkwell types)
 *     package.json
 *   <prefix>/lib/node_modules/@thinkwell/acp/
 *     dist/index.d.ts        (acp types)
 *   <prefix>/lib/node_modules/@thinkwell/protocol/
 *     dist/index.d.ts        (protocol types)
 */

import type ts from "typescript";
import path from "node:path";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";

/** Module specifiers we intercept. */
const THINKWELL_MODULES = new Set([
  "thinkwell",
  "@thinkwell/acp",
  "@thinkwell/protocol",
]);

/** Cached result of locating the thinkwell installation. */
export interface ThinkwellInstallation {
  /** Root directory of the thinkwell npm package. */
  packageRoot: string;
  /** The node_modules directory containing the thinkwell package. */
  nodeModulesDir: string;
}

/** Function type for locating the thinkwell installation. */
export type InstallationLocator = (log: (msg: string) => void) => ThinkwellInstallation | null;

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
 * Locate the thinkwell CLI installation by running `which thinkwell`,
 * then resolving symlinks and walking up to the package root.
 *
 * Returns null if the CLI can't be found.
 */
function locateInstallation(log: (msg: string) => void): ThinkwellInstallation | null {
  let binPath: string;

  try {
    binPath = execSync("which thinkwell", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    log("[thinkwell] Could not locate thinkwell CLI via 'which thinkwell'");
    return null;
  }

  if (!binPath) return null;

  // Resolve symlinks to get the real path
  try {
    binPath = realpathSync(binPath);
  } catch {
    log(`[thinkwell] Could not resolve symlink for: ${binPath}`);
    return null;
  }

  // The bin script lives at <packageRoot>/bin/thinkwell
  const packageRoot = path.dirname(path.dirname(binPath));

  // Verify this looks like a thinkwell package
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    log(`[thinkwell] No package.json found at: ${packageRoot}`);
    return null;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (packageJson.name !== "thinkwell") {
      log(`[thinkwell] Package at ${packageRoot} is not thinkwell (found: ${packageJson.name})`);
      return null;
    }
  } catch {
    log(`[thinkwell] Could not parse package.json at: ${packageJsonPath}`);
    return null;
  }

  // The node_modules dir is the parent of the package root
  // e.g., .../node_modules/thinkwell -> node_modules is ../
  const nodeModulesDir = path.dirname(packageRoot);

  log(`[thinkwell] Located thinkwell installation at: ${packageRoot}`);

  return { packageRoot, nodeModulesDir };
}

/**
 * Resolve a thinkwell module specifier to its .d.ts file path within
 * the CLI installation.
 */
export function resolveModulePath(
  specifier: string,
  installation: ThinkwellInstallation,
): string | null {
  // Map specifier to its package directory
  let packageDir: string;
  if (specifier === "thinkwell") {
    packageDir = installation.packageRoot;
  } else {
    // @thinkwell/acp or @thinkwell/protocol — resolve from the same node_modules
    packageDir = path.join(installation.nodeModulesDir, specifier);
  }

  // Read the package.json to find the types entry point
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    // Check exports["."].types first, then fall back to "types" field
    const typesPath =
      packageJson.exports?.["."]?.types ??
      packageJson.types;

    if (!typesPath) return null;

    const resolved = path.resolve(packageDir, typesPath);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Install the `resolveModuleNameLiterals` monkey-patch on the
 * LanguageServiceHost.
 *
 * This intercepts module resolution for thinkwell imports in standalone
 * scripts and in the virtual augmentations file, redirecting them to the
 * .d.ts files bundled with the CLI.
 */
export function patchModuleResolution(
  info: ts.server.PluginCreateInfo,
  tsModule: typeof ts,
  locator?: InstallationLocator,
): void {
  const log = (msg: string) => info.project.log(msg);
  const locate = locator ?? locateInstallation;

  // Cache the installation lookup (null means "not yet attempted")
  let installation: ThinkwellInstallation | null | undefined;

  function getInstallation(): ThinkwellInstallation | null {
    if (installation === undefined) {
      installation = locate(log);
    }
    return installation;
  }

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

    // Extract the text of a module literal (AST node with .text property)
    const getText = (literal: ts.StringLiteralLike): string => literal.text;

    // Check if any thinkwell imports failed to resolve
    let needsCustomResolution = false;
    for (let i = 0; i < moduleLiterals.length; i++) {
      const specifier = getText(moduleLiterals[i]);
      if (THINKWELL_MODULES.has(specifier) && !results[i].resolvedModule) {
        needsCustomResolution = true;
        break;
      }
    }

    if (!needsCustomResolution) return results;

    // Activate for standalone scripts and for the augmentations file
    // (which uses `import("thinkwell").SchemaProvider` type references)
    if (!isStandalone(containingFile) && !isAugmentationsFile(containingFile)) {
      return results;
    }

    const inst = getInstallation();
    if (!inst) return results;

    // Resolve each unresolved thinkwell import
    for (let i = 0; i < moduleLiterals.length; i++) {
      const specifier = getText(moduleLiterals[i]);

      if (!THINKWELL_MODULES.has(specifier)) continue;
      if (results[i].resolvedModule) continue;

      const resolvedPath = resolveModulePath(specifier, inst);
      if (resolvedPath) {
        log(`[thinkwell] Resolved import '${specifier}' in ${path.basename(containingFile)} → ${resolvedPath}`);
        results[i] = {
          resolvedModule: {
            resolvedFileName: resolvedPath,
            isExternalLibraryImport: true,
            extension: tsModule.Extension.Dts,
          },
        } as ts.ResolvedModuleWithFailedLookupLocations;
      }
    }

    return results;
  };

  log("[thinkwell] Module resolution patch installed");
}
