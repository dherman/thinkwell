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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { styleText } from "node:util";

const cyan = (t: string) => styleText("cyan", t);
const cyanBold = (t: string) => styleText(["cyan", "bold"], t);
const greenBold = (t: string) => styleText(["green", "bold"], t);
const whiteBold = (t: string) => styleText(["white", "bold"], t);
const redBold = (t: string) => styleText(["red", "bold"], t);
const dim = (t: string) => styleText("dim", t);

export interface ShowMainHelpOptions {
  version: string;
  forceWelcome?: boolean;
}

function getWelcomeMarkerPath(): string {
  const cacheDir = process.env.THINKWELL_CACHE_DIR || join(homedir(), ".cache", "thinkwell");
  return join(cacheDir, "welcome-version");
}

function shouldAnimate(version: string, forceWelcome: boolean): boolean {
  if (forceWelcome) return true;
  try {
    const stored = readFileSync(getWelcomeMarkerPath(), "utf-8").trim();
    return stored !== version;
  } catch {
    return true;
  }
}

function recordWelcomeVersion(version: string): void {
  try {
    const markerPath = getWelcomeMarkerPath();
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, version + "\n", "utf-8");
  } catch {
    // Best-effort — if we can't write, the animation plays again next time.
  }
}

/**
 * Print the main help screen to stdout, with an optional typewriter
 * animation on the tagline when stdout is an interactive TTY.
 *
 * The animation is gated to run once per installed version. Pass
 * `forceWelcome: true` (via the undocumented `--welcome` flag) to
 * bypass version gating.
 */
export async function showMainHelp(options: ShowMainHelpOptions): Promise<void> {
  const anchor = cyanBold("thinkwell");
  const revealedText = " - agent scripting made easy";
  const pen = " ✍️  ";
  const penWithSparkle = " ✨✍️  ";
  const { version, forceWelcome = false } = options;
  const ttyOk = process.stdout.isTTY && !process.env.CI;
  const animate = ttyOk && shouldAnimate(version, forceWelcome);

  const middleHelp = `

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
`;

  const infoLineText = "For more information, visit: ";
  const infoLineUrl = "https://thinkwell.sh";
  const infoLine = `${infoLineText}${cyanBold(infoLineUrl)}`;

  if (!animate) {
    console.log(anchor + whiteBold(revealedText + penWithSparkle) + middleHelp + "\n" + infoLine);
    return;
  }

  // Helper: typewriter with ✍️ trailing cursor
  const typewrite = (
    chars: string[],
    duration: number,
    styleFn: (revealed: string) => string,
  ) =>
    new Promise<void>((resolve) => {
      const interval = duration / chars.length;
      let i = 0;
      const timer = setInterval(() => {
        i++;
        const revealed = chars.slice(0, i).join("");
        process.stdout.write(`\r\x1b[K${styleFn(revealed)}${pen}`);
        if (i >= chars.length) {
          clearInterval(timer);
          resolve();
        }
      }, interval);
    });

  // Hide cursor during animation
  process.stdout.write("\x1b[?25l");

  // Stage 1: Typewriter the tagline over 1s
  process.stdout.write(pen);
  const fullText = "thinkwell" + revealedText;
  const fullChars = [...fullText];
  await typewrite(fullChars, 1000, (revealed) =>
    revealed.length <= 9
      ? cyanBold(revealed)
      : cyanBold("thinkwell") + whiteBold(revealed.slice(9)),
  );

  // Print the middle help text statically (remove ✍️ from tagline first)
  process.stdout.write(`\r\x1b[K${anchor}${whiteBold(revealedText)}`);
  process.stdout.write(middleHelp + "\n");

  // Stage 2: Typewriter the "For more information" line with 📖 prefix over 1s
  const infoChars = [...(infoLineText + infoLineUrl)];
  await new Promise<void>((resolve) => {
    const interval = 1000 / infoChars.length;
    let i = 0;
    const timer = setInterval(() => {
      i++;
      const revealed = infoChars.slice(0, i).join("");
      const styled = revealed.length <= infoLineText.length
        ? revealed
        : infoLineText + cyanBold(revealed.slice(infoLineText.length));
      process.stdout.write(`\r\x1b[K📖 ${styled}${pen}`);
      if (i >= infoChars.length) {
        clearInterval(timer);
        resolve();
      }
    }, interval);
  });

  // Remove pen, keep 📖
  process.stdout.write(`\r\x1b[K📖 ${infoLine}`);

  // Stage 3: Pen travels up vertically in the same column to the tagline
  //
  // The pen sits just after "📖 For more information, visit: https://thinkwell.sh"
  // "📖 " = 3 visible cols, + infoLineText (29) + infoLineUrl (20) = 52 cols.
  // The pen emoji occupies col 53+. On each intermediate line, we save the
  // plain character at col 53 (all description text at that column is unstyled
  // ASCII), write the pen over it, then restore it before moving up.
  const penCol = 53;
  const goCol = `\x1b[${penCol}G`;

  // Strip ANSI escape codes to get visible text
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  // Build array of plain chars at penCol for each line (bottom to top)
  const helpLines = (middleHelp + "\n").split("\n");
  // helpLines[0] corresponds to the line just below the tagline (bottom of array = closest to info line)
  const charAtCol = helpLines.map((line) => {
    const plain = stripAnsi(line);
    // penCol is 1-based, string index is 0-based
    return plain[penCol - 1] ?? " ";
  });

  // Number of \n characters between tagline and info line
  const linesFromInfoToTagline = helpLines.length - 1;
  const stepDelay = 40; // ms per line

  // Animate pen traveling upward — save/restore single char at fixed col
  for (let linesUp = 1; linesUp < linesFromInfoToTagline; linesUp++) {
    // Draw pen at fixed column on this line
    process.stdout.write(`\x1b[${linesUp}A${goCol}✍️\x1b[${linesUp}B\r`);
    await new Promise((r) => setTimeout(r, stepDelay));

    // Restore original character at that column
    const originalChar = charAtCol[helpLines.length - 1 - linesUp];
    process.stdout.write(`\x1b[${linesUp}A${goCol}${originalChar}\x1b[${linesUp}B\r`);
  }

  // Pen arrives at tagline — slide left from col 53 to final position
  // The tagline "thinkwell - agent scripting made easy" is 38 visible chars.
  // The sparkle goes at col 39, pen (✍️) at col 41 (after "✨").
  // But first the pen slides from col 53 to col 40 (one past the sparkle slot).
  const taglineRow = linesFromInfoToTagline;
  const sparkleCol = 39;

  for (let col = penCol; col > sparkleCol; col--) {
    process.stdout.write(`\x1b[${taglineRow}A\x1b[${col}G✍️\x1b[${taglineRow}B\r`);
    await new Promise((r) => setTimeout(r, stepDelay));

    // Erase pen (it's over spaces on the tagline)
    process.stdout.write(`\x1b[${taglineRow}A\x1b[${col}G \x1b[${taglineRow}B\r`);
  }

  // Write sparkle + pen at final position
  process.stdout.write(`\x1b[${taglineRow}A\r\x1b[K${anchor}${whiteBold(revealedText + penWithSparkle)}\x1b[${taglineRow}B\r`);

  // Record that this version's welcome animation has been shown
  recordWelcomeVersion(version);

  // Show cursor
  process.stdout.write("\x1b[?25h\n");
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
 * Check if args contain the undocumented --welcome flag.
 */
export function hasWelcomeFlag(args: string[]): boolean {
  return args.includes("--welcome");
}

/**
 * Format an error message with a red bold "Error:" prefix.
 * Use with console.error(): `console.error(fmtError("something went wrong"))`
 */
export function fmtError(message: string): string {
  return `${redBold("Error:")} ${message}`;
}
