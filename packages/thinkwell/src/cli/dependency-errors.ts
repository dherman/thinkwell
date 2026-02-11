/**
 * Error message templates for missing dependencies.
 *
 * When a project has a package.json but is missing required dependencies
 * (thinkwell, typescript), we fail fast with clear remediation guidance.
 *
 * @see doc/rfd/explicit-config.md for the design rationale
 */

import type { DependencyCheckResult } from "./dependency-check.js";

// ============================================================================
// Error Message Formatting
// ============================================================================

/**
 * Format an error message for missing dependencies.
 *
 * The message explains why explicit dependencies are required and provides
 * package-manager-specific commands for remediation.
 */
export function formatMissingDependencyError(
  result: DependencyCheckResult,
): string {
  const { thinkwell, typescript, packageManager } = result;
  const pm = packageManager;

  // Collect missing dependencies
  const missing: string[] = [];
  if (!thinkwell.found) missing.push("thinkwell");
  if (!typescript.found) missing.push("typescript");

  if (missing.length === 0) {
    return ""; // No error to format
  }

  // Build the error message
  const lines: string[] = [];

  // Primary error
  if (missing.length === 1) {
    lines.push(`Error: This project has a package.json but no dependency on '${missing[0]}'.`);
  } else {
    lines.push(`Error: This project has a package.json but is missing required dependencies.`);
  }

  lines.push("");

  // Explanation
  lines.push("When a project has explicit configuration, thinkwell expects explicit dependencies.");
  lines.push("This ensures you get the versions you expect, not versions bundled with the CLI.");

  lines.push("");

  // Remediation guidance
  lines.push("Run 'thinkwell init' to add the required dependencies, or add them manually:");

  // Generate package-manager-specific commands
  if (!thinkwell.found) {
    lines.push(`  ${pm.addCommand("thinkwell")}`);
  }
  if (!typescript.found) {
    lines.push(`  ${pm.addCommand("typescript", true)}`);
  }

  return lines.join("\n");
}

/**
 * Check if any required dependencies are missing.
 */
export function hasMissingDependencies(result: DependencyCheckResult): boolean {
  return !result.thinkwell.found || !result.typescript.found;
}
