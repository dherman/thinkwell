/**
 * Thinkwell TypeScript Language Service Plugin
 *
 * Provides IDE support for the @JSONSchema feature by:
 * 1. Scanning project files for @JSONSchema-marked types
 * 2. Generating a .d.ts with namespace merge declarations (written to disk)
 * 3. Filtering residual "Property does not exist" diagnostics on augmented types
 * 4. Resolving thinkwell imports in standalone scripts (no node_modules)
 */

import type ts from "typescript";
import path from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { type MarkedType, findMarkedTypes, hasJsonSchemaMarkers } from "./scanner";
import { generateVirtualDeclarations } from "./virtual-declarations";
import { patchModuleResolution } from "./standalone-resolver";

const VIRTUAL_DIR = ".thinkwell";
const VIRTUAL_FILE_NAME = "augmentations.d.ts";

interface PluginState {
  /** Map from source file path to its marked types. */
  typesByFile: Map<string, MarkedType[]>;
  /** The current virtual declaration file content. */
  virtualContent: string;
  /** Monotonically increasing version counter for the virtual file. */
  virtualFileVersion: number;
  /** The absolute path of the virtual file within the project. */
  virtualFilePath: string;
  /** Set of type names known to be augmented (for diagnostic filtering). */
  augmentedTypeNames: Set<string>;
}

/**
 * Scan a single file for @JSONSchema markers, using a regex pre-filter
 * for performance. Returns the marked types, or an empty array if none found.
 */
function scanFile(
  tsModule: typeof ts,
  fileName: string,
  host: ts.LanguageServiceHost,
): MarkedType[] {
  const snapshot = host.getScriptSnapshot(fileName);
  if (!snapshot) return [];

  const source = snapshot.getText(0, snapshot.getLength());
  if (!hasJsonSchemaMarkers(source)) return [];

  return findMarkedTypes(tsModule, fileName, source);
}

/**
 * Perform a full scan of all project files. Updates the plugin state
 * with newly discovered types and regenerates the virtual file.
 *
 * Uses `getScriptFileNames()` from the host rather than `getProgram()`
 * so this can run synchronously during `create()` before the program
 * is built.
 */
function fullScan(
  tsModule: typeof ts,
  info: ts.server.PluginCreateInfo,
  state: PluginState,
): void {
  state.typesByFile.clear();

  const fileNames = info.languageServiceHost.getScriptFileNames();

  for (const fileName of fileNames) {
    // Skip declaration files and files outside the project
    if (fileName.endsWith(".d.ts")) continue;
    if (fileName.includes("node_modules")) continue;

    const types = scanFile(tsModule, fileName, info.languageServiceHost);
    if (types.length > 0) {
      state.typesByFile.set(fileName, types);
    }
  }

  writeVirtualFile(state, info);
}

/**
 * Incrementally rescan a single file and update the virtual declarations
 * if the set of marked types changed.
 */
function rescanFile(
  tsModule: typeof ts,
  fileName: string,
  info: ts.server.PluginCreateInfo,
  state: PluginState,
): void {
  const types = scanFile(tsModule, fileName, info.languageServiceHost);

  const prevTypes = state.typesByFile.get(fileName);
  const changed = !typesEqual(prevTypes ?? [], types);

  if (changed) {
    if (types.length > 0) {
      state.typesByFile.set(fileName, types);
    } else {
      state.typesByFile.delete(fileName);
    }
    writeVirtualFile(state, info, /* forceProjectUpdate */ true);

    // Tell tsserver to recompute diagnostics
    info.project.refreshDiagnostics();
  }
}

/**
 * Regenerate the virtual declaration file content, update the augmented
 * type names set, and write the file to disk.
 *
 * @param forceProjectUpdate - When true, reloads the ScriptInfo cache and
 *   rebuilds the project graph so tsserver picks up the new content.
 */
function writeVirtualFile(
  state: PluginState,
  info: ts.server.PluginCreateInfo,
  forceProjectUpdate = false,
): void {
  const newContent = generateVirtualDeclarations(state.typesByFile);

  state.augmentedTypeNames.clear();
  for (const types of state.typesByFile.values()) {
    for (const t of types) {
      state.augmentedTypeNames.add(t.name);
    }
  }

  // Only write if content actually changed
  if (newContent === state.virtualContent) return;
  state.virtualContent = newContent;
  state.virtualFileVersion++;

  try {
    const dir = path.dirname(state.virtualFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(state.virtualFilePath, newContent, "utf-8");
    info.project.log(`[thinkwell] Wrote augmentations to ${state.virtualFilePath}`);
  } catch (e) {
    info.project.log(`[thinkwell] Failed to write augmentations: ${e}`);
  }

  if (forceProjectUpdate) {
    // Force tsserver to re-read the augmentations file from disk.
    // tsserver caches file content in ScriptInfo objects. Simply
    // writing to disk doesn't make it notice the change. We must
    // call reloadFromFile() on the ScriptInfo to bust the cache,
    // then updateGraph() to rebuild the program with new content.
    try {
      const project = info.project as unknown as {
        projectService: {
          getScriptInfo(fileName: string): {
            reloadFromFile(): boolean;
          } | undefined;
        };
        updateGraph: () => boolean;
      };
      const scriptInfo = project.projectService?.getScriptInfo(state.virtualFilePath);
      if (scriptInfo && typeof scriptInfo.reloadFromFile === "function") {
        scriptInfo.reloadFromFile();
      }
      if (typeof project.updateGraph === "function") {
        project.updateGraph();
      }
    } catch (e) {
      info.project.log(`[thinkwell] Warning: could not update project graph: ${e}`);
    }
  }
}

/**
 * Compare two MarkedType arrays for equality (order-sensitive).
 */
function typesEqual(a: MarkedType[], b: MarkedType[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.name === b[i].name && t.isExported === b[i].isExported);
}

/**
 * Plugin module factory. This is the entry point that TypeScript calls
 * when loading the plugin.
 */
function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
  const tsModule = modules.typescript;

  function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
    const projectDir = info.project.getCurrentDirectory();
    const virtualFilePath = path.join(projectDir, VIRTUAL_DIR, VIRTUAL_FILE_NAME);

    const state: PluginState = {
      typesByFile: new Map(),
      virtualContent: "",
      virtualFileVersion: 0,
      virtualFilePath,
      augmentedTypeNames: new Set(),
    };

    info.project.log("[thinkwell] Plugin loaded for project: " + projectDir);

    // ---------------------------------------------------------------
    // Monkey-patch resolveModuleNameLiterals for standalone scripts
    // that import thinkwell without node_modules.
    // ---------------------------------------------------------------
    patchModuleResolution(info, tsModule);

    // ---------------------------------------------------------------
    // Patch getScriptSnapshot, getScriptVersion, and
    // getScriptFileNames on the host so that:
    // - The augmentations file appears in root file names (making it
    //   part of the program, not just an external file)
    // - TypeScript sees the latest in-memory content
    // - TypeScript detects content changes via version bumps
    // ---------------------------------------------------------------
    const origGetScriptFileNames = info.languageServiceHost.getScriptFileNames.bind(info.languageServiceHost);
    info.languageServiceHost.getScriptFileNames = () => {
      const names = origGetScriptFileNames();
      if (state.virtualContent && !names.includes(virtualFilePath)) {
        return [...names, virtualFilePath];
      }
      return names;
    };

    const origGetScriptSnapshot = info.languageServiceHost.getScriptSnapshot.bind(info.languageServiceHost);
    info.languageServiceHost.getScriptSnapshot = (fileName: string) => {
      if (fileName === virtualFilePath && state.virtualContent) {
        return tsModule.ScriptSnapshot.fromString(state.virtualContent);
      }
      return origGetScriptSnapshot(fileName);
    };

    const origGetScriptVersion = info.languageServiceHost.getScriptVersion.bind(info.languageServiceHost);
    info.languageServiceHost.getScriptVersion = (fileName: string) => {
      if (fileName === virtualFilePath) {
        return String(state.virtualFileVersion);
      }
      return origGetScriptVersion(fileName);
    };

    // ---------------------------------------------------------------
    // Wrap the language service proxy to intercept diagnostics and
    // trigger rescans on file changes.
    // ---------------------------------------------------------------
    const proxy = Object.create(null) as ts.LanguageService;

    for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
      const x = info.languageService[k]!;
      // @ts-expect-error — dynamic proxy delegation
      proxy[k] = typeof x === "function" ? x.bind(info.languageService) : x;
    }

    // On getSemanticDiagnostics: rescan the file first, then filter results
    proxy.getSemanticDiagnostics = (fileName: string): ts.Diagnostic[] => {
      // Trigger incremental rescan for the file being checked
      if (!fileName.includes("node_modules") && !fileName.endsWith(".d.ts")) {
        rescanFile(tsModule, fileName, info, state);
      }

      const diagnostics = info.languageService.getSemanticDiagnostics(fileName);

      // Filter out "Property 'X' does not exist on type 'typeof Y'" (code 2339)
      // for known augmented types
      return diagnostics.filter((d) => {
        if (d.code !== 2339) return true;

        const messageText = typeof d.messageText === "string"
          ? d.messageText
          : d.messageText.messageText;

        // Pattern: "Property 'Schema' does not exist on type 'typeof Greeting'."
        const match = messageText.match(
          /Property '(\w+)' does not exist on type 'typeof (\w+)'/,
        );
        if (match) {
          const [, propName, typeName] = match;
          if (propName === "Schema" && state.augmentedTypeNames.has(typeName)) {
            return false; // suppress
          }
        }

        return true;
      });
    };

    // ---------------------------------------------------------------
    // Initial full scan — synchronous so augmentations.d.ts has real
    // content before tsserver's updateGraphWorker reads it via
    // getExternalFiles().
    // ---------------------------------------------------------------
    fullScan(tsModule, info, state);
    info.project.log(
      `[thinkwell] Initial scan complete. Found ${state.augmentedTypeNames.size} augmented type(s).`,
    );

    return proxy;
  }

  function getExternalFiles(project: ts.server.Project): string[] {
    const projectDir = project.getCurrentDirectory();
    const filePath = path.join(projectDir, VIRTUAL_DIR, VIRTUAL_FILE_NAME);
    if (existsSync(filePath)) {
      return [filePath];
    }
    return [];
  }

  return { create, getExternalFiles };
}

export = init;
