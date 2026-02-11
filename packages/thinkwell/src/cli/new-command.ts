/**
 * CLI command for creating a new thinkwell project in a new directory.
 *
 * This command scaffolds a new project with the necessary configuration
 * and example files.
 *
 * Following Cargo's design: "new" creates a new directory, while "init"
 * modifies existing state in the current directory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cyan, cyanBold, greenBold, whiteBold, dim, redBold } from "./fmt.js";

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
${cyanBold("thinkwell new")} - ${whiteBold("Create a new thinkwell project in a new directory")}

${greenBold("Usage:")}
  ${cyanBold("thinkwell new")} ${cyan("<project-name>")}

${greenBold("Arguments:")}
  ${cyan("project-name")}    Name of the project directory ${dim("(required)")}

${greenBold("Examples:")}
  ${cyanBold("thinkwell new")} ${cyan("my-agent")}      Create a new project in ./my-agent

${greenBold("This command creates:")}
  - package.json with thinkwell dependency
  - tsconfig.json for TypeScript
  - src/main.ts with example agent code
  - .gitignore
  - .env.example

${greenBold("To initialize the current directory instead:")}
  ${cyanBold("thinkwell init")}
`);
}

export async function runNew(args: string[]): Promise<void> {
  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  // Get project name from args - required
  const projectArg = args.find((arg) => !arg.startsWith("-"));

  if (!projectArg) {
    console.error(`${redBold("Error:")} Project name is required.`);
    console.error("");
    console.error("Usage:");
    console.error(`  ${cyanBold("thinkwell new")} ${cyan("<project-name>")}`);
    console.error("");
    console.error("To initialize the current directory instead:");
    console.error(`  ${cyanBold("thinkwell init")}`);
    process.exit(1);
  }

  const targetDir = resolve(projectArg);
  const name = projectArg;

  // Check if directory exists and is not empty
  if (existsSync(targetDir)) {
    const files = ["package.json", "tsconfig.json", "src/main.ts"];
    const existingFiles = files.filter((f) => existsSync(join(targetDir, f)));

    if (existingFiles.length > 0) {
      console.error(`${redBold("Error:")} Directory already contains project files:`);
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
  console.log(`  cd ${projectArg}`);
  console.log("  npm install        # or: pnpm install");
  console.log("  cp .env.example .env");
  console.log("  # Edit .env to configure your agent");
  console.log("  thinkwell src/main.ts");
  console.log("");
}
