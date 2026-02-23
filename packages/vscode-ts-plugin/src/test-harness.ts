/**
 * Test harness for integration-testing the TypeScript Language Service plugin.
 *
 * Creates a LanguageServiceHost backed by a real temp directory on disk,
 * applies the plugin via init({ typescript: ts }).create(), and provides
 * helpers for asserting on completions, diagnostics, and hover info.
 */

import ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import init from "./index";

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  declaration: true,
};

/**
 * Stub thinkwell module so `import ... from "thinkwell"` resolves
 * in test source files.
 */
function thinkwellStubFiles(): Record<string, string> {
  return {
    "node_modules/thinkwell/package.json":
      JSON.stringify({ name: "thinkwell", types: "./index.d.ts" }),
    "node_modules/thinkwell/index.d.ts": [
      "export interface SchemaProvider<T> {",
      "  toJsonSchema(): object;",
      "}",
      "export declare function think<Output>(schema: SchemaProvider<Output>): Promise<Output>;",
    ].join("\n"),
  };
}

export interface TestProject {
  /** The proxied LanguageService with the plugin applied. */
  ls: ts.LanguageService;
  /** The project root directory (real temp dir on disk). */
  projectDir: string;
  /** Update a file's content and bump its version. */
  updateFile(relativePath: string, content: string): void;
  /** Add a new file to the project. */
  addFile(relativePath: string, content: string): void;
  /** Remove a file from the project. */
  removeFile(relativePath: string): void;
  /** Get completions at the character position right after `searchText` in the file. */
  getCompletionsAt(relativePath: string, searchText: string): ts.CompletionInfo | undefined;
  /** Get semantic diagnostics for a file. */
  getDiagnostics(relativePath: string): ts.Diagnostic[];
  /** Get quick info (hover) at the first character of `searchText`. */
  getHoverAt(relativePath: string, searchText: string): ts.QuickInfo | undefined;
  /** Find the character offset where `searchText` starts in a file. */
  findPosition(relativePath: string, searchText: string): number;
  /** Wait for the deferred initial scan (setTimeout 100ms) to complete. */
  waitForInitialScan(): Promise<void>;
  /** Clean up the temp directory. */
  cleanup(): void;
  /** Collected log messages from the plugin. */
  logs: string[];
}

/**
 * Create a test project with real files on disk in a temp directory,
 * a real TypeScript LanguageService, and the thinkwell plugin applied.
 */
export function createTestProject(
  files: Record<string, string>,
): TestProject {
  // Create a real temp directory
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "thinkwell-test-"));
  const logs: string[] = [];

  // Version tracking for the host
  const versionMap = new Map<string, number>();

  // Write stub files + user files to disk
  const allFiles = { ...thinkwellStubFiles(), ...files };
  for (const [relativePath, content] of Object.entries(allFiles)) {
    const absPath = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
    versionMap.set(absPath, 1);
  }

  /** Resolve a relative path to absolute. */
  function abs(relativePath: string): string {
    return relativePath.startsWith("/")
      ? relativePath
      : path.join(projectDir, relativePath);
  }

  const augmentationsPath = path.join(projectDir, ".thinkwell", "augmentations.d.ts");

  /** Get all tracked file names, plus the augmentations file if it exists on disk. */
  function getFileNames(): string[] {
    const names = [...versionMap.keys()];
    if (fs.existsSync(augmentationsPath) && !names.includes(augmentationsPath)) {
      names.push(augmentationsPath);
    }
    return names;
  }

  // Build the LanguageServiceHost backed by the real filesystem
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => COMPILER_OPTIONS,
    getScriptFileNames: () => getFileNames(),
    getScriptVersion: (fileName) => {
      const v = versionMap.get(fileName);
      if (v !== undefined) return String(v);
      // For files written by the plugin (augmentations), use mtime
      try {
        return String(fs.statSync(fileName).mtimeMs);
      } catch {
        return "0";
      }
    },
    getScriptSnapshot: (fileName) => {
      try {
        const content = fs.readFileSync(fileName, "utf-8");
        return ts.ScriptSnapshot.fromString(content);
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => projectDir,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    readFile: (filePath) => {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return undefined;
      }
    },
    fileExists: (filePath) => fs.existsSync(filePath),
    directoryExists: (dirPath) => {
      try {
        return fs.statSync(dirPath).isDirectory();
      } catch {
        return false;
      }
    },
    getDirectories: (dirPath) => {
      try {
        return fs.readdirSync(dirPath, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
      } catch {
        return [];
      }
    },
    realpath: (filePath) => filePath,
    resolveModuleNameLiterals: (
      moduleLiterals,
      containingFile,
      redirectedReference,
      options,
    ) => {
      return moduleLiterals.map((literal) => {
        return ts.resolveModuleName(
          literal.text,
          containingFile,
          options,
          ts.sys,
        );
      });
    },
  };

  // Create the raw LanguageService
  const rawLs = ts.createLanguageService(host);

  // Build mock PluginCreateInfo
  const mockProject = {
    getCurrentDirectory: () => projectDir,
    log: (msg: string) => logs.push(msg),
    refreshDiagnostics: () => {},
  } as unknown as ts.server.Project;

  const pluginCreateInfo: ts.server.PluginCreateInfo = {
    project: mockProject,
    languageService: rawLs,
    languageServiceHost: host,
    serverHost: {} as ts.server.ServerHost,
    config: {},
  };

  // Apply the plugin
  const pluginModule = init({ typescript: ts });
  const proxiedLs = pluginModule.create(pluginCreateInfo);

  // Helper functions
  function findPosition(relativePath: string, searchText: string): number {
    const absPath = abs(relativePath);
    const content = fs.readFileSync(absPath, "utf-8");
    const idx = content.indexOf(searchText);
    if (idx === -1) throw new Error(`Text "${searchText}" not found in ${relativePath}`);
    return idx;
  }

  function updateFile(relativePath: string, content: string): void {
    const absPath = abs(relativePath);
    fs.writeFileSync(absPath, content, "utf-8");
    versionMap.set(absPath, (versionMap.get(absPath) ?? 0) + 1);
  }

  function addFile(relativePath: string, content: string): void {
    const absPath = abs(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
    versionMap.set(absPath, 1);
  }

  function removeFile(relativePath: string): void {
    const absPath = abs(relativePath);
    try { fs.unlinkSync(absPath); } catch {}
    versionMap.delete(absPath);
  }

  function getCompletionsAt(
    relativePath: string,
    searchText: string,
  ): ts.CompletionInfo | undefined {
    const absPath = abs(relativePath);
    const pos = findPosition(relativePath, searchText) + searchText.length;
    return proxiedLs.getCompletionsAtPosition(absPath, pos, undefined);
  }

  function getDiagnostics(relativePath: string): ts.Diagnostic[] {
    return proxiedLs.getSemanticDiagnostics(abs(relativePath));
  }

  function getHoverAt(
    relativePath: string,
    searchText: string,
  ): ts.QuickInfo | undefined {
    const absPath = abs(relativePath);
    const pos = findPosition(relativePath, searchText);
    return proxiedLs.getQuickInfoAtPosition(absPath, pos);
  }

  async function waitForInitialScan(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  function cleanup(): void {
    rawLs.dispose();
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  }

  return {
    ls: proxiedLs,
    projectDir,
    updateFile,
    addFile,
    removeFile,
    getCompletionsAt,
    getDiagnostics,
    getHoverAt,
    findPosition,
    waitForInitialScan,
    cleanup,
    logs,
  };
}
