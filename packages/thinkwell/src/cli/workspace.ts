/**
 * Workspace detection for `thinkwell check`.
 *
 * Detects pnpm workspaces (pnpm-workspace.yaml) and npm workspaces
 * (package.json "workspaces"), enumerates member packages, and resolves
 * package names with short-name fallback for scoped packages.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";

// ============================================================================
// Types
// ============================================================================

/** A workspace member package with its metadata. */
export interface WorkspaceMember {
  /** Full package name from package.json (e.g., "@thinkwell/acp") */
  name: string;
  /** Absolute path to the package directory */
  dir: string;
  /** Whether the package has a tsconfig.json */
  hasTsConfig: boolean;
}

/** A detected workspace with its members. */
export interface Workspace {
  /** Absolute path to the workspace root */
  rootDir: string;
  /** Workspace type that was detected */
  type: "pnpm" | "npm";
  /** All workspace member packages */
  members: WorkspaceMember[];
}

// ============================================================================
// pnpm-workspace.yaml parsing
// ============================================================================

/**
 * Parse the `packages` array from a pnpm-workspace.yaml file.
 *
 * Handles the simple list format used by pnpm:
 * ```yaml
 * packages:
 *   - "packages/*"
 *   - "examples"
 * ```
 *
 * This is intentionally minimal — it only extracts the `packages` array
 * entries without pulling in a full YAML parser dependency.
 */
export function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split("\n");

  let inPackages = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect the start of the packages block
    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      continue;
    }

    // A non-indented, non-empty line that isn't a list item ends the block
    if (inPackages && trimmed.length > 0 && !trimmed.startsWith("-") && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }

    if (inPackages && trimmed.startsWith("-")) {
      // Strip leading "- ", then strip optional quotes
      const value = trimmed.slice(1).trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) {
        patterns.push(value);
      }
    }
  }

  return patterns;
}

// ============================================================================
// Glob expansion
// ============================================================================

/**
 * Expand workspace glob patterns into concrete directory paths.
 *
 * Supports the common patterns used by pnpm and npm workspaces:
 * - `packages/*` — all immediate subdirectories of `packages/`
 * - `examples` — a single directory
 * - `apps/**` — recursively find directories (not commonly used but supported)
 *
 * Only returns directories that actually exist.
 */
export function expandWorkspaceGlobs(rootDir: string, patterns: string[]): string[] {
  const dirs: string[] = [];

  for (const pattern of patterns) {
    // Skip negation patterns (pnpm supports "!packages/internal")
    if (pattern.startsWith("!")) continue;

    if (pattern.includes("*")) {
      // Split at the first glob segment
      const parts = pattern.split("/");
      const globIndex = parts.findIndex((p) => p.includes("*"));
      const prefix = parts.slice(0, globIndex).join("/");
      const globPart = parts[globIndex];
      const suffix = parts.slice(globIndex + 1).join("/");

      const baseDir = resolve(rootDir, prefix);
      if (!existsSync(baseDir)) continue;

      if (globPart === "*") {
        // Single-level wildcard: list immediate subdirectories
        const entries = readdirSync(baseDir);
        for (const entry of entries) {
          const fullPath = suffix
            ? resolve(baseDir, entry, suffix)
            : resolve(baseDir, entry);
          if (existsSync(fullPath) && isDirectory(fullPath)) {
            dirs.push(fullPath);
          }
        }
      } else if (globPart === "**") {
        // Recursive wildcard: find all directories recursively
        collectDirectories(baseDir, suffix, dirs);
      }
    } else {
      // Literal path
      const fullPath = resolve(rootDir, pattern);
      if (existsSync(fullPath) && isDirectory(fullPath)) {
        dirs.push(fullPath);
      }
    }
  }

  return dirs;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectDirectories(baseDir: string, suffix: string, result: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const fullPath = resolve(baseDir, entry);
    if (!isDirectory(fullPath)) continue;

    const candidate = suffix ? resolve(fullPath, suffix) : fullPath;
    if (existsSync(candidate) && isDirectory(candidate)) {
      result.push(candidate);
    }

    // Recurse
    collectDirectories(fullPath, suffix, result);
  }
}

// ============================================================================
// Package metadata
// ============================================================================

/**
 * Read workspace member metadata from a package directory.
 * Returns undefined if the directory has no package.json or no "name" field.
 */
function readMember(dir: string): WorkspaceMember | undefined {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return undefined;

  try {
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    if (!pkg.name || typeof pkg.name !== "string") return undefined;

    return {
      name: pkg.name,
      dir,
      hasTsConfig: existsSync(join(dir, "tsconfig.json")),
    };
  } catch {
    return undefined;
  }
}

// ============================================================================
// Workspace detection
// ============================================================================

/**
 * Detect a workspace in the given directory.
 *
 * Detection priority: pnpm-workspace.yaml takes precedence over
 * package.json "workspaces" (pnpm ignores the npm workspaces field).
 *
 * Returns undefined if no workspace is detected (single-package project).
 */
export function detectWorkspace(rootDir: string): Workspace | undefined {
  const absRoot = resolve(rootDir);

  // Try pnpm workspace first
  const pnpmPath = join(absRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    const content = readFileSync(pnpmPath, "utf-8");
    const patterns = parsePnpmWorkspaceYaml(content);
    if (patterns.length > 0) {
      const dirs = expandWorkspaceGlobs(absRoot, patterns);
      const members = dirs
        .map(readMember)
        .filter((m): m is WorkspaceMember => m !== undefined);
      return { rootDir: absRoot, type: "pnpm", members };
    }
  }

  // Try npm workspaces
  const pkgPath = join(absRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const content = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      if (Array.isArray(pkg.workspaces)) {
        const patterns = pkg.workspaces.filter(
          (p: unknown): p is string => typeof p === "string",
        );
        if (patterns.length > 0) {
          const dirs = expandWorkspaceGlobs(absRoot, patterns);
          const members = dirs
            .map(readMember)
            .filter((m): m is WorkspaceMember => m !== undefined);
          return { rootDir: absRoot, type: "npm", members };
        }
      }
    } catch {
      // Invalid package.json — treat as no workspace
    }
  }

  return undefined;
}

// ============================================================================
// Package name resolution
// ============================================================================

/** Result of resolving a package name. */
export type ResolveResult =
  | { kind: "found"; member: WorkspaceMember }
  | { kind: "ambiguous"; name: string; matches: WorkspaceMember[] }
  | { kind: "not-found"; name: string; available: string[] };

/**
 * Resolve a package name (full or short) against workspace members.
 *
 * Resolution order:
 * 1. Exact match on full package name (e.g., "@thinkwell/acp")
 * 2. Short-name fallback: match last segment of scoped names (e.g., "acp" → "@thinkwell/acp")
 * 3. Ambiguity detection if short name matches multiple packages
 */
export function resolvePackageName(
  name: string,
  members: readonly WorkspaceMember[],
): ResolveResult {
  // 1. Exact match
  const exact = members.find((m) => m.name === name);
  if (exact) {
    return { kind: "found", member: exact };
  }

  // 2. Short-name fallback: match against the last segment of scoped names
  //    e.g., "acp" matches "@thinkwell/acp", "@other/acp"
  //    Also matches unscoped names exactly (e.g., "thinkwell" matches "thinkwell")
  const shortMatches = members.filter((m) => {
    const lastSegment = m.name.includes("/")
      ? m.name.split("/").pop()
      : m.name;
    return lastSegment === name;
  });

  if (shortMatches.length === 1) {
    return { kind: "found", member: shortMatches[0] };
  }

  if (shortMatches.length > 1) {
    return { kind: "ambiguous", name, matches: shortMatches };
  }

  // 3. Not found
  return {
    kind: "not-found",
    name,
    available: members.map((m) => m.name),
  };
}
