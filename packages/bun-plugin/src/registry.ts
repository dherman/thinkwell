/**
 * Module registry for virtual module resolution in compiled binaries.
 *
 * When thinkwell is distributed as a compiled binary (via Homebrew or direct
 * download), there's no node_modules directory. The CLI registers bundled
 * module exports here, and the plugin returns them as virtual modules.
 *
 * For npm distribution, no modules are registered and the plugin falls back
 * to external resolution.
 */

/** Registry of module name → exports */
const moduleRegistry = new Map<string, Record<string, unknown>>();

/**
 * Register module exports for virtual resolution.
 * Called by the CLI before running user scripts.
 *
 * @param name - The npm package name (e.g., "thinkwell", "@thinkwell/acp")
 * @param exports - The module's exports object
 */
export function registerModule(name: string, exports: Record<string, unknown>): void {
  moduleRegistry.set(name, exports);
}

/**
 * Get registered module exports.
 *
 * @param name - The npm package name
 * @returns The module's exports, or undefined if not registered
 */
export function getRegisteredModule(name: string): Record<string, unknown> | undefined {
  return moduleRegistry.get(name);
}

/**
 * Check if virtual module mode is enabled.
 * Returns true when modules have been registered (binary distribution).
 */
export function isVirtualModeEnabled(): boolean {
  return moduleRegistry.size > 0;
}

/**
 * Clear all registered modules.
 * Primarily useful for testing.
 */
export function clearRegistry(): void {
  moduleRegistry.clear();
}
