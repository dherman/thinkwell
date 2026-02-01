import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProgramCache, findTsConfig } from "./program-cache.js";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";

describe("ProgramCache", () => {
  let tempDir: string;
  let cache: ProgramCache;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "program-cache-test-"));
    cache = new ProgramCache();

    // Create a tsconfig.json
    writeFileSync(
      join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
        },
        include: ["*.ts"],
      })
    );
  });

  test("returns a generator for a file", () => {
    const testFile = join(tempDir, "test.ts");
    writeFileSync(
      testFile,
      `
export interface Test {
  value: string;
}
`
    );

    const generator = cache.getGenerator(testFile);
    expect(generator).toBeDefined();
    expect(cache.size).toBe(1);
  });

  test("reuses cached generator for same project", () => {
    const file1 = join(tempDir, "file1.ts");
    const file2 = join(tempDir, "file2.ts");

    writeFileSync(file1, `export interface Type1 { a: string; }`);
    writeFileSync(file2, `export interface Type2 { b: string; }`);

    const gen1 = cache.getGenerator(file1);
    const gen2 = cache.getGenerator(file2);

    // Should be the same cached generator
    expect(gen1).toBe(gen2);
    expect(cache.size).toBe(1);
  });

  test("creates separate generators for different projects", () => {
    // Create a second project
    const tempDir2 = mkdtempSync(join(tmpdir(), "program-cache-test-"));
    writeFileSync(
      join(tempDir2, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022" },
        include: ["*.ts"],
      })
    );

    const file1 = join(tempDir, "test.ts");
    const file2 = join(tempDir2, "test.ts");

    writeFileSync(file1, `export interface Type1 { a: string; }`);
    writeFileSync(file2, `export interface Type2 { b: string; }`);

    const gen1 = cache.getGenerator(file1);
    const gen2 = cache.getGenerator(file2);

    // Should be different generators
    expect(gen1).not.toBe(gen2);
    expect(cache.size).toBe(2);

    rmSync(tempDir2, { recursive: true, force: true });
  });

  test("invalidates cache when tsconfig changes", async () => {
    const testFile = join(tempDir, "test.ts");
    writeFileSync(testFile, `export interface Test { value: string; }`);

    const gen1 = cache.getGenerator(testFile);
    expect(cache.size).toBe(1);

    // Wait a bit and modify tsconfig
    await Bun.sleep(10);
    writeFileSync(
      join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2020" }, // Changed
        include: ["*.ts"],
      })
    );

    const gen2 = cache.getGenerator(testFile);

    // Should be a new generator
    expect(gen1).not.toBe(gen2);
    expect(cache.size).toBe(1);
  });

  test("invalidateForFile clears project cache", () => {
    const testFile = join(tempDir, "test.ts");
    writeFileSync(testFile, `export interface Test { value: string; }`);

    cache.getGenerator(testFile);
    expect(cache.size).toBe(1);

    cache.invalidateForFile(testFile);
    expect(cache.size).toBe(0);
  });

  test("clear removes all cached generators", () => {
    const tempDir2 = mkdtempSync(join(tmpdir(), "program-cache-test-"));
    writeFileSync(
      join(tempDir2, "tsconfig.json"),
      JSON.stringify({ compilerOptions: {} })
    );

    const file1 = join(tempDir, "test.ts");
    const file2 = join(tempDir2, "test.ts");

    writeFileSync(file1, `export interface Type1 { a: string; }`);
    writeFileSync(file2, `export interface Type2 { b: string; }`);

    cache.getGenerator(file1);
    cache.getGenerator(file2);
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);

    rmSync(tempDir2, { recursive: true, force: true });
  });

  test("respects max age", async () => {
    // Create cache with very short max age
    const shortCache = new ProgramCache(50); // 50ms

    const testFile = join(tempDir, "test.ts");
    writeFileSync(testFile, `export interface Test { value: string; }`);

    const gen1 = shortCache.getGenerator(testFile);

    // Wait for cache to expire
    await Bun.sleep(100);

    const gen2 = shortCache.getGenerator(testFile);

    // Should be a new generator due to expiry
    expect(gen1).not.toBe(gen2);
  });

  // Cleanup
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("findTsConfig", () => {
  test("finds tsconfig.json in current directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tsconfig-test-"));
    const tsconfigPath = join(tempDir, "tsconfig.json");
    writeFileSync(tsconfigPath, "{}");

    const found = findTsConfig(tempDir);
    expect(found).toBe(tsconfigPath);

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("finds tsconfig.json in parent directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tsconfig-test-"));
    const subDir = join(tempDir, "src", "components");
    const tsconfigPath = join(tempDir, "tsconfig.json");

    writeFileSync(tsconfigPath, "{}");
    // Create subdirectory
    Bun.spawnSync(["mkdir", "-p", subDir]);

    const found = findTsConfig(subDir);
    expect(found).toBe(tsconfigPath);

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns undefined when no tsconfig.json found", () => {
    // Use a path that definitely doesn't have tsconfig
    const found = findTsConfig("/tmp");
    expect(found).toBeUndefined();
  });
});
