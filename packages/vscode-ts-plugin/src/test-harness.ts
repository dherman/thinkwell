/**
 * Test harness for integration-testing the TypeScript Language Service plugin.
 *
 * Creates an in-memory LanguageServiceHost, applies the plugin via
 * init({ typescript: ts }).create(), and provides helpers for asserting
 * on completions, diagnostics, and hover info.
 */

import ts from "typescript";
import path from "node:path";
import init from "./index";

const DEFAULT_PROJECT_DIR = "/test-project";

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
 * Stub thinkwell module files to include in every test project so that
 * the virtual declarations' `import("thinkwell").SchemaProvider<T>` resolves.
 */
function thinkwellStubFiles(projectDir: string): Record<string, string> {
  return {
    [path.join(projectDir, "node_modules/thinkwell/package.json")]:
      JSON.stringify({ name: "thinkwell", types: "./index.d.ts" }),
    [path.join(projectDir, "node_modules/thinkwell/index.d.ts")]: [
      "export interface SchemaProvider<T> {",
      "  toJsonSchema(): object;",
      "}",
    ].join("\n"),
  };
}

export interface TestProject {
  /** The proxied LanguageService with the plugin applied. */
  ls: ts.LanguageService;
  /** The project root directory. */
  projectDir: string;
  /** Update a file's content and bump its version. */
  updateFile(filePath: string, content: string): void;
  /** Add a new file to the project. */
  addFile(filePath: string, content: string): void;
  /** Remove a file from the project. */
  removeFile(filePath: string): void;
  /** Get completions at the character position right after `searchText` in the file. */
  getCompletionsAt(filePath: string, searchText: string): ts.CompletionInfo | undefined;
  /** Get semantic diagnostics for a file. */
  getDiagnostics(filePath: string): ts.Diagnostic[];
  /** Get quick info (hover) at the first character of `searchText`. */
  getHoverAt(filePath: string, searchText: string): ts.QuickInfo | undefined;
  /** Find the character offset where `searchText` starts in a file. */
  findPosition(filePath: string, searchText: string): number;
  /** Wait for the deferred initial scan (setTimeout 100ms) to complete. */
  waitForInitialScan(): Promise<void>;
  /** Collected log messages from the plugin. */
  logs: string[];
}

export interface CreateTestProjectOptions {
  projectDir?: string;
}

/**
 * Create a test project with an in-memory file system, a real TypeScript
 * LanguageService, and the thinkwell plugin applied.
 */
export function createTestProject(
  files: Record<string, string>,
  options?: CreateTestProjectOptions,
): TestProject {
  const projectDir = options?.projectDir ?? DEFAULT_PROJECT_DIR;
  const logs: string[] = [];

  // Merge user files with thinkwell stubs
  const fileMap = new Map<string, string>();
  const versionMap = new Map<string, number>();

  for (const [relativePath, content] of Object.entries(thinkwellStubFiles(projectDir))) {
    fileMap.set(relativePath, content);
    versionMap.set(relativePath, 1);
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = relativePath.startsWith("/")
      ? relativePath
      : path.join(projectDir, relativePath);
    fileMap.set(absPath, content);
    versionMap.set(absPath, 1);
  }

  // Build the LanguageServiceHost
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => COMPILER_OPTIONS,
    getScriptFileNames: () => [...fileMap.keys()],
    getScriptVersion: (fileName) => String(versionMap.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      const content = fileMap.get(fileName);
      if (content !== undefined) {
        return ts.ScriptSnapshot.fromString(content);
      }
      // Fall through to real filesystem for TypeScript lib files
      if (ts.sys.fileExists(fileName)) {
        const text = ts.sys.readFile(fileName);
        if (text !== undefined) {
          return ts.ScriptSnapshot.fromString(text);
        }
      }
      return undefined;
    },
    getCurrentDirectory: () => projectDir,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    readFile: (filePath) => {
      const content = fileMap.get(filePath);
      if (content !== undefined) return content;
      return ts.sys.readFile(filePath);
    },
    fileExists: (filePath) => {
      if (fileMap.has(filePath)) return true;
      return ts.sys.fileExists(filePath);
    },
    directoryExists: (dirPath) => {
      // Check if any in-memory file is under this directory
      for (const key of fileMap.keys()) {
        if (key.startsWith(dirPath + "/")) return true;
      }
      return ts.sys.directoryExists(dirPath);
    },
    getDirectories: (dirPath) => {
      const dirs = new Set<string>();
      for (const key of fileMap.keys()) {
        if (key.startsWith(dirPath + "/")) {
          const relative = key.slice(dirPath.length + 1);
          const firstSegment = relative.split("/")[0];
          dirs.add(firstSegment);
        }
      }
      return [...dirs];
    },
    realpath: (filePath) => filePath,
    resolveModuleNameLiterals: (
      moduleLiterals,
      containingFile,
      redirectedReference,
      options,
    ) => {
      return moduleLiterals.map((literal) => {
        const result = ts.resolveModuleName(
          literal.text,
          containingFile,
          options,
          {
            fileExists: (f) => fileMap.has(f) || ts.sys.fileExists(f),
            readFile: (f) => fileMap.get(f) ?? ts.sys.readFile(f),
            directoryExists: (d) => {
              for (const k of fileMap.keys()) {
                if (k.startsWith(d + "/")) return true;
              }
              return ts.sys.directoryExists(d);
            },
          },
        );
        return result;
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
  function findPosition(filePath: string, searchText: string): number {
    const content = fileMap.get(filePath);
    if (!content) throw new Error(`File not found: ${filePath}`);
    const idx = content.indexOf(searchText);
    if (idx === -1) throw new Error(`Text "${searchText}" not found in ${filePath}`);
    return idx;
  }

  function updateFile(filePath: string, content: string): void {
    if (!fileMap.has(filePath)) throw new Error(`File not found: ${filePath}`);
    fileMap.set(filePath, content);
    versionMap.set(filePath, (versionMap.get(filePath) ?? 0) + 1);
  }

  function addFile(filePath: string, content: string): void {
    const absPath = filePath.startsWith("/")
      ? filePath
      : path.join(projectDir, filePath);
    fileMap.set(absPath, content);
    versionMap.set(absPath, 1);
  }

  function removeFile(filePath: string): void {
    fileMap.delete(filePath);
    versionMap.delete(filePath);
  }

  function getCompletionsAt(
    filePath: string,
    searchText: string,
  ): ts.CompletionInfo | undefined {
    const pos = findPosition(filePath, searchText) + searchText.length;
    return proxiedLs.getCompletionsAtPosition(filePath, pos, undefined);
  }

  function getDiagnostics(filePath: string): ts.Diagnostic[] {
    return proxiedLs.getSemanticDiagnostics(filePath);
  }

  function getHoverAt(
    filePath: string,
    searchText: string,
  ): ts.QuickInfo | undefined {
    const pos = findPosition(filePath, searchText);
    return proxiedLs.getQuickInfoAtPosition(filePath, pos);
  }

  async function waitForInitialScan(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 200));
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
    logs,
  };
}
