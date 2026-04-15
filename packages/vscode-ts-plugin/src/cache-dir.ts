/**
 * Computes the cache directory for the thinkwell VSCode plugin's
 * generated augmentation files.
 *
 * Uses `node_modules/.cache/thinkwell/` inside the project directory.
 * This location is:
 * - Already gitignored (under node_modules/)
 * - A well-known convention (Babel, webpack, eslint use it)
 * - Close enough to node_modules/thinkwell that `import("thinkwell")`
 *   in the augmentations file resolves naturally via Node's
 *   parent-directory walk
 * - Invisible to users browsing their source tree
 */

import path from "node:path";

/**
 * Get the cache directory for a project's augmentation files.
 *
 * Returns `<projectDir>/node_modules/.cache/thinkwell/`.
 */
export function getAugmentationsCacheDir(projectDir: string): string {
  return path.join(projectDir, "node_modules", ".cache", "thinkwell");
}
