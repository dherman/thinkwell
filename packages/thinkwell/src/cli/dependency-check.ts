/**
 * Dependency checking for `thinkwell build` and `thinkwell check`.
 *
 * Implements a hybrid detection strategy:
 * - Fast path: Check package.json directly for dependencies
 * - Slow path: Fall back to `<pm> why --json` for workspace-hoisted dependencies
 *
 * @see doc/rfd/explicit-config.md for the full design
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  detectPackageManager,
  type PackageManagerInfo,
} from "./package-manager.js";

// ============================================================================
// Types
// ============================================================================

/** Where a dependency was found. */
export type DependencySource = "package.json" | "workspace" | "transitive";

/** Status of a single dependency. */
export interface DependencyStatus {
  /** Whether the dependency was found. */
  found: boolean;
  /** The version specifier (if found). */
  version?: string;
  /** Where the dependency was found. */
  source?: DependencySource;
}

/** Result of checking all required dependencies. */
export interface DependencyCheckResult {
  /** Status of the thinkwell dependency. */
  thinkwell: DependencyStatus;
  /** Status of the typescript dependency. */
  typescript: DependencyStatus;
  /** Detected package manager information. */
  packageManager: PackageManagerInfo;
}

// ============================================================================
// Fast Path: Direct package.json Inspection
// ============================================================================

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Read and parse package.json from a directory.
 * Returns null if the file doesn't exist or is invalid JSON.
 */
function readPackageJson(dir: string): PackageJson | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }

  try {
    const content = readFileSync(pkgPath, "utf-8");
    return JSON.parse(content) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Check if a package is declared in package.json (fast path).
 *
 * Checks dependencies, devDependencies, peerDependencies, and optionalDependencies.
 * Returns the dependency status if found, or null if not found.
 */
function checkPackageJsonDirect(
  pkg: PackageJson,
  packageName: string,
): DependencyStatus | null {
  // Check each dependency type
  const depTypes = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ];

  for (const deps of depTypes) {
    if (deps && packageName in deps) {
      return {
        found: true,
        version: deps[packageName],
        source: "package.json",
      };
    }
  }

  return null;
}

// ============================================================================
// Slow Path: Package Manager CLI Inspection
// ============================================================================

/**
 * Execute a command and return its stdout.
 * Rejects if the command fails or returns non-zero exit code.
 */
function execCommand(
  cmd: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = cmd;
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
      }
    });
  });
}

/**
 * Parse pnpm why --json output to determine if a package is installed.
 *
 * pnpm why outputs JSON like:
 * {
 *   "packageName": {
 *     "version": "1.0.0",
 *     "dependents": [...]
 *   }
 * }
 *
 * For workspace-hoisted packages, the package appears with its version.
 */
function parsePnpmWhyOutput(
  stdout: string,
  packageName: string,
): DependencyStatus | null {
  try {
    const result = JSON.parse(stdout);

    // pnpm why returns an object with the package name as key
    if (result && typeof result === "object" && packageName in result) {
      const info = result[packageName];
      return {
        found: true,
        version: info?.version,
        source: "workspace",
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse npm why --json output to determine if a package is installed.
 *
 * npm why (npm explain) outputs JSON array like:
 * [
 *   {
 *     "name": "packageName",
 *     "version": "1.0.0",
 *     "dependents": [...]
 *   }
 * ]
 *
 * An empty array or error object means the package is not found.
 */
function parseNpmWhyOutput(
  stdout: string,
  _packageName: string,
): DependencyStatus | null {
  try {
    const result = JSON.parse(stdout);

    // npm why returns an array of explanations
    if (Array.isArray(result) && result.length > 0) {
      const first = result[0];
      return {
        found: true,
        version: first?.version,
        source: "workspace",
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse yarn why --json output to determine if a package is installed.
 *
 * Yarn Classic (v1) outputs newline-delimited JSON objects:
 * {"type":"info","data":"Found \"package@version\"..."}
 *
 * Yarn Berry (v2+) outputs similar but structured differently.
 * Exit code 0 with output indicates the package was found.
 */
function parseYarnWhyOutput(
  stdout: string,
  _packageName: string,
): DependencyStatus | null {
  // If there's any output and the command succeeded (which it did if we got here),
  // the package was found
  if (stdout.trim().length > 0) {
    // Try to extract version from the output
    // Yarn classic: {"type":"info","data":"Found \"pkg@1.0.0\"..."}
    let version: string | undefined;

    try {
      // Parse each line as JSON (yarn outputs newline-delimited JSON)
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj.type === "info" && obj.data) {
          // Extract version from "Found \"pkg@1.0.0\"" pattern
          const match = obj.data.match(/"[^@]+@([^"]+)"/);
          if (match) {
            version = match[1];
            break;
          }
        }
      }
    } catch {
      // Couldn't parse version, but package was found
    }

    return {
      found: true,
      version,
      source: "workspace",
    };
  }

  return null;
}

/**
 * Check for a package using the package manager's `why` command (slow path).
 *
 * This handles workspace-hoisted dependencies that aren't declared directly
 * in the current package's package.json.
 */
async function checkViaPackageManager(
  pm: PackageManagerInfo,
  packageName: string,
  cwd: string,
): Promise<DependencyStatus | null> {
  const cmd = pm.whyCommand(packageName);

  try {
    const { stdout } = await execCommand(cmd, cwd);

    switch (pm.name) {
      case "pnpm":
        return parsePnpmWhyOutput(stdout, packageName);
      case "npm":
        return parseNpmWhyOutput(stdout, packageName);
      case "yarn":
        return parseYarnWhyOutput(stdout, packageName);
    }
  } catch {
    // Command failed — package not found
    return null;
  }
}

// ============================================================================
// Main Check Function
// ============================================================================

/**
 * Check whether required dependencies (thinkwell, typescript) are available.
 *
 * Uses a hybrid strategy:
 * 1. Fast path: Check package.json directly
 * 2. Slow path: If not found, check via package manager CLI for workspace-hoisted deps
 *
 * @param projectDir - The project directory to check
 * @returns Status of both dependencies and package manager info
 */
export async function checkDependencies(
  projectDir: string,
): Promise<DependencyCheckResult> {
  const pm = detectPackageManager(projectDir);
  const pkg = readPackageJson(projectDir);

  // Initialize results
  let thinkwellStatus: DependencyStatus = { found: false };
  let typescriptStatus: DependencyStatus = { found: false };

  // Fast path: check package.json directly
  if (pkg) {
    const thinkwellDirect = checkPackageJsonDirect(pkg, "thinkwell");
    if (thinkwellDirect) {
      thinkwellStatus = thinkwellDirect;
    }

    const typescriptDirect = checkPackageJsonDirect(pkg, "typescript");
    if (typescriptDirect) {
      typescriptStatus = typescriptDirect;
    }
  }

  // Slow path: if not found in package.json, check via package manager
  // This handles workspace-hoisted dependencies
  if (!thinkwellStatus.found) {
    const result = await checkViaPackageManager(pm, "thinkwell", projectDir);
    if (result) {
      thinkwellStatus = result;
    }
  }

  if (!typescriptStatus.found) {
    const result = await checkViaPackageManager(pm, "typescript", projectDir);
    if (result) {
      typescriptStatus = result;
    }
  }

  return {
    thinkwell: thinkwellStatus,
    typescript: typescriptStatus,
    packageManager: pm,
  };
}

/**
 * Check if a project has a package.json.
 * Used to determine if dependency checking should be performed at all.
 */
export function hasPackageJson(projectDir: string): boolean {
  return existsSync(join(projectDir, "package.json"));
}

/**
 * Find the nearest project root by walking up from `startDir`.
 *
 * A project root is a directory containing a `package.json`.
 * Returns the directory path, or undefined if none is found.
 */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
