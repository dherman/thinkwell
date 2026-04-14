/**
 * Computes the OS-appropriate cache directory for the thinkwell VSCode plugin.
 *
 * Augmentation files are written here instead of in the user's project tree,
 * keeping the project directory clean and avoiding accidental commits.
 */

import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import path from "node:path";

/**
 * Get the OS-appropriate base cache directory.
 *
 * - macOS:   ~/Library/Caches
 * - Linux:   $XDG_CACHE_HOME or ~/.cache
 * - Windows: %LOCALAPPDATA% or ~/AppData/Local
 */
function osCacheDir(): string {
  switch (platform()) {
    case "darwin":
      return path.join(homedir(), "Library", "Caches");
    case "win32":
      return process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
    default:
      // Linux / FreeBSD / etc — follow XDG Base Directory spec
      return process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
  }
}

/**
 * Compute a short, stable hash of the project directory path.
 *
 * This gives each project its own subdirectory in the cache without
 * leaking the full project path into the directory name.
 */
function projectHash(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 12);
}

/**
 * Get the cache directory for a specific project's augmentation files.
 *
 * Returns a path like:
 * - macOS:   ~/Library/Caches/thinkwell-plugin/<hash>/
 * - Linux:   ~/.cache/thinkwell-plugin/<hash>/
 * - Windows: %LOCALAPPDATA%/thinkwell-plugin/<hash>/
 */
export function getAugmentationsCacheDir(projectDir: string): string {
  return path.join(osCacheDir(), "thinkwell-plugin", projectHash(projectDir));
}
