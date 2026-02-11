/**
 * Check command for type-checking with @JSONSchema transformation.
 *
 * This module provides the `thinkwell check` command that runs TypeScript's
 * type checker without producing output files. It uses the same custom
 * CompilerHost as `thinkwell build`, but with `--noEmit` to skip emit.
 *
 * Supports single-package projects and workspace mode (pnpm/npm workspaces).
 */

import ts from "typescript";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createThinkwellProgram } from "./compiler-host.js";
import { cyan, cyanBold, greenBold, whiteBold, dim } from "./fmt.js";
import { detectWorkspace, resolvePackageName } from "./workspace.js";
import type { WorkspaceMember } from "./workspace.js";
import { checkDependencies, hasPackageJson } from "./dependency-check.js";
import { formatMissingDependencyError, hasMissingDependencies } from "./dependency-errors.js";

// ============================================================================
// Types
// ============================================================================

export interface CheckOptions {
  /** Package names to check (workspace mode only) */
  packages?: string[];
  /** Enable colorized output (default: true if TTY) */
  pretty?: boolean;
}

// ============================================================================
// Diagnostics Formatting
// ============================================================================

function createDiagnosticsHost(pretty: boolean): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  };
}

function formatDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  pretty: boolean,
): string {
  if (diagnostics.length === 0) return "";
  const host = createDiagnosticsHost(pretty);
  return pretty
    ? ts.formatDiagnosticsWithColorAndContext(diagnostics, host)
    : ts.formatDiagnostics(diagnostics, host);
}

// ============================================================================
// Single-Package Check
// ============================================================================

/**
 * Type-check a single package directory. Returns the number of errors found.
 */
function checkPackage(
  dir: string,
  pretty: boolean,
): number {
  const configPath = resolve(dir, "tsconfig.json");
  const { program, configErrors } = createThinkwellProgram(configPath);

  // Report config-level diagnostics
  if (configErrors.length > 0) {
    process.stderr.write(formatDiagnostics(configErrors, pretty));
    const hasFatal = configErrors.some(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (hasFatal) {
      return configErrors.filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      ).length;
    }
  }

  const diagnostics = ts.getPreEmitDiagnostics(program);
  const errors = diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );

  if (diagnostics.length > 0) {
    process.stderr.write("\n");
    process.stderr.write(formatDiagnostics(diagnostics, pretty));
  }

  return errors.length;
}

// ============================================================================
// Check Command
// ============================================================================

export async function runCheck(options: CheckOptions): Promise<void> {
  const cwd = process.cwd();
  const pretty = options.pretty ?? process.stdout.isTTY ?? false;
  const workspace = detectWorkspace(cwd);

  // --package requires a workspace
  if (options.packages && options.packages.length > 0 && !workspace) {
    process.stderr.write(
      'Error: --package can only be used in a workspace.\n' +
      'No pnpm-workspace.yaml or package.json "workspaces" found in current directory.\n',
    );
    process.exit(2);
  }

  // Single-package mode (no workspace detected)
  if (!workspace) {
    // Check for required dependencies when a package.json exists
    if (hasPackageJson(cwd)) {
      const depCheck = await checkDependencies(cwd);
      if (hasMissingDependencies(depCheck)) {
        process.stderr.write(formatMissingDependencyError(depCheck) + "\n");
        process.exit(2);
      }
    }

    const configPath = resolve(cwd, "tsconfig.json");
    if (!existsSync(configPath)) {
      process.stderr.write("Error: Cannot find tsconfig.json\n");
      process.stderr.write("\n");
      process.stderr.write(
        "  Run this command from a directory with a tsconfig.json.\n",
      );
      process.exit(2);
    }

    // Read package name for display, fall back to directory name
    let pkgName = cwd.split("/").pop() ?? "project";
    try {
      const pkgPath = join(cwd, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(
          (await import("node:fs")).readFileSync(pkgPath, "utf-8"),
        );
        if (pkg.name) pkgName = pkg.name;
      }
    } catch {
      // Use directory name
    }

    process.stderr.write(`  Checking ${pkgName}...\n`);
    const errorCount = checkPackage(cwd, pretty);

    if (errorCount > 0) {
      process.exit(1);
    }

    process.stderr.write("  No type errors found.\n");
    return;
  }

  // Workspace mode: check dependencies at workspace root
  if (hasPackageJson(workspace.rootDir)) {
    const depCheck = await checkDependencies(workspace.rootDir);
    if (hasMissingDependencies(depCheck)) {
      process.stderr.write(formatMissingDependencyError(depCheck) + "\n");
      process.exit(2);
    }
  }

  // Workspace mode: determine which packages to check
  let packagesToCheck: WorkspaceMember[];

  if (options.packages && options.packages.length > 0) {
    // Resolve named packages
    packagesToCheck = [];
    for (const name of options.packages) {
      const result = resolvePackageName(name, workspace.members);
      switch (result.kind) {
        case "found":
          if (!result.member.hasTsConfig) {
            process.stderr.write(
              `Error: Package "${result.member.name}" has no tsconfig.json.\n`,
            );
            process.exit(2);
          }
          packagesToCheck.push(result.member);
          break;
        case "ambiguous":
          process.stderr.write(
            `Error: Ambiguous package name "${result.name}". Matches:\n`,
          );
          for (const m of result.matches) {
            process.stderr.write(`  - ${m.name}\n`);
          }
          process.stderr.write("\nUse the full package name to disambiguate.\n");
          process.exit(2);
          break;  // unreachable but satisfies control flow
        case "not-found":
          process.stderr.write(
            `Error: Package "${result.name}" not found in workspace.\n`,
          );
          process.stderr.write("\nAvailable packages:\n");
          for (const available of result.available) {
            process.stderr.write(`  - ${available}\n`);
          }
          process.exit(2);
          break;  // unreachable but satisfies control flow
      }
    }
  } else {
    // Check all packages that have tsconfig.json
    packagesToCheck = workspace.members.filter((m) => m.hasTsConfig);
  }

  if (packagesToCheck.length === 0) {
    process.stderr.write("No TypeScript packages found in workspace.\n");
    process.exit(2);
  }

  // Check each package
  let totalErrors = 0;
  let packagesWithErrors = 0;
  const total = packagesToCheck.length;

  for (const member of packagesToCheck) {
    process.stderr.write(`  Checking ${member.name}...`);

    const originalCwd = process.cwd();
    process.chdir(member.dir);

    try {
      const errorCount = checkPackage(member.dir, pretty);
      if (errorCount > 0) {
        totalErrors += errorCount;
        packagesWithErrors++;
      } else {
        process.stderr.write(" ok\n");
      }
    } finally {
      process.chdir(originalCwd);
    }
  }

  // Summary
  process.stderr.write("\n");
  if (packagesWithErrors > 0) {
    process.stderr.write(
      `  ${packagesWithErrors} of ${total} package${total === 1 ? "" : "s"} had errors.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `  All ${total} package${total === 1 ? "" : "s"} passed.\n`,
  );
}

// ============================================================================
// Argument Parsing
// ============================================================================

export function parseCheckArgs(args: string[]): CheckOptions {
  const options: CheckOptions = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-p" || arg === "--package") {
      i++;
      if (i >= args.length) {
        throw new Error("Missing value for --package");
      }
      if (!options.packages) options.packages = [];
      options.packages.push(args[i]);
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--no-pretty") {
      options.pretty = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(
        `Unexpected argument: ${arg}\n\n` +
        `  "thinkwell check" type-checks the project without producing output.\n` +
        `  It does not take positional arguments.\n\n` +
        `  To check a specific workspace package, use: thinkwell check -p ${arg}`,
      );
    }
    i++;
  }

  return options;
}

// ============================================================================
// Help
// ============================================================================

export function showCheckHelp(): void {
  console.log(`
${cyanBold("thinkwell check")} - ${whiteBold("Type-check TypeScript with @JSONSchema support")}

${greenBold("Usage:")}
  ${cyanBold("thinkwell check")} ${cyan("[options]")}

${greenBold("Options:")}
  ${cyan("-p, --package")} ${dim("<name>")}   Check a specific workspace package by name
                          ${dim("(can be specified multiple times)")}
  ${cyan("--pretty")}               Enable colorized output ${dim("(default: true if TTY)")}
  ${cyan("--no-pretty")}            Disable colorized output
  ${cyan("-h, --help")}             Show this help message

${greenBold("Description:")}
  Runs the TypeScript type checker on your project without producing
  output files. Uses a custom CompilerHost that applies @JSONSchema
  namespace injection in memory, so user scripts with @JSONSchema
  types are checked correctly.

  In a workspace (pnpm or npm), all TypeScript packages are checked.
  Use ${cyan("--package")} to check specific packages by name.

${greenBold("Exit codes:")}
  ${cyanBold("0")}  No type errors
  ${cyanBold("1")}  Type errors found
  ${cyanBold("2")}  Configuration error

${greenBold("Examples:")}
  ${cyanBold("thinkwell check")}                     Check the current project
  ${cyanBold("thinkwell check")} ${cyan("-p acp")}              Check a specific workspace package
  ${cyanBold("thinkwell check")} ${cyan("-p acp -p protocol")}  Check multiple packages
  ${cyanBold("thinkwell check")} ${cyan("--no-pretty")}         Disable colorized output ${dim("(for CI)")}
`.trim() + "\n");
}
