/**
 * CLI command for initializing a new thinkwell project.
 *
 * This command scaffolds a new project with the necessary configuration
 * and example files. It does not require Bun to run.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

interface InitOptions {
  name: string;
  targetDir: string;
}

const PACKAGE_JSON_TEMPLATE = (name: string) => `{
  "name": "${name}",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "thinkwell src/main.ts",
    "types": "thinkwell types src"
  },
  "dependencies": {
    "thinkwell": "^0.2.0"
  }
}
`;

const MAIN_TS_TEMPLATE = `import { open } from "thinkwell";

/**
 * A greeting response from the agent.
 * @JSONSchema
 */
export interface Greeting {
  message: string;
}

async function main() {
  const agent = await open('claude');

  // Ask the agent to generate a structured greeting
  const greeting = await agent
    .think(Greeting)
    .text("Say hello and introduce yourself briefly.")
    .run();

  console.log(greeting.message);
}

main().catch(console.error);
`;

const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
`;

const GITIGNORE_TEMPLATE = `node_modules/
dist/
*.thinkwell.d.ts
.env
`;

const ENV_EXAMPLE_TEMPLATE = `# Configure your agent command
# Example for Claude Code:
# THINKWELL_AGENT_CMD=claude --dangerously-skip-permissions
`;

function createProject(options: InitOptions): void {
  const { name, targetDir } = options;

  // Create directories
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, "src"), { recursive: true });

  // Write files
  writeFileSync(join(targetDir, "package.json"), PACKAGE_JSON_TEMPLATE(name));
  writeFileSync(join(targetDir, "src/main.ts"), MAIN_TS_TEMPLATE);
  writeFileSync(join(targetDir, "tsconfig.json"), TSCONFIG_TEMPLATE);
  writeFileSync(join(targetDir, ".gitignore"), GITIGNORE_TEMPLATE);
  writeFileSync(join(targetDir, ".env.example"), ENV_EXAMPLE_TEMPLATE);
}

function showHelp(): void {
  console.log(`
thinkwell init - Initialize a new thinkwell project

Usage:
  thinkwell init [project-name]

Arguments:
  project-name    Name of the project directory (default: current directory)

Examples:
  thinkwell init my-agent      Create a new project in ./my-agent
  thinkwell init               Initialize in the current directory

This command creates:
  - package.json with thinkwell dependency
  - tsconfig.json for TypeScript
  - src/main.ts with example agent code
  - .gitignore
  - .env.example
`);
}

export async function runInit(args: string[]): Promise<void> {
  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  // Get project name from args or use current directory
  const projectArg = args.find((arg) => !arg.startsWith("-"));
  const targetDir = projectArg ? resolve(projectArg) : process.cwd();
  const name = projectArg || basename(process.cwd());

  // Check if directory exists and is not empty
  if (existsSync(targetDir)) {
    const files = ["package.json", "tsconfig.json", "src/main.ts"];
    const existingFiles = files.filter((f) => existsSync(join(targetDir, f)));

    if (existingFiles.length > 0) {
      console.error(`Error: Directory already contains project files:`);
      for (const file of existingFiles) {
        console.error(`  - ${file}`);
      }
      console.error("");
      console.error("Use a different directory or remove existing files.");
      process.exit(1);
    }
  }

  console.log(`Creating thinkwell project in ${targetDir}...`);
  console.log("");

  createProject({ name, targetDir });

  console.log("Created files:");
  console.log("  - package.json");
  console.log("  - tsconfig.json");
  console.log("  - src/main.ts");
  console.log("  - .gitignore");
  console.log("  - .env.example");
  console.log("");
  console.log("Next steps:");
  console.log("");
  if (projectArg) {
    console.log(`  cd ${projectArg}`);
  }
  console.log("  npm install        # or: bun install");
  console.log("  cp .env.example .env");
  console.log("  # Edit .env to configure your agent");
  console.log("  thinkwell src/main.ts");
  console.log("");
}
