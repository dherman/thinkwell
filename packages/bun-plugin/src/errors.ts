/**
 * Consolidated error module for the Thinkwell Bun plugin.
 *
 * Errors use a Rust/Cargo-style diagnostic format:
 * - Error code and summary on the first line
 * - Source location with file path and line number
 * - Quoted source context with line numbers
 * - Carets pointing to the relevant code
 * - A help line with actionable fix suggestions
 *
 * The plugin uses fail-fast semantics: errors halt processing immediately
 * rather than logging warnings and continuing with partial results.
 */

// =============================================================================
// ANSI Color Utilities
// =============================================================================

const isTTY = process.stdout.isTTY ?? false;

/** ANSI escape codes for terminal colors */
const ansi = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  red: isTTY ? "\x1b[31m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  blue: isTTY ? "\x1b[34m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  white: isTTY ? "\x1b[37m" : "",
  brightBlue: isTTY ? "\x1b[94m" : "",
};

/** Apply color and style to text */
function style(text: string, ...styles: string[]): string {
  if (!isTTY) return text;
  return styles.join("") + text + ansi.reset;
}

// =============================================================================
// Source Location
// =============================================================================

/**
 * Source location information for error reporting.
 */
export interface SourceLocation {
  /** The file path */
  filePath: string;
  /** 1-based line number */
  line: number;
  /** 1-based column number */
  column: number;
  /** The source code content (for extracting context) */
  sourceCode?: string;
  /** Length of the underlined region */
  length?: number;
}

// =============================================================================
// Error Codes
// =============================================================================

/** Error codes for all Thinkwell errors */
export const ErrorCode = {
  // Schema generation errors (E0001-E0009)
  TYPE_NOT_FOUND: "E0001",
  CIRCULAR_REFERENCE: "E0002",
  UNRESOLVED_GENERIC: "E0003",
  FUNCTION_TYPE: "E0004",
  SYMBOL_TYPE: "E0005",
  BIGINT_TYPE: "E0006",
  CONDITIONAL_TYPE: "E0007",
  MAPPED_TYPE: "E0008",
  TEMPLATE_LITERAL: "E0009",

  // Infrastructure errors (E0010-E0014)
  TYPESCRIPT_PROGRAM: "E0010",
  FILE_READ: "E0011",
  FILE_WRITE: "E0012",
  TRANSPILATION: "E0013",
  UNKNOWN_MODULE: "E0014",

  // Declaration errors (E0015)
  DECLARATION_GENERATION: "E0015",

  // Unknown/default
  UNKNOWN: "E9999",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// =============================================================================
// Diagnostic Formatting
// =============================================================================

/**
 * Format a diagnostic message in Rust/Cargo style.
 */
function formatDiagnostic(options: {
  code: ErrorCodeType;
  summary: string;
  location?: SourceLocation;
  help?: string;
}): string {
  const lines: string[] = [];

  // Line 1: error[E0001]: summary message
  const errorLabel = style(`error[${options.code}]`, ansi.red, ansi.bold);
  const summaryText = style(options.summary, ansi.white, ansi.bold);
  lines.push(`${errorLabel}: ${summaryText}`);

  // Line 2: --> file:line:column
  if (options.location) {
    const loc = options.location;
    const arrow = style(" -->", ansi.brightBlue, ansi.bold);
    const fileLoc = `${loc.filePath}:${loc.line}:${loc.column}`;
    lines.push(`${arrow} ${fileLoc}`);

    // Source context
    if (loc.sourceCode) {
      const sourceLines = loc.sourceCode.split("\n");
      const errorLine = loc.line;

      // Calculate gutter width based on max line number we'll show
      const maxLineNum = Math.min(errorLine + 1, sourceLines.length);
      const gutterWidth = String(maxLineNum).length;

      // Empty gutter line
      const emptyGutter = style(" ".repeat(gutterWidth) + " |", ansi.brightBlue, ansi.bold);
      lines.push(emptyGutter);

      // Show 1-2 lines before the error line for context
      const startLine = Math.max(1, errorLine - 1);
      for (let i = startLine; i <= errorLine; i++) {
        const lineNum = String(i).padStart(gutterWidth, " ");
        const gutter = style(`${lineNum} |`, ansi.brightBlue, ansi.bold);
        const content = sourceLines[i - 1] ?? "";
        lines.push(`${gutter} ${content}`);
      }

      // Caret line pointing to the error
      const caretGutter = style(" ".repeat(gutterWidth) + " |", ansi.brightBlue, ansi.bold);
      const padding = " ".repeat(loc.column - 1);
      const caretLength = loc.length ?? 1;
      const carets = style("^".repeat(caretLength), ansi.yellow, ansi.bold);
      lines.push(`${caretGutter} ${padding}${carets}`);

      // Empty line after carets
      lines.push(emptyGutter);
    }
  }

  // Help line
  if (options.help) {
    const helpLabel = style("help", ansi.green, ansi.bold);
    // Replace backtick-quoted code with cyan
    const helpText = options.help.replace(/`([^`]+)`/g, (_, code) => {
      return style(code, ansi.cyan);
    });
    lines.push(`${helpLabel}: ${helpText}`);
  }

  return lines.join("\n");
}

// =============================================================================
// Base Error Class
// =============================================================================

/**
 * Base class for all Thinkwell plugin errors.
 *
 * Provides Rust/Cargo-style diagnostic formatting.
 */
export class ThinkwellError extends Error {
  /** The error code (e.g., E0001) */
  readonly code: ErrorCodeType;
  /** Brief description of what went wrong */
  readonly summary: string;
  /** Actionable advice for resolving the error */
  readonly help: string;
  /** Source location information */
  readonly location?: SourceLocation;

  constructor(options: {
    code: ErrorCodeType;
    summary: string;
    help: string;
    location?: SourceLocation;
    cause?: unknown;
  }) {
    const message = formatDiagnostic({
      code: options.code,
      summary: options.summary,
      location: options.location,
      help: options.help,
    });
    super(message, { cause: options.cause });
    this.name = "ThinkwellError";
    this.code = options.code;
    this.summary = options.summary;
    this.help = options.help;
    this.location = options.location;
  }
}

// =============================================================================
// Schema Generation Errors
// =============================================================================

/**
 * Analyze a schema generation error to determine the error code and help text.
 */
function analyzeSchemaError(
  typeName: string,
  errorMessage: string
): { code: ErrorCodeType; summary: string; help: string } {
  const lowerMessage = errorMessage.toLowerCase();

  // Type not found - check first since it's common
  if (
    lowerMessage.includes("no root type") ||
    lowerMessage.includes("not found") ||
    lowerMessage.includes("cannot find") ||
    lowerMessage.includes("unknown type")
  ) {
    return {
      code: ErrorCode.TYPE_NOT_FOUND,
      summary: `type \`${typeName}\` not found`,
      help: `ensure the type is exported: \`export interface ${typeName}\``,
    };
  }

  // Circular reference
  if (
    lowerMessage.includes("circular") ||
    lowerMessage.includes("cyclic") ||
    lowerMessage.includes("infinite")
  ) {
    return {
      code: ErrorCode.CIRCULAR_REFERENCE,
      summary: `type \`${typeName}\` has a circular reference`,
      help: "break the cycle with optional properties or restructure the type",
    };
  }

  // Generic type
  if (
    lowerMessage.includes("generic") ||
    lowerMessage.includes("type parameter") ||
    lowerMessage.includes("type argument")
  ) {
    return {
      code: ErrorCode.UNRESOLVED_GENERIC,
      summary: `type \`${typeName}\` has unresolved generic parameters`,
      help: "use concrete types: `type Concrete = Generic<string>`",
    };
  }

  // Function types
  if (
    lowerMessage.includes("function type") ||
    lowerMessage.includes("callable signature")
  ) {
    return {
      code: ErrorCode.FUNCTION_TYPE,
      summary: `type \`${typeName}\` contains function types`,
      help: "remove function properties - JSON Schema cannot represent functions",
    };
  }

  // Symbol types
  if (lowerMessage.includes("symbol")) {
    return {
      code: ErrorCode.SYMBOL_TYPE,
      summary: `type \`${typeName}\` contains symbol types`,
      help: "use string keys instead of symbols",
    };
  }

  // BigInt types
  if (lowerMessage.includes("bigint")) {
    return {
      code: ErrorCode.BIGINT_TYPE,
      summary: `type \`${typeName}\` contains BigInt`,
      help: "use `number` for small integers or `string` for large values",
    };
  }

  // Conditional types
  if (lowerMessage.includes("conditional") || lowerMessage.includes("extends")) {
    return {
      code: ErrorCode.CONDITIONAL_TYPE,
      summary: `type \`${typeName}\` uses conditional types`,
      help: "replace with concrete union types",
    };
  }

  // Mapped types
  if (lowerMessage.includes("mapped") || lowerMessage.includes("index signature")) {
    return {
      code: ErrorCode.MAPPED_TYPE,
      summary: `type \`${typeName}\` uses complex mapped types`,
      help: "use explicit property definitions instead",
    };
  }

  // Template literal types
  if (lowerMessage.includes("template") || lowerMessage.includes("literal type")) {
    return {
      code: ErrorCode.TEMPLATE_LITERAL,
      summary: `type \`${typeName}\` uses template literal types`,
      help: "use an explicit union of string literals",
    };
  }

  // Default case
  return {
    code: ErrorCode.UNKNOWN,
    summary: `failed to generate schema for type \`${typeName}\``,
    help: "ensure the type uses only JSON-compatible features",
  };
}

/**
 * Error thrown when ts-json-schema-generator fails to generate a schema.
 */
export class SchemaGenerationError extends ThinkwellError {
  /** The name of the type that failed */
  readonly typeName: string;
  /** The original error message */
  readonly originalMessage: string;

  constructor(options: {
    typeName: string;
    filePath: string;
    sourceCode?: string;
    line?: number;
    column?: number;
    length?: number;
    cause: unknown;
  }) {
    const originalMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);

    const { code, summary, help } = analyzeSchemaError(
      options.typeName,
      originalMessage
    );

    const location: SourceLocation | undefined =
      options.line !== undefined
        ? {
            filePath: options.filePath,
            line: options.line,
            column: options.column ?? 1,
            sourceCode: options.sourceCode,
            length: options.length,
          }
        : undefined;

    super({ code, summary, help, location, cause: options.cause });
    this.name = "SchemaGenerationError";
    this.typeName = options.typeName;
    this.originalMessage = originalMessage;
  }
}

// =============================================================================
// TypeScript Program Errors
// =============================================================================

/**
 * Error thrown when creating a TypeScript program fails.
 */
export class TypeScriptProgramError extends ThinkwellError {
  readonly tsconfigPath?: string;

  constructor(options: { tsconfigPath?: string; filePath: string; cause: unknown }) {
    const originalMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);

    let summary: string;
    let help: string;

    const lowerMessage = originalMessage.toLowerCase();
    if (lowerMessage.includes("tsconfig") || lowerMessage.includes("config")) {
      summary = `failed to parse tsconfig.json`;
      help = "check that tsconfig.json is valid JSON with correct options";
    } else if (lowerMessage.includes("module") || lowerMessage.includes("resolution")) {
      summary = "TypeScript module resolution failed";
      help = "ensure all imports are installed and paths are correct";
    } else {
      summary = "failed to create TypeScript program";
      help = "check tsconfig.json and ensure all files are valid TypeScript";
    }

    super({
      code: ErrorCode.TYPESCRIPT_PROGRAM,
      summary,
      help,
      location: {
        filePath: options.tsconfigPath ?? options.filePath,
        line: 1,
        column: 1,
      },
      cause: options.cause,
    });
    this.name = "TypeScriptProgramError";
    this.tsconfigPath = options.tsconfigPath;
  }
}

// =============================================================================
// File I/O Errors
// =============================================================================

/**
 * Error thrown when reading a file fails.
 */
export class FileReadError extends ThinkwellError {
  constructor(options: { filePath: string; cause: unknown }) {
    const originalMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);

    let summary: string;
    let help: string;
    const lowerMessage = originalMessage.toLowerCase();

    if (lowerMessage.includes("enoent") || lowerMessage.includes("no such file")) {
      summary = "file not found";
      help = "check that the file path is correct";
    } else if (lowerMessage.includes("eacces") || lowerMessage.includes("permission")) {
      summary = "permission denied";
      help = "check file permissions";
    } else if (lowerMessage.includes("eisdir")) {
      summary = "path is a directory";
      help = "provide a path to a file, not a directory";
    } else {
      summary = "failed to read file";
      help = "check that the file exists and is readable";
    }

    super({
      code: ErrorCode.FILE_READ,
      summary,
      help,
      location: { filePath: options.filePath, line: 1, column: 1 },
      cause: options.cause,
    });
    this.name = "FileReadError";
  }
}

/**
 * Error thrown when writing a file fails.
 */
export class FileWriteError extends ThinkwellError {
  constructor(options: { filePath: string; cause: unknown }) {
    const originalMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);

    let summary: string;
    let help: string;
    const lowerMessage = originalMessage.toLowerCase();

    if (lowerMessage.includes("eacces") || lowerMessage.includes("permission")) {
      summary = "permission denied";
      help = "check directory permissions";
    } else if (lowerMessage.includes("enospc")) {
      summary = "no disk space";
      help = "free up disk space and try again";
    } else if (lowerMessage.includes("erofs")) {
      summary = "read-only filesystem";
      help = "check filesystem mount options";
    } else {
      summary = "failed to write file";
      help = "check permissions and disk space";
    }

    super({
      code: ErrorCode.FILE_WRITE,
      summary,
      help,
      location: { filePath: options.filePath, line: 1, column: 1 },
      cause: options.cause,
    });
    this.name = "FileWriteError";
  }
}

// =============================================================================
// Transpilation Errors
// =============================================================================

/**
 * Error thrown when TypeScript transpilation fails.
 */
export class TranspilationError extends ThinkwellError {
  constructor(options: {
    filePath: string;
    line?: number;
    column?: number;
    sourceCode?: string;
    cause: unknown;
  }) {
    const originalMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);

    super({
      code: ErrorCode.TRANSPILATION,
      summary: "syntax error",
      help: `fix the syntax error: ${originalMessage}`,
      location: {
        filePath: options.filePath,
        line: options.line ?? 1,
        column: options.column ?? 1,
        sourceCode: options.sourceCode,
      },
      cause: options.cause,
    });
    this.name = "TranspilationError";
  }
}

// =============================================================================
// Module Resolution Errors
// =============================================================================

/**
 * Error thrown when a thinkwell:* module cannot be resolved.
 */
export class UnknownModuleError extends ThinkwellError {
  readonly moduleName: string;
  readonly availableModules: string[];
  readonly importer?: string;

  constructor(options: {
    moduleName: string;
    availableModules: string[];
    importer?: string;
    line?: number;
    column?: number;
    sourceCode?: string;
  }) {
    const available = options.availableModules.join(", ");

    super({
      code: ErrorCode.UNKNOWN_MODULE,
      summary: `unknown module "${options.moduleName}"`,
      help: `available modules: ${available}`,
      location: options.importer
        ? {
            filePath: options.importer,
            line: options.line ?? 1,
            column: options.column ?? 1,
            sourceCode: options.sourceCode,
          }
        : undefined,
      cause: undefined,
    });
    this.name = "UnknownModuleError";
    this.moduleName = options.moduleName;
    this.availableModules = options.availableModules;
    this.importer = options.importer;
  }
}

// =============================================================================
// Declaration Generation Errors
// =============================================================================

/**
 * Error thrown when generating a declaration file fails.
 */
export class DeclarationGenerationError extends ThinkwellError {
  constructor(options: { sourceFile: string; cause: unknown }) {
    const originalMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);

    super({
      code: ErrorCode.DECLARATION_GENERATION,
      summary: "failed to generate declaration file",
      help: `check that the file is valid TypeScript: ${originalMessage}`,
      location: { filePath: options.sourceFile, line: 1, column: 1 },
      cause: options.cause,
    });
    this.name = "DeclarationGenerationError";
  }
}

// =============================================================================
// Global Error Handler
// =============================================================================

/**
 * Register a global uncaught exception handler that formats ThinkwellError
 * instances cleanly without Bun's verbose default output.
 *
 * This handler:
 * - Catches ThinkwellError and its subclasses
 * - Prints only the formatted diagnostic message (no stack traces or property dumps)
 * - Exits with code 1 for error cases
 * - Falls back to Bun's default handling for non-Thinkwell errors
 */
function registerErrorHandler(): void {
  // Only register once
  if ((globalThis as Record<string, unknown>).__thinkwellErrorHandlerRegistered) {
    return;
  }
  (globalThis as Record<string, unknown>).__thinkwellErrorHandlerRegistered = true;

  process.on("uncaughtException", (error: Error) => {
    // Check if this is a ThinkwellError or one of its subclasses
    if (error instanceof ThinkwellError) {
      // Print just our formatted diagnostic message
      console.error(error.message);
      process.exit(1);
    }

    // For non-Thinkwell errors, print the error and exit
    // (we can't re-throw as that would cause an infinite loop)
    console.error(error);
    process.exit(1);
  });
}

// Register the error handler when this module loads
registerErrorHandler();
