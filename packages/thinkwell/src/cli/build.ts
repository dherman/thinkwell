/**
 * Build command for tsc-based compilation with @JSONSchema transformation.
 *
 * This module provides the `thinkwell build` command that compiles a TypeScript
 * project using the standard TypeScript compiler API with a custom CompilerHost.
 * The CompilerHost intercepts file reads and applies @JSONSchema namespace
 * injection in memory, so user source files are never modified on disk.
 *
 * Output (.js, .d.ts, source maps) is written to the project's configured outDir.
 */

import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, matchesGlob } from "node:path";
import { styleText } from "node:util";
import { createThinkwellProgram, createThinkwellWatchHost } from "./compiler-host.js";
import { cyan, cyanBold, greenBold, whiteBold, dim } from "./fmt.js";
import { fmtError } from "./commands.js";
import { checkDependencies, hasPackageJson } from "./dependency-check.js";
import { formatMissingDependencyError, hasMissingDependencies } from "./dependency-errors.js";

// ============================================================================
// Types
// ============================================================================

export interface BuildOptions {
  /** Path to tsconfig.json (default: ./tsconfig.json) */
  project?: string;
  /** Show detailed output */
  verbose?: boolean;
  /** Suppress all output except errors */
  quiet?: boolean;
  /** Watch for file changes and recompile */
  watch?: boolean;
}

/**
 * Configuration that can be specified in package.json under "thinkwell.build".
 */
export interface PackageJsonBuildConfig {
  /** Glob patterns for files that should receive @JSONSchema transformation */
  include?: string[];
  /** Glob patterns for files that should NOT receive @JSONSchema transformation */
  exclude?: string[];
}

// ============================================================================
// Package.json Configuration
// ============================================================================

/**
 * Read build configuration from package.json in the given directory.
 * Returns undefined if no configuration is found.
 */
function readPackageJsonConfig(dir: string): PackageJsonBuildConfig | undefined {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);

    const config = pkg?.thinkwell?.build;
    if (!config || typeof config !== "object") {
      return undefined;
    }

    const result: PackageJsonBuildConfig = {};

    if (Array.isArray(config.include)) {
      result.include = config.include.filter((i: unknown): i is string => typeof i === "string");
    }

    if (Array.isArray(config.exclude)) {
      result.exclude = config.exclude.filter((e: unknown): e is string => typeof e === "string");
    }

    return result;
  } catch {
    return undefined;
  }
}

/**
 * Create a file filter function from include/exclude glob patterns.
 *
 * - If include is specified, only files matching at least one include pattern
 *   are eligible for transformation.
 * - If exclude is specified, files matching any exclude pattern are skipped.
 * - Exclude takes precedence over include.
 *
 * Returns undefined if no filtering is needed (no include/exclude configured).
 */
function createFileFilter(
  config: PackageJsonBuildConfig | undefined,
): ((fileName: string) => boolean) | undefined {
  if (!config) return undefined;

  const { include, exclude } = config;
  const hasInclude = include && include.length > 0;
  const hasExclude = exclude && exclude.length > 0;

  if (!hasInclude && !hasExclude) return undefined;

  return (fileName: string) => {
    // Exclude takes precedence
    if (hasExclude) {
      for (const pattern of exclude) {
        if (matchesGlob(fileName, pattern)) return false;
      }
    }

    // If include is specified, file must match at least one pattern
    if (hasInclude) {
      for (const pattern of include) {
        if (matchesGlob(fileName, pattern)) return true;
      }
      return false;
    }

    return true;
  };
}

// ============================================================================
// Diagnostics Formatting
// ============================================================================

const diagnosticsHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  if (diagnostics.length === 0) return "";
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticsHost);
}

// ============================================================================
// Build Command
// ============================================================================

export async function runBuild(options: BuildOptions): Promise<void> {
  const cwd = process.cwd();

  // Check for required dependencies when a package.json exists
  if (hasPackageJson(cwd)) {
    const depCheck = await checkDependencies(cwd);
    if (hasMissingDependencies(depCheck)) {
      console.error(formatMissingDependencyError(depCheck));
      process.exit(2);
    }
  }

  const configPath = options.project
    ? resolve(cwd, options.project)
    : resolve(cwd, "tsconfig.json");

  if (!existsSync(configPath)) {
    console.error(fmtError(`Cannot find ${options.project ?? "tsconfig.json"}`));
    console.error("");
    console.error("  Run this command from a directory with a tsconfig.json,");
    console.error("  or use --project to specify the path.");
    process.exit(1);
  }

  // Read include/exclude globs from package.json
  const pkgConfig = readPackageJsonConfig(cwd);
  const fileFilter = createFileFilter(pkgConfig);

  if (options.verbose && pkgConfig) {
    if (pkgConfig.include) {
      console.error(`  @JSONSchema include: ${pkgConfig.include.join(", ")}`);
    }
    if (pkgConfig.exclude) {
      console.error(`  @JSONSchema exclude: ${pkgConfig.exclude.join(", ")}`);
    }
  }

  // Resolve project directory for project-local @JSONSchema processing
  const projectDir = hasPackageJson(cwd) ? cwd : undefined;

  // Watch mode: use TypeScript's watch API for continuous compilation
  if (options.watch) {
    return runWatch(configPath, fileFilter, projectDir);
  }

  // Single-pass build
  const { program, configErrors } = (fileFilter || projectDir)
    ? createThinkwellProgram({ configPath, fileFilter, projectDir })
    : createThinkwellProgram(configPath);

  // Report config-level diagnostics
  if (configErrors.length > 0) {
    console.error(formatDiagnostics(configErrors));
    const hasFatal = configErrors.some(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (hasFatal) {
      process.exit(1);
    }
  }

  // Get pre-emit diagnostics (type errors, etc.)
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics));
  }

  // Emit output files
  const emitResult = program.emit();

  // Report emit diagnostics
  if (emitResult.diagnostics.length > 0) {
    console.error(formatDiagnostics(emitResult.diagnostics));
  }

  // Count all errors
  const allDiagnostics = [...diagnostics, ...emitResult.diagnostics];
  const errorCount = allDiagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  ).length;

  if (errorCount > 0) {
    console.error("");
    console.error(
      `Found ${errorCount} error${errorCount === 1 ? "" : "s"}.`,
    );
    process.exit(1);
  }

  if (!options.quiet) {
    const fileCount = program.getSourceFiles().filter(
      (sf) => !sf.fileName.includes("node_modules") && !sf.fileName.includes("/lib/lib."),
    ).length;
    console.error(
      styleText("green", "✔") +
      ` Build complete (${fileCount} file${fileCount === 1 ? "" : "s"})`,
    );
  }
}

// ============================================================================
// Watch Mode
// ============================================================================

/**
 * Run the build in watch mode using TypeScript's watch API.
 *
 * TypeScript handles file watching, debouncing, and incremental re-compilation
 * automatically. The custom CompilerHost's @JSONSchema transformation is applied
 * on each rebuild via the createProgram callback.
 *
 * This function never returns — it runs until the process is killed (Ctrl+C).
 */
function runWatch(
  configPath: string,
  fileFilter: ((fileName: string) => boolean) | undefined,
  projectDir?: string,
): Promise<never> {
  const reportDiagnostic: ts.DiagnosticReporter = (diagnostic) => {
    console.error(ts.formatDiagnosticsWithColorAndContext([diagnostic], diagnosticsHost));
  };

  const reportWatchStatus: ts.WatchStatusReporter = (diagnostic) => {
    console.error(ts.formatDiagnostic(diagnostic, diagnosticsHost).trimEnd());
  };

  const watchHost = createThinkwellWatchHost({
    configPath,
    fileFilter,
    projectDir,
    reportDiagnostic,
    reportWatchStatus,
  });

  ts.createWatchProgram(watchHost);

  // Keep the process alive. TypeScript's watch system registers file watchers
  // that keep the event loop active, so this promise never resolves.
  // The process exits when the user presses Ctrl+C.
  return new Promise(() => {});
}

// ============================================================================
// Argument Parsing
// ============================================================================

export function parseBuildArgs(args: string[]): BuildOptions {
  const options: BuildOptions = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-p" || arg === "--project") {
      i++;
      if (i >= args.length) {
        throw new Error("Missing value for --project");
      }
      options.project = args[i];
    } else if (arg === "--watch" || arg === "-w") {
      options.watch = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(
        `Unexpected argument: ${arg}\n\n` +
        `  "thinkwell build" compiles the project using tsconfig.json.\n` +
        `  It does not take an entry file argument.\n\n` +
        `  Did you mean "thinkwell bundle ${arg}"?`
      );
    }
    i++;
  }

  return options;
}

// ============================================================================
// Help
// ============================================================================

export function showBuildHelp(): void {
  console.log(`
${cyanBold("thinkwell build")} - ${whiteBold("Compile TypeScript with @JSONSchema transformation")}

${greenBold("Usage:")}
  ${cyanBold("thinkwell build")} ${cyan("[options]")}

${greenBold("Options:")}
  ${cyan("-w, --watch")}            Watch for file changes and recompile
  ${cyan("-p, --project")} ${dim("<path>")}   Path to tsconfig.json ${dim("(default: ./tsconfig.json)")}
  ${cyan("-q, --quiet")}            Suppress all output except errors
  ${cyan("--verbose")}              Show detailed build output
  ${cyan("-h, --help")}             Show this help message

${greenBold("Description:")}
  Compiles your TypeScript project using the standard TypeScript compiler
  with a custom CompilerHost that applies @JSONSchema namespace injection
  in memory. Your source files are never modified.

  Output (.js, .d.ts, source maps) is written to the outDir configured
  in your tsconfig.json.

${greenBold("Examples:")}
  ${cyanBold("thinkwell build")}                         Build the project
  ${cyanBold("thinkwell build")} ${cyan("--watch")}                 Watch and rebuild on changes
  ${cyanBold("thinkwell build")} ${cyan("-p")} ${dim("<tsconfig.app.json>")}  Use a specific tsconfig
  ${cyanBold("thinkwell build")} ${cyan("--quiet")}                 Suppress success output ${dim("(for CI)")}

${greenBold("Configuration via package.json:")}
  Control which files receive @JSONSchema transformation:

    {
      "thinkwell": {
        "build": {
          "include": ["src/**/*.ts"],
          "exclude": ["**/*.test.ts", "**/__fixtures__/**"]
        }
      }
    }

${dim("Note: Files not matched by include (or matched by exclude) are still")}
${dim("      compiled by TypeScript — they just skip @JSONSchema transformation.")}
`.trim() + "\n");
}
