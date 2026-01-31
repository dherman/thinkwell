/**
 * Caching layer for generated schemas.
 *
 * Uses mtime-based invalidation to avoid regenerating schemas
 * for unchanged files.
 */

import type { TypeInfo } from "./transform.js";

interface CacheEntry {
  /** File modification time in milliseconds */
  mtime: number;
  /** The types found in the file */
  types: TypeInfo[];
  /** Generated schemas for each type */
  schemas: Map<string, object>;
}

/**
 * In-memory cache for generated schemas.
 *
 * The cache is keyed by file path and invalidated when the file's
 * modification time changes.
 */
export class SchemaCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Get cached schemas for a file if they exist and are still valid.
   *
   * @param path - The file path
   * @param currentMtime - The current file modification time in milliseconds
   * @returns The cached entry if valid, or undefined if cache miss
   */
  get(
    path: string,
    currentMtime: number
  ): { types: TypeInfo[]; schemas: Map<string, object> } | undefined {
    const entry = this.cache.get(path);
    if (entry && entry.mtime === currentMtime) {
      return { types: entry.types, schemas: entry.schemas };
    }
    return undefined;
  }

  /**
   * Store schemas in the cache.
   *
   * @param path - The file path
   * @param mtime - The file modification time in milliseconds
   * @param types - The types found in the file
   * @param schemas - The generated schemas
   */
  set(
    path: string,
    mtime: number,
    types: TypeInfo[],
    schemas: Map<string, object>
  ): void {
    this.cache.set(path, { mtime, types, schemas });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}
