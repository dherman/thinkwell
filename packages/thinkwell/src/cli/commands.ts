/**
 * Shared CLI commands and help text.
 *
 * This module is the single source of truth for help screens and
 * utility functions shared between the two CLI entry points:
 *   - src/cli/main.cjs (compiled binary, CommonJS)
 *   - bin/thinkwell (npm distribution, ESM)
 *
 * IMPORTANT: This module must remain self-contained (no local imports)
 * because main.cjs loads it via require() inside the pkg snapshot,
 * where ESM import resolution for sibling modules fails.
 */

import { styleText } from "node:util";

const cyan = (t: string) => styleText("cyan", t);
const cyanBold = (t: string) => styleText(["cyan", "bold"], t);
const greenBold = (t: string) => styleText(["green", "bold"], t);
const whiteBold = (t: string) => styleText(["white", "bold"], t);
const redBold = (t: string) => styleText(["red", "bold"], t);
const dim = (t: string) => styleText("dim", t);

/**
 * Print the main help screen to stdout.
 */
export function showMainHelp(): void {
  console.log(`
${cyanBold("thinkwell")} - ${whiteBold("agent scripting made easy ✨🖋️")}

${greenBold("Usage:")}
  ${cyanBold("thinkwell")} ${dim("<script.ts> [args...]")}     Run a TypeScript script
  ${cyanBold("thinkwell run")} ${dim("<script.ts> [args...]")} Explicit run command
  ${cyanBold("thinkwell init")}                      Initialize thinkwell in current directory
  ${cyanBold("thinkwell new")} ${dim("<project-name>")}        Create a new project in a new directory
  ${cyanBold("thinkwell check")}                     Type-check project ${dim("(no output files)")}
  ${cyanBold("thinkwell build")}                     Compile project with @JSONSchema support
  ${cyanBold("thinkwell bundle")} ${dim("<script.ts>")}        Compile to standalone executable
  ${cyanBold("thinkwell")} ${cyan("--help")}                    Show this help message
  ${cyanBold("thinkwell")} ${cyan("--version")}                 Show version

${greenBold("Example:")}
  ${cyanBold("thinkwell")} ${cyan("my-agent.ts")}

For more information, visit: ${cyanBold("https://thinkwell.sh")}
`.trim() + "\n");
}

/**
 * Print the "no script provided" error and exit.
 */
export function showNoScriptError(): never {
  console.error(`${redBold("Error:")} No script provided.`);
  console.error("");
  console.error("Usage: thinkwell <script.ts> [args...]");
  process.exit(1);
}

/**
 * Check if args contain a help flag (--help or -h).
 */
export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/**
 * Format an error message with a red bold "Error:" prefix.
 * Use with console.error(): `console.error(fmtError("something went wrong"))`
 */
export function fmtError(message: string): string {
  return `${redBold("Error:")} ${message}`;
}
