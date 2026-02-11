/**
 * Package manager detection for `thinkwell build` and `thinkwell check`.
 *
 * Detects the package manager used by a project by checking for lockfiles
 * and the `packageManager` field in package.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

/** Supported package managers. */
export type PackageManager = "pnpm" | "npm" | "yarn";

/** Information about the detected package manager. */
export interface PackageManagerInfo {
  /** The detected package manager. */
  name: PackageManager;
  /** The lockfile that was found, or null if detection was based on packageManager field or default. */
  lockfile: string | null;
  /**
   * Generate an add command for installing a package.
   * @param pkg - The package to install (e.g., "thinkwell" or "thinkwell@^0.5.0")
   * @param dev - Whether to install as a dev dependency
   */
  addCommand: (pkg: string, dev?: boolean) => string;
  /**
   * Generate a why command for checking if a package is installed.
   * @param pkg - The package to check
   */
  whyCommand: (pkg: string) => string[];
}

// ============================================================================
// Lockfile detection
// ============================================================================

/** Lockfile names in priority order. */
const LOCKFILES: ReadonlyArray<{ file: string; pm: PackageManager }> = [
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "yarn.lock", pm: "yarn" },
  { file: "package-lock.json", pm: "npm" },
];

/**
 * Detect package manager by checking for lockfiles.
 * Returns the first lockfile found, or null if none exist.
 */
function detectByLockfile(
  projectDir: string,
): { pm: PackageManager; lockfile: string } | null {
  for (const { file, pm } of LOCKFILES) {
    const lockfilePath = join(projectDir, file);
    if (existsSync(lockfilePath)) {
      return { pm, lockfile: file };
    }
  }
  return null;
}

// ============================================================================
// packageManager field parsing
// ============================================================================

/**
 * Parse the `packageManager` field from package.json.
 *
 * The field format is defined by corepack: `<name>@<version>`
 * Examples: "pnpm@9.0.0", "yarn@4.0.0", "npm@10.0.0"
 *
 * Returns the package manager name, or null if the field is missing/invalid.
 */
export function parsePackageManagerField(value: unknown): PackageManager | null {
  if (typeof value !== "string") {
    return null;
  }

  // Parse the name part (before @version)
  const atIndex = value.indexOf("@");
  const name = atIndex > 0 ? value.slice(0, atIndex) : value;

  // Validate against known package managers
  if (name === "pnpm" || name === "npm" || name === "yarn") {
    return name;
  }

  return null;
}

/**
 * Detect package manager by reading the `packageManager` field from package.json.
 */
function detectByPackageJson(projectDir: string): PackageManager | null {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }

  try {
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    return parsePackageManagerField(pkg.packageManager);
  } catch {
    return null;
  }
}

// ============================================================================
// Command generation
// ============================================================================

/**
 * Create a PackageManagerInfo object for the given package manager.
 */
function createPackageManagerInfo(
  name: PackageManager,
  lockfile: string | null,
): PackageManagerInfo {
  return {
    name,
    lockfile,
    addCommand: (pkg: string, dev?: boolean): string => {
      switch (name) {
        case "pnpm":
          return dev ? `pnpm add -D ${pkg}` : `pnpm add ${pkg}`;
        case "yarn":
          return dev ? `yarn add -D ${pkg}` : `yarn add ${pkg}`;
        case "npm":
          return dev ? `npm install -D ${pkg}` : `npm install ${pkg}`;
      }
    },
    whyCommand: (pkg: string): string[] => {
      switch (name) {
        case "pnpm":
          return ["pnpm", "why", pkg, "--json"];
        case "yarn":
          return ["yarn", "why", pkg, "--json"];
        case "npm":
          return ["npm", "why", pkg, "--json"];
      }
    },
  };
}

// ============================================================================
// Main detection function
// ============================================================================

/**
 * Detect the package manager for a project.
 *
 * Detection priority:
 * 1. Lockfile presence (pnpm-lock.yaml > yarn.lock > package-lock.json)
 * 2. `packageManager` field in package.json
 * 3. Default to npm
 *
 * @param projectDir - The project directory to check
 * @returns Package manager information
 */
export function detectPackageManager(projectDir: string): PackageManagerInfo {
  // 1. Check for lockfiles first (concrete evidence of what's been used)
  const lockfileResult = detectByLockfile(projectDir);
  if (lockfileResult) {
    return createPackageManagerInfo(lockfileResult.pm, lockfileResult.lockfile);
  }

  // 2. Fall back to packageManager field (may be aspirational)
  const fromField = detectByPackageJson(projectDir);
  if (fromField) {
    return createPackageManagerInfo(fromField, null);
  }

  // 3. Default to npm
  return createPackageManagerInfo("npm", null);
}
