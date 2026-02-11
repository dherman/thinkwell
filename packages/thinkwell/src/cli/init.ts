/**
 * CLI command for initializing thinkwell dependencies in an existing project.
 *
 * When a project has a package.json but is missing required dependencies
 * (thinkwell, typescript), this command adds them using the detected
 * package manager.
 *
 * @see doc/rfd/explicit-config.md for the design
 */

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import {
  checkDependencies,
  hasPackageJson,
  type DependencyCheckResult,
} from "./dependency-check.js";
import { detectPackageManager, type PackageManagerInfo } from "./package-manager.js";
import { cyan, cyanBold, greenBold, whiteBold, dim, redBold } from "./fmt.js";

// ============================================================================
// Types
// ============================================================================

interface InitOptions {
  /** Run non-interactively, accepting all defaults. */
  yes: boolean;
  /** Project directory to initialize. */
  projectDir: string;
}

interface MissingDependency {
  name: string;
  version: string;
  dev: boolean;
}

// ============================================================================
// Version Detection
// ============================================================================

/**
 * Get the version of the thinkwell CLI.
 * Used to set default dependency versions that match the CLI.
 */
function getCliVersion(): string {
  try {
    // Resolve path relative to this module
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "../../package.json");
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version || "0.5.0";
  } catch {
    return "0.5.0";
  }
}

/**
 * Get the TypeScript version bundled with thinkwell.
 * Used to set a compatible default version.
 */
function getTypescriptVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "../../package.json");
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    // Extract major.minor from the dependency spec (e.g., "^5.7.2" -> "5.7")
    const tsSpec = pkg.dependencies?.typescript || "^5.7.0";
    const match = tsSpec.match(/(\d+\.\d+)/);
    return match ? `^${match[1]}.0` : "^5.7.0";
  } catch {
    return "^5.7.0";
  }
}

// ============================================================================
// Interactive Prompts
// ============================================================================

/**
 * Prompt the user for confirmation.
 * Returns true if the user accepts (Y/y or Enter), false otherwise.
 */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      // Accept empty (Enter), 'y', or 'yes'
      resolve(normalized === "" || normalized === "y" || normalized === "yes");
    });
  });
}

// ============================================================================
// Package Installation
// ============================================================================

/**
 * Run a shell command and stream output to stdout/stderr.
 */
function runCommand(cmd: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = cmd;
    const proc = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
  });
}

/**
 * Install a package using the detected package manager.
 */
async function installPackage(
  pm: PackageManagerInfo,
  pkg: string,
  version: string,
  dev: boolean,
  cwd: string,
): Promise<void> {
  const spec = `${pkg}@${version}`;

  // Build the command based on package manager
  let cmd: string[];
  switch (pm.name) {
    case "pnpm":
      cmd = dev ? ["pnpm", "add", "-D", spec] : ["pnpm", "add", spec];
      break;
    case "yarn":
      cmd = dev ? ["yarn", "add", "-D", spec] : ["yarn", "add", spec];
      break;
    case "npm":
      cmd = dev ? ["npm", "install", "-D", spec] : ["npm", "install", spec];
      break;
  }

  console.log(`Running: ${cmd.join(" ")}`);
  await runCommand(cmd, cwd);
}

// ============================================================================
// Main Init Logic
// ============================================================================

/**
 * Determine which dependencies are missing and need to be installed.
 */
function getMissingDependencies(result: DependencyCheckResult): MissingDependency[] {
  const missing: MissingDependency[] = [];

  if (!result.thinkwell.found) {
    const cliVersion = getCliVersion();
    // Use caret range for thinkwell (e.g., "^0.5.0")
    const version = cliVersion.startsWith("^") ? cliVersion : `^${cliVersion}`;
    missing.push({ name: "thinkwell", version, dev: false });
  }

  if (!result.typescript.found) {
    missing.push({ name: "typescript", version: getTypescriptVersion(), dev: true });
  }

  return missing;
}

/**
 * Run the init command.
 */
export async function runInit(options: InitOptions): Promise<void> {
  const { yes, projectDir } = options;

  // Check if project has a package.json
  if (!hasPackageJson(projectDir)) {
    console.error(`${redBold("Error:")} No package.json found in ${projectDir}`);
    console.error("");
    console.error("This command adds dependencies to an existing project.");
    console.error("To create a new project, run:");
    console.error(`  ${cyanBold("thinkwell new")} ${cyan("<project-name>")}`);
    process.exit(2);
  }

  // Detect package manager
  const pm = detectPackageManager(projectDir);
  console.log(`Detected package manager: ${cyanBold(pm.name)}`);
  console.log("");

  // Check dependencies
  const result = await checkDependencies(projectDir);
  const missing = getMissingDependencies(result);

  if (missing.length === 0) {
    console.log(`${greenBold("✓")} All required dependencies are already installed.`);
    return;
  }

  // Show what will be installed
  console.log("Missing dependencies:");
  for (const dep of missing) {
    const devTag = dep.dev ? dim(" (devDependency)") : "";
    console.log(`  • ${cyanBold(dep.name)} ${dim(`(will add ${dep.version})`)}${devTag}`);
  }
  console.log("");

  // Prompt for confirmation in interactive mode
  if (!yes) {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (isTTY) {
      const proceed = await confirm("Proceed? [Y/n] ");
      if (!proceed) {
        console.log("Aborted.");
        process.exit(0);
      }
      console.log("");
    } else {
      // Non-TTY without --yes flag: fail with guidance
      console.error(`${redBold("Error:")} Cannot prompt for confirmation in non-interactive mode.`);
      console.error("");
      console.error("Run with --yes to proceed without confirmation:");
      console.error(`  ${cyanBold("thinkwell init --yes")}`);
      process.exit(2);
    }
  }

  // Install missing dependencies
  for (const dep of missing) {
    await installPackage(pm, dep.name, dep.version, dep.dev, projectDir);
  }

  console.log("");
  console.log(`${greenBold("✓")} Dependencies added successfully.`);
}

// ============================================================================
// Argument Parsing
// ============================================================================

/**
 * Parse command-line arguments for the init command.
 */
export function parseInitArgs(args: string[]): InitOptions {
  let yes = false;
  let projectDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--help" || arg === "-h") {
      // Handled by caller
      continue;
    } else if (!arg.startsWith("-")) {
      // Treat as project directory
      projectDir = arg.startsWith("/") ? arg : join(process.cwd(), arg);
    }
  }

  return { yes, projectDir };
}

/**
 * Show help for the init command.
 */
export function showInitHelp(): void {
  console.log(`
${cyanBold("thinkwell init")} - ${whiteBold("Add thinkwell dependencies to an existing project")}

${greenBold("Usage:")}
  ${cyanBold("thinkwell init")} ${dim("[options] [directory]")}

${greenBold("Options:")}
  ${cyan("--yes, -y")}    Add dependencies without prompting for confirmation
  ${cyan("--help, -h")}   Show this help message

${greenBold("Arguments:")}
  ${cyan("directory")}    Project directory ${dim("(default: current directory)")}

${greenBold("Description:")}
  When a project has a package.json but is missing required dependencies
  (thinkwell, typescript), this command adds them using the detected
  package manager (pnpm, yarn, or npm).

  The versions added match the CLI binary versions to ensure compatibility.

${greenBold("Examples:")}
  ${cyanBold("thinkwell init")}           Add dependencies interactively
  ${cyanBold("thinkwell init --yes")}     Add dependencies without prompting (CI-friendly)
  ${cyanBold("thinkwell init ./my-app")}  Add dependencies to ./my-app

${greenBold("To create a new project instead:")}
  ${cyanBold("thinkwell new")} ${cyan("<project-name>")}
`.trim() + "\n");
}
