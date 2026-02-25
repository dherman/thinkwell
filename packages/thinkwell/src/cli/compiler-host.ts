/**
 * Custom TypeScript CompilerHost for thinkwell build and check commands.
 *
 * This module provides the shared infrastructure that intercepts TypeScript's
 * file reads and applies @JSONSchema namespace injection in memory. Files
 * without @JSONSchema markers pass through unchanged. Files from node_modules
 * and TypeScript lib files are always passed through unchanged.
 *
 * Used by `thinkwell build` (single-pass and watch mode) and `thinkwell check` (noEmit).
 */

import ts from "typescript";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { transformJsonSchemas, hasJsonSchemaMarkers } from "./schema.js";

/**
 * Get the TypeScript lib directory path.
 *
 * When running from the compiled binary (pkg snapshot), TypeScript's lib files
 * are bundled at dist-pkg/typescript-lib/. When running normally, use the
 * default TypeScript lib path.
 */
function getTypeScriptLibDir(): string {
  // Check if we're running from a compiled binary (pkg sets process.pkg)
  if (typeof (process as any).pkg !== "undefined") {
    // In the snapshot, the lib files are at /snapshot/.../dist-pkg/typescript-lib/
    const snapshotLibDir = "/snapshot/thinkwell/packages/thinkwell/dist-pkg/typescript-lib";
    if (existsSync(snapshotLibDir)) {
      return snapshotLibDir;
    }
  }

  // Default: use TypeScript's own lib directory
  return dirname(ts.getDefaultLibFilePath({}));
}

/**
 * Result of parsing and validating a tsconfig.json file.
 */
export interface ParsedConfig {
  /** Resolved compiler options */
  options: ts.CompilerOptions;
  /** Root file names (the files to compile) */
  fileNames: string[];
  /** Any errors encountered during parsing */
  errors: readonly ts.Diagnostic[];
}

/**
 * Read and parse a tsconfig.json file using the TypeScript compiler API.
 *
 * @param configPath - Absolute path to tsconfig.json
 * @returns Parsed configuration, or an error diagnostic if the file can't be read
 */
export function parseTsConfig(configPath: string): ParsedConfig {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

  if (configFile.error) {
    return {
      options: {},
      fileNames: [],
      errors: [configFile.error],
    };
  }

  const configDir = dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    configDir,
    /* existingOptions */ undefined,
    configPath,
  );

  return {
    options: parsed.options,
    fileNames: parsed.fileNames,
    errors: parsed.errors,
  };
}

/**
 * Determine whether a file path should receive @JSONSchema transformation.
 *
 * Only project source files are transformed. Files in node_modules and
 * TypeScript's own lib files are always passed through unchanged.
 */
function shouldTransform(fileName: string): boolean {
  if (fileName.includes("node_modules")) return false;
  if (fileName.includes("/lib/lib.")) return false;
  return true;
}

/**
 * Options for creating a custom CompilerHost.
 */
export interface ThinkwellHostOptions {
  /** TypeScript compiler options (used to create the default host) */
  compilerOptions: ts.CompilerOptions;
  /**
   * Optional additional filter for controlling which files receive @JSONSchema
   * transformation. Called only for project files (node_modules and lib files
   * are always excluded). Return true to allow transformation.
   */
  fileFilter?: (fileName: string) => boolean;
  /**
   * Optional project root directory for resolving project-local
   * ts-json-schema-generator. When set, @JSONSchema processing uses the
   * project's version instead of the bundled one.
   */
  projectDir?: string;
}

function isThinkwellHostOptions(options: ts.CompilerOptions | ThinkwellHostOptions): options is ThinkwellHostOptions {
  return typeof (options as ThinkwellHostOptions).compilerOptions === "object"
    && (options as ThinkwellHostOptions).compilerOptions !== null
    && !Array.isArray((options as ThinkwellHostOptions).compilerOptions);
}

/**
 * Create a custom CompilerHost that applies @JSONSchema transformation.
 *
 * The host wraps the default TypeScript CompilerHost and intercepts
 * `getSourceFile()` to apply `transformJsonSchemas()` on project files.
 * All other methods delegate to the default host.
 *
 * @param options - TypeScript compiler options, or a ThinkwellHostOptions object
 * @returns A CompilerHost that applies @JSONSchema transformations in memory
 */
export function createThinkwellHost(options: ts.CompilerOptions): ts.CompilerHost;
export function createThinkwellHost(options: ThinkwellHostOptions): ts.CompilerHost;
export function createThinkwellHost(options: ts.CompilerOptions | ThinkwellHostOptions): ts.CompilerHost {
  let compilerOptions: ts.CompilerOptions;
  let fileFilter: ((fileName: string) => boolean) | undefined;
  let projectDir: string | undefined;

  if (isThinkwellHostOptions(options)) {
    compilerOptions = options.compilerOptions;
    fileFilter = options.fileFilter;
    projectDir = options.projectDir;
  } else {
    compilerOptions = options;
    fileFilter = undefined;
    projectDir = undefined;
  }
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const tsLibDir = getTypeScriptLibDir();

  return {
    ...defaultHost,

    // Override getDefaultLibLocation to point to our bundled TypeScript lib files
    // when running from the compiled binary. This is necessary because bundled
    // TypeScript code can't find its .d.ts files in the pkg snapshot.
    getDefaultLibLocation() {
      return tsLibDir;
    },

    getDefaultLibFileName(options) {
      return join(tsLibDir, ts.getDefaultLibFileName(options));
    },

    getSourceFile(fileName, languageVersionOrOptions) {
      const source = ts.sys.readFile(fileName);
      if (source === undefined) {
        return undefined;
      }

      // Only transform project source files that contain @JSONSchema markers.
      // If a fileFilter is provided, also check that the file passes the filter.
      if (shouldTransform(fileName) && hasJsonSchemaMarkers(source)) {
        if (!fileFilter || fileFilter(fileName)) {
          const transformed = transformJsonSchemas(fileName, source, projectDir);
          return ts.createSourceFile(fileName, transformed, languageVersionOrOptions);
        }
      }

      // Pass through unchanged
      return ts.createSourceFile(fileName, source, languageVersionOrOptions);
    },
  };
}

/**
 * Options for creating a Thinkwell-aware TypeScript program.
 */
export interface CreateProgramOptions {
  /** Absolute path to the project's tsconfig.json */
  configPath: string;
  /**
   * Optional filter for controlling which files receive @JSONSchema
   * transformation. See {@link ThinkwellHostOptions.fileFilter}.
   */
  fileFilter?: (fileName: string) => boolean;
  /**
   * Optional project root directory for resolving project-local
   * ts-json-schema-generator. See {@link ThinkwellHostOptions.projectDir}.
   */
  projectDir?: string;
}

/**
 * Create a TypeScript Program wired to the custom CompilerHost.
 *
 * This is the main entry point for both `thinkwell build` and `thinkwell check`.
 * The returned program can be used with `ts.getPreEmitDiagnostics()` for type
 * checking or `program.emit()` for producing output files.
 *
 * @param configPathOrOptions - Absolute path to tsconfig.json, or a CreateProgramOptions object
 * @returns The ts.Program and any config-level diagnostics, or null with errors
 */
export function createThinkwellProgram(configPathOrOptions: string | CreateProgramOptions): {
  program: ts.Program;
  configErrors: readonly ts.Diagnostic[];
} {
  const configPath = typeof configPathOrOptions === "string"
    ? configPathOrOptions
    : configPathOrOptions.configPath;
  const fileFilter = typeof configPathOrOptions === "object"
    ? configPathOrOptions.fileFilter
    : undefined;
  const projectDir = typeof configPathOrOptions === "object"
    ? configPathOrOptions.projectDir
    : undefined;

  const resolvedConfigPath = resolve(configPath);
  const { options, fileNames, errors } = parseTsConfig(resolvedConfigPath);

  function makeHost() {
    return (fileFilter || projectDir)
      ? createThinkwellHost({ compilerOptions: options, fileFilter, projectDir })
      : createThinkwellHost(options);
  }

  // If there are fatal config errors, still return them so callers can report
  if (errors.length > 0) {
    // Check if any errors are fatal (not just warnings)
    const fatalErrors = errors.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (fatalErrors.length > 0) {
      // Create a minimal program so callers have a consistent interface
      const host = makeHost();
      const program = ts.createProgram([], options, host);
      return { program, configErrors: errors };
    }
  }

  const host = makeHost();
  const program = ts.createProgram(fileNames, options, host);

  return { program, configErrors: errors };
}

// ============================================================================
// Watch Mode
// ============================================================================

/**
 * Options for creating a watch-mode compiler host.
 */
export interface CreateWatchHostOptions {
  /** Absolute path to the project's tsconfig.json */
  configPath: string;
  /**
   * Optional filter for controlling which files receive @JSONSchema
   * transformation. See {@link ThinkwellHostOptions.fileFilter}.
   */
  fileFilter?: (fileName: string) => boolean;
  /**
   * Optional project root directory for resolving project-local
   * ts-json-schema-generator. See {@link ThinkwellHostOptions.projectDir}.
   */
  projectDir?: string;
  /** Callback to report individual diagnostics (errors, warnings) */
  reportDiagnostic: ts.DiagnosticReporter;
  /** Callback to report watch status changes ("Starting compilation...", etc.) */
  reportWatchStatus: ts.WatchStatusReporter;
}

/**
 * Patch a CompilerHost to apply @JSONSchema transformation and use bundled lib files.
 *
 * This is used by watch mode to wrap the host that TypeScript's watch system
 * provides, preserving its internal state while intercepting file reads.
 */
function patchHost(
  host: ts.CompilerHost,
  fileFilter?: (fileName: string) => boolean,
  projectDir?: string,
): void {
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const tsLibDir = getTypeScriptLibDir();

  // Override lib location for compiled binary
  host.getDefaultLibLocation = () => tsLibDir;
  host.getDefaultLibFileName = (options) => join(tsLibDir, ts.getDefaultLibFileName(options));

  host.getSourceFile = (fileName, languageVersionOrOptions, onError?, shouldCreateNewSourceFile?) => {
    const source = ts.sys.readFile(fileName);
    if (source === undefined) {
      return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    }

    if (shouldTransform(fileName) && hasJsonSchemaMarkers(source)) {
      if (!fileFilter || fileFilter(fileName)) {
        const transformed = transformJsonSchemas(fileName, source, projectDir);
        return ts.createSourceFile(fileName, transformed, languageVersionOrOptions);
      }
    }

    return ts.createSourceFile(fileName, source, languageVersionOrOptions);
  };
}

/**
 * Create a watch-mode compiler host with @JSONSchema transformation.
 *
 * Uses TypeScript's `ts.createWatchCompilerHost` (config-file mode) with a
 * custom `createProgram` callback that patches the host's `getSourceFile()`
 * to apply `@JSONSchema` namespace injection. TypeScript handles file watching,
 * debouncing, and incremental re-compilation automatically.
 *
 * @param options - Watch host configuration
 * @returns A watch compiler host ready to pass to `ts.createWatchProgram()`
 */
export function createThinkwellWatchHost(
  options: CreateWatchHostOptions,
): ts.WatchCompilerHostOfConfigFile<ts.EmitAndSemanticDiagnosticsBuilderProgram> {
  const { configPath, fileFilter, projectDir, reportDiagnostic, reportWatchStatus } = options;

  const createProgram: ts.CreateProgram<ts.EmitAndSemanticDiagnosticsBuilderProgram> = (
    rootNames,
    compilerOptions,
    host,
    oldProgram,
    configFileParsingDiagnostics,
    projectReferences,
  ) => {
    // Patch the host that TypeScript's watch system created, rather than
    // replacing it entirely. This preserves watch-specific internal state.
    if (host) {
      patchHost(host, fileFilter, projectDir);
    }

    return ts.createEmitAndSemanticDiagnosticsBuilderProgram(
      rootNames,
      compilerOptions,
      host,
      oldProgram,
      configFileParsingDiagnostics,
      projectReferences,
    );
  };

  return ts.createWatchCompilerHost(
    resolve(configPath),
    /* optionsToExtend */ undefined,
    ts.sys,
    createProgram,
    reportDiagnostic,
    reportWatchStatus,
  );
}
