/**
 * File watcher for regenerating declaration files on changes.
 *
 * This module provides a watcher that monitors TypeScript files for changes
 * and automatically regenerates the corresponding `.thinkwell.d.ts` files
 * when `@JSONSchema` marked types are added, modified, or removed.
 */

import { watch, type FSWatcher } from "fs";
import { resolve, relative, dirname } from "path";
import { Glob } from "bun";
import { findMarkedTypes } from "./transform.js";
import {
  writeDeclarationFile,
  removeDeclarationFile,
  getDeclarationPath,
} from "./declarations.js";
import { DeclarationGenerationError } from "./errors.js";

/**
 * Options for the declaration watcher.
 */
export interface WatcherOptions {
  /**
   * Root directory to watch for TypeScript files.
   * Defaults to the current working directory.
   */
  rootDir?: string;

  /**
   * Glob patterns to include. Defaults to ["**\/*.ts", "**\/*.tsx"].
   */
  include?: string[];

  /**
   * Glob patterns to exclude. Defaults to ["node_modules/**", "**\/*.d.ts"].
   */
  exclude?: string[];

  /**
   * Callback when a declaration file is written.
   */
  onWrite?: (sourceFile: string, declFile: string) => void;

  /**
   * Callback when a declaration file is removed.
   */
  onRemove?: (sourceFile: string, declFile: string) => void;

  /**
   * Callback when an error occurs.
   */
  onError?: (error: Error, sourceFile: string) => void;

  /**
   * Debounce delay in milliseconds. Defaults to 100ms.
   */
  debounceMs?: number;
}

/**
 * A file watcher that regenerates declaration files on changes.
 */
export class DeclarationWatcher {
  private rootDir: string;
  private onWrite?: (sourceFile: string, declFile: string) => void;
  private onRemove?: (sourceFile: string, declFile: string) => void;
  private onError?: (error: Error, sourceFile: string) => void;
  private debounceMs: number;

  // Pre-compiled glob patterns for performance
  private includeGlobs: Glob[];
  private excludeGlobs: Glob[];

  private watcher: FSWatcher | null = null;
  private pendingUpdates = new Map<string, NodeJS.Timeout>();

  constructor(options: WatcherOptions = {}) {
    this.rootDir = options.rootDir ?? process.cwd();
    const include = options.include ?? ["**/*.ts", "**/*.tsx"];
    const exclude = options.exclude ?? [
      "node_modules/**",
      "**/*.d.ts",
      "**/*.thinkwell.d.ts",
    ];
    // Pre-compile glob patterns once for better performance
    this.includeGlobs = include.map((pattern) => new Glob(pattern));
    this.excludeGlobs = exclude.map((pattern) => new Glob(pattern));
    this.onWrite = options.onWrite;
    this.onRemove = options.onRemove;
    this.onError = options.onError;
    this.debounceMs = options.debounceMs ?? 100;
  }

  /**
   * Check if a file path matches the include/exclude patterns.
   */
  private shouldProcess(filePath: string): boolean {
    const relativePath = relative(this.rootDir, filePath);

    // Check if matches any include pattern (using pre-compiled globs)
    const matchesInclude = this.includeGlobs.some((glob) =>
      glob.match(relativePath)
    );

    if (!matchesInclude) {
      return false;
    }

    // Check if matches any exclude pattern (using pre-compiled globs)
    const matchesExclude = this.excludeGlobs.some((glob) =>
      glob.match(relativePath)
    );

    return !matchesExclude;
  }

  /**
   * Process a file change event.
   */
  private async processFile(filePath: string): Promise<void> {
    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();

      if (!exists) {
        // File was deleted - remove declaration file if it exists
        const removed = await removeDeclarationFile(filePath);
        if (removed) {
          this.onRemove?.(filePath, getDeclarationPath(filePath));
        }
        return;
      }

      const source = await file.text();

      // Fast path: skip files without @JSONSchema
      if (!source.includes("@JSONSchema")) {
        // File no longer has @JSONSchema - remove declaration if it exists
        const removed = await removeDeclarationFile(filePath);
        if (removed) {
          this.onRemove?.(filePath, getDeclarationPath(filePath));
        }
        return;
      }

      const types = findMarkedTypes(filePath, source);

      if (types.length === 0) {
        // No marked types found - remove declaration if it exists
        const removed = await removeDeclarationFile(filePath);
        if (removed) {
          this.onRemove?.(filePath, getDeclarationPath(filePath));
        }
        return;
      }

      // Generate declaration file
      const declPath = await writeDeclarationFile(filePath, types);
      if (declPath) {
        this.onWrite?.(filePath, declPath);
      }
    } catch (error) {
      const err = new DeclarationGenerationError({ sourceFile: filePath, cause: error });
      this.onError?.(err, filePath);
    }
  }

  /**
   * Handle a file system event with debouncing.
   */
  private handleEvent(eventType: string, filename: string | null): void {
    if (!filename) {
      return;
    }

    const filePath = resolve(this.rootDir, filename);

    if (!this.shouldProcess(filePath)) {
      return;
    }

    // Clear any pending update for this file
    const pending = this.pendingUpdates.get(filePath);
    if (pending) {
      clearTimeout(pending);
    }

    // Schedule the update with debouncing
    const timeout = setTimeout(() => {
      this.pendingUpdates.delete(filePath);
      this.processFile(filePath);
    }, this.debounceMs);

    this.pendingUpdates.set(filePath, timeout);
  }

  /**
   * Start watching for file changes.
   */
  start(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(
      this.rootDir,
      { recursive: true },
      (eventType, filename) => {
        this.handleEvent(eventType, filename);
      }
    );
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear any pending updates
    for (const timeout of this.pendingUpdates.values()) {
      clearTimeout(timeout);
    }
    this.pendingUpdates.clear();
  }

  /**
   * Check if the watcher is running.
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }
}

/**
 * Create and start a declaration watcher.
 *
 * @param options - Watcher options
 * @returns The watcher instance
 */
export function watchDeclarations(options: WatcherOptions = {}): DeclarationWatcher {
  const watcher = new DeclarationWatcher(options);
  watcher.start();
  return watcher;
}
