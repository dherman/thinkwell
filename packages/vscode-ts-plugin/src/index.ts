/**
 * Thinkwell TypeScript Language Service Plugin
 *
 * Provides IDE support for the @JSONSchema feature by:
 * 1. Scanning project files for @JSONSchema-marked types
 * 2. Generating a virtual .d.ts with namespace merge declarations
 * 3. Serving the virtual file to TypeScript via monkey-patched getScriptSnapshot()
 * 4. Filtering residual "Property does not exist" diagnostics on augmented types
 */

import ts from "typescript";
import path from "node:path";
import { type MarkedType, findMarkedTypes, hasJsonSchemaMarkers } from "./scanner";
import { generateVirtualDeclarations } from "./virtual-declarations";

const VIRTUAL_FILE_NAME = "__thinkwell_augmentations__.d.ts";

interface PluginState {
  /** Map from source file path to its marked types. */
  typesByFile: Map<string, MarkedType[]>;
  /** The current virtual declaration file content. */
  virtualContent: string;
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
  fileName: string,
  host: ts.LanguageServiceHost,
): MarkedType[] {
  const snapshot = host.getScriptSnapshot(fileName);
  if (!snapshot) return [];

  const source = snapshot.getText(0, snapshot.getLength());
  if (!hasJsonSchemaMarkers(source)) return [];

  return findMarkedTypes(fileName, source);
}

/**
 * Perform a full scan of all project files. Updates the plugin state
 * with newly discovered types and regenerates the virtual file.
 */
function fullScan(
  info: ts.server.PluginCreateInfo,
  state: PluginState,
): void {
  state.typesByFile.clear();

  const program = info.languageService.getProgram();
  if (!program) return;

  for (const sourceFile of program.getSourceFiles()) {
    // Skip declaration files and files outside the project
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;

    const types = scanFile(sourceFile.fileName, info.languageServiceHost);
    if (types.length > 0) {
      state.typesByFile.set(sourceFile.fileName, types);
    }
  }

  regenerateVirtualFile(state);
}

/**
 * Incrementally rescan a single file and update the virtual declarations
 * if the set of marked types changed.
 */
function rescanFile(
  fileName: string,
  info: ts.server.PluginCreateInfo,
  state: PluginState,
): void {
  const types = scanFile(fileName, info.languageServiceHost);

  const prevTypes = state.typesByFile.get(fileName);
  const changed = !typesEqual(prevTypes ?? [], types);

  if (changed) {
    if (types.length > 0) {
      state.typesByFile.set(fileName, types);
    } else {
      state.typesByFile.delete(fileName);
    }
    regenerateVirtualFile(state);

    // Tell tsserver the virtual file changed so it re-checks
    info.project.refreshDiagnostics();
  }
}

/**
 * Regenerate the virtual declaration file content and update the
 * augmented type names set.
 */
function regenerateVirtualFile(state: PluginState): void {
  state.virtualContent = generateVirtualDeclarations(state.typesByFile);

  state.augmentedTypeNames.clear();
  for (const types of state.typesByFile.values()) {
    for (const t of types) {
      state.augmentedTypeNames.add(t.name);
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
    const virtualFilePath = path.join(projectDir, VIRTUAL_FILE_NAME);

    const state: PluginState = {
      typesByFile: new Map(),
      virtualContent: "",
      virtualFilePath,
      augmentedTypeNames: new Set(),
    };

    info.project.log("[thinkwell] Plugin loaded for project: " + projectDir);

    // ---------------------------------------------------------------
    // Monkey-patch LanguageServiceHost.getScriptSnapshot()
    // to serve the virtual declaration file.
    // ---------------------------------------------------------------
    const originalGetScriptSnapshot = info.languageServiceHost.getScriptSnapshot.bind(
      info.languageServiceHost,
    );

    info.languageServiceHost.getScriptSnapshot = (fileName: string) => {
      if (fileName === state.virtualFilePath) {
        return tsModule.ScriptSnapshot.fromString(state.virtualContent);
      }
      return originalGetScriptSnapshot(fileName);
    };

    // Also patch getScriptVersion so TypeScript knows when the virtual file changes
    const originalGetScriptVersion = info.languageServiceHost.getScriptVersion.bind(
      info.languageServiceHost,
    );
    let virtualFileVersion = 0;

    info.languageServiceHost.getScriptVersion = (fileName: string) => {
      if (fileName === state.virtualFilePath) {
        return String(virtualFileVersion);
      }
      return originalGetScriptVersion(fileName);
    };

    // Patch getScriptFileNames to include the virtual file
    const originalGetScriptFileNames = info.languageServiceHost.getScriptFileNames.bind(
      info.languageServiceHost,
    );

    info.languageServiceHost.getScriptFileNames = () => {
      const names = originalGetScriptFileNames();
      if (!names.includes(state.virtualFilePath)) {
        return [...names, state.virtualFilePath];
      }
      return names;
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
        rescanFile(fileName, info, state);
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
    // Initial full scan
    // ---------------------------------------------------------------
    // Defer the initial scan slightly so the project is fully initialized
    setTimeout(() => {
      fullScan(info, state);
      virtualFileVersion++;
      info.project.refreshDiagnostics();
      info.project.log(
        `[thinkwell] Initial scan complete. Found ${state.augmentedTypeNames.size} augmented type(s).`,
      );
    }, 100);

    return proxy;
  }

  function getExternalFiles(project: ts.server.Project): string[] {
    const projectDir = project.getCurrentDirectory();
    return [path.join(projectDir, VIRTUAL_FILE_NAME)];
  }

  return { create, getExternalFiles };
}

export = init;
