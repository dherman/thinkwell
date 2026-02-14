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
  /** Whether the initial full scan has been performed. */
  initialScanDone: boolean;
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
 * so this can run synchronously before the program is built.
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
    writeVirtualFile(state, info);
    // The file watcher will detect the change and trigger diagnostics refresh
  }
}

/**
 * Regenerate the virtual declaration file content, update the augmented
 * type names set, and write the file to disk.
 *
 * Does NOT call updateGraph() or markAsDirty() — instead relies on
 * the host patches (getScriptVersion, getScriptFileNames) to let
 * tsserver's natural program builder detect changes. This avoids
 * disrupting tsserver's update cycle when called during diagnostics.
 */
function writeVirtualFile(
  state: PluginState,
  info: ts.server.PluginCreateInfo,
): void {
  const newContent = generateVirtualDeclarations(state.typesByFile);

  state.augmentedTypeNames.clear();
  for (const types of state.typesByFile.values()) {
    for (const t of types) {
      state.augmentedTypeNames.add(t.name);
    }
  }

  // If no types found, revert to the placeholder content (not empty)
  // so tsserver keeps the file in the program.
  const PLACEHOLDER = "// @thinkwell augmentations — will be populated on first scan\n";
  const effectiveContent = newContent || PLACEHOLDER;

  // Only write if content actually changed
  if (effectiveContent === state.virtualContent) return;
  state.virtualContent = effectiveContent;
  state.virtualFileVersion++;

  try {
    const dir = path.dirname(state.virtualFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(state.virtualFilePath, effectiveContent, "utf-8");
    info.project.log(`[thinkwell] Wrote augmentations to ${state.virtualFilePath} (version ${state.virtualFileVersion})`);
  } catch (e) {
    info.project.log(`[thinkwell] Failed to write augmentations: ${e}`);
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
    info.project.log("[thinkwell] Plugin loaded for project: " + projectDir);

    try {
      return createPluginProxy(info, projectDir);
    } catch (e) {
      info.project.log(`[thinkwell] Plugin initialization failed, falling back to default language service: ${e}`);
      return info.languageService;
    }
  }

  function createPluginProxy(
    info: ts.server.PluginCreateInfo,
    projectDir: string,
  ): ts.LanguageService {
    const virtualFilePath = path.join(projectDir, VIRTUAL_DIR, VIRTUAL_FILE_NAME);

    // Write a minimal placeholder so the augmentations file exists on disk
    // BEFORE tsserver's first updateGraph. This ensures tsserver can create
    // a ScriptInfo for it (ScriptInfo creation for non-open files requires
    // the file to exist on disk).
    const PLACEHOLDER = "// @thinkwell augmentations — will be populated on first scan\n";
    try {
      const dir = path.dirname(virtualFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(virtualFilePath, PLACEHOLDER, "utf-8");
    } catch {
      // Ignore — best effort
    }

    const state: PluginState = {
      typesByFile: new Map(),
      virtualContent: PLACEHOLDER,
      virtualFileVersion: 0,
      virtualFilePath,
      augmentedTypeNames: new Set(),
      initialScanDone: false,
    };

    // ---------------------------------------------------------------
    // Monkey-patch resolveModuleNameLiterals for standalone scripts
    // that import thinkwell without node_modules.
    // ---------------------------------------------------------------
    patchModuleResolution(info, tsModule);

    // ---------------------------------------------------------------
    // Patch getScriptSnapshot, getScriptVersion, getScriptFileNames,
    // and getProjectVersion on the host so that:
    //
    // - The augmentations file appears in root file names (making it
    //   part of the program, not just an external file)
    // - TypeScript sees the latest in-memory content via snapshots
    // - TypeScript detects content changes via version bumps
    // - The program builder re-evaluates when virtual content changes
    //
    // The getScriptSnapshot patch calls through to the original impl
    // first to ensure ScriptInfo is created and attached to the project.
    // This prevents the document registry's setDocument() crash.
    //
    // The getProjectVersion patch is critical: synchronizeHostDataWorker
    // has an early exit that skips root file evaluation if the project
    // version hasn't changed. By incorporating virtualFileVersion into
    // the project version, we ensure that when virtual content changes,
    // the program builder will re-run isProgramUptoDate() which checks
    // individual file versions via getScriptVersion().
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
        // Call original to ensure ScriptInfo is created and attached
        // to the project. The Project's getScriptSnapshot creates the
        // ScriptInfo via getOrCreateScriptInfoAndAttachToProject(),
        // which is needed for the document registry's setDocument().
        origGetScriptSnapshot(fileName);
        // Return in-memory content (not the on-disk file)
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

    // Patch getProjectVersion to incorporate virtual file changes.
    // Without this, synchronizeHostDataWorker's early exit prevents
    // the program from being rebuilt when only the virtual file changes.
    const origGetProjectVersion = info.languageServiceHost.getProjectVersion?.bind(info.languageServiceHost);
    if (origGetProjectVersion) {
      info.languageServiceHost.getProjectVersion = () => {
        const baseVersion = origGetProjectVersion();
        return `${baseVersion}-thinkwell-${state.virtualFileVersion}`;
      };
    }

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
      // Deferred initial scan — write augmentations file on first call
      if (!state.initialScanDone) {
        const fileNames = info.languageServiceHost.getScriptFileNames();
        if (fileNames.length > 0) {
          state.initialScanDone = true;
          fullScan(tsModule, info, state);
          info.project.log(
            `[thinkwell] Initial scan complete. Found ${state.augmentedTypeNames.size} augmented type(s).`,
          );

        }
      }

      // Trigger incremental rescan for the file being checked
      if (!fileName.includes("node_modules") && !fileName.endsWith(".d.ts")) {
        rescanFile(tsModule, fileName, info, state);
      }

      const diagnostics = info.languageService.getSemanticDiagnostics(fileName);
      info.project.log(
        `[thinkwell] getSemanticDiagnostics(${path.basename(fileName)}): ${diagnostics.length} diagnostics before filter`,
      );

      // Filter out "Property 'X' does not exist on type 'typeof Y'" (code 2339)
      // for known augmented types
      const filtered = diagnostics.filter((d) => {
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

      info.project.log(
        `[thinkwell] getSemanticDiagnostics(${path.basename(fileName)}): ${filtered.length} diagnostics after filter`,
      );
      return filtered;
    };

    return proxy;
  }

  // Note: we intentionally do NOT implement getExternalFiles().
  // In TS 5.9.3 (bundled with VSCode), getExternalFiles triggers a
  // setDocument Debug Failure crash during updateGraphWorker. The
  // augmentations file is instead injected via getScriptFileNames()
  // which safely includes it as a root file in the program.

  return { create };
}

export = init;
