/**
 * Caches TypeScript programs and schema generators for performance.
 *
 * Creating a ts-json-schema-generator for each file is expensive because
 * it parses the entire project. This module caches generators by project
 * (identified by tsconfig.json path) and reuses them across files.
 *
 * The key insight is that ts-json-schema-generator's createSchema() method
 * can generate schemas for any type visible to the program, not just types
 * in the original path. By creating a generator with a glob pattern that
 * covers all TypeScript files in the project, we can reuse it for all files.
 */

import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createGenerator, type Config, type SchemaGenerator } from "ts-json-schema-generator";
import { TypeScriptProgramError } from "./errors.js";

/**
 * Find tsconfig.json by walking up from the given directory.
 */
export function findTsConfig(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    const configPath = join(dir, "tsconfig.json");
    if (existsSync(configPath)) {
      return configPath;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

interface CachedGenerator {
  /** The schema generator instance */
  generator: SchemaGenerator;
  /** The tsconfig.json path */
  tsconfigPath: string;
  /** Modification time of the tsconfig when cached */
  tsconfigMtime: number;
  /** Creation time of this cache entry */
  createdAt: number;
}

/**
 * Cache for TypeScript schema generators.
 *
 * Generators are cached by tsconfig.json path. The cache is invalidated when:
 * - tsconfig.json is modified
 * - The cache entry exceeds max age
 *
 * Note: This cache does NOT track individual file changes. The schema
 * generator will see the file system state at creation time. For runtime
 * use (bun --preload), this is acceptable because the plugin also has
 * its own mtime-based cache. For watch mode, the program cache should
 * be invalidated when files change.
 */
export class ProgramCache {
  private cache = new Map<string, CachedGenerator>();
  private maxAgeMs: number;

  /**
   * Create a new program cache.
   *
   * @param maxAgeMs - Maximum age of cache entries in milliseconds (default: 5 minutes)
   */
  constructor(maxAgeMs: number = 5 * 60 * 1000) {
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Get or create a schema generator for the given file's project.
   *
   * If the file is in a project with a tsconfig.json, returns a cached
   * generator that covers all TypeScript files in the project. Otherwise,
   * creates a single-file generator (not cached).
   *
   * @param filePath - The TypeScript file path
   * @returns A schema generator that can generate schemas for types in this file
   */
  getGenerator(filePath: string): SchemaGenerator {
    const fileDir = dirname(filePath);
    const tsconfigPath = findTsConfig(fileDir);

    // Without a tsconfig, we can't effectively cache - create a single-file generator
    if (!tsconfigPath) {
      return this.createSingleFileGenerator(filePath);
    }

    // Check if we have a valid cached generator
    const cached = this.cache.get(tsconfigPath);
    if (cached && this.isValid(cached)) {
      return cached.generator;
    }

    // Create a new project-wide generator
    try {
      const generator = this.createProjectGenerator(tsconfigPath);
      const tsconfigMtime = this.getMtime(tsconfigPath)!;

      this.cache.set(tsconfigPath, {
        generator,
        tsconfigPath,
        tsconfigMtime,
        createdAt: Date.now(),
      });

      return generator;
    } catch (error) {
      // Fail fast with a clear error message
      throw new TypeScriptProgramError({
        tsconfigPath,
        filePath,
        cause: error,
      });
    }
  }

  /**
   * Invalidate the cache for a specific project.
   *
   * @param tsconfigPath - The tsconfig.json path to invalidate
   */
  invalidate(tsconfigPath: string): void {
    this.cache.delete(tsconfigPath);
  }

  /**
   * Invalidate cache for the project containing a file.
   *
   * @param filePath - A file path within the project
   */
  invalidateForFile(filePath: string): void {
    const fileDir = dirname(filePath);
    const tsconfigPath = findTsConfig(fileDir);
    if (tsconfigPath) {
      this.cache.delete(tsconfigPath);
    }
  }

  /**
   * Clear all cached generators.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached generators.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Check if a cached generator is still valid.
   */
  private isValid(cached: CachedGenerator): boolean {
    // Check max age
    if (Date.now() - cached.createdAt > this.maxAgeMs) {
      return false;
    }

    // Check if tsconfig changed
    const currentMtime = this.getMtime(cached.tsconfigPath);
    if (currentMtime !== cached.tsconfigMtime) {
      return false;
    }

    return true;
  }

  /**
   * Get the modification time of a file.
   */
  private getMtime(filePath: string): number | undefined {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /**
   * Create a schema generator for a single file (no tsconfig).
   */
  private createSingleFileGenerator(filePath: string): SchemaGenerator {
    const config: Config = {
      path: filePath,
      skipTypeCheck: true,
      encodeRefs: false,
    };

    return createGenerator(config);
  }

  /**
   * Create a schema generator for an entire project.
   *
   * Uses a glob pattern to include all TypeScript files in the project,
   * allowing the generator to resolve cross-file references.
   */
  private createProjectGenerator(tsconfigPath: string): SchemaGenerator {
    const projectDir = dirname(tsconfigPath);

    const config: Config = {
      // Use glob to include all TypeScript files
      path: join(projectDir, "**/*.ts"),
      tsconfig: tsconfigPath,
      skipTypeCheck: true,
      encodeRefs: false,
    };

    return createGenerator(config);
  }
}

/**
 * Global program cache instance.
 *
 * This is a singleton that persists across multiple file loads within
 * the same Bun process.
 */
export const programCache = new ProgramCache();
