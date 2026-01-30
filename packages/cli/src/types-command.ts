/**
 * CLI command for generating declaration files.
 *
 * This script is invoked by the thinkwell CLI when the user runs
 * `thinkwell types` or `thinkwell types --watch`.
 */

import {
  generateDeclarations,
  watchDeclarations,
} from "@thinkwell/bun-plugin";

async function main() {
  const args = process.argv.slice(2);

  const watchMode = args.includes("--watch") || args.includes("-w");
  const dirArg = args.find((arg) => !arg.startsWith("-"));
  const rootDir = dirArg ?? process.cwd();

  if (watchMode) {
    console.log(`Watching for changes in ${rootDir}...`);
    console.log("Press Ctrl+C to stop.\n");

    const watcher = watchDeclarations({
      rootDir,
      onWrite: (source, decl) => {
        console.log(`✓ ${decl}`);
      },
      onRemove: (source, decl) => {
        console.log(`✗ ${decl} (removed)`);
      },
      onError: (error, source) => {
        console.error(`Error processing ${source}: ${error.message}`);
      },
    });

    // Initial generation
    console.log("Generating initial declarations...\n");
    await generateDeclarations({
      rootDir,
      onWrite: (source, decl) => {
        console.log(`✓ ${decl}`);
      },
      onError: (error, source) => {
        console.error(`Error processing ${source}: ${error.message}`);
      },
    });

    console.log("\nWatching for changes...\n");

    // Keep process alive
    process.on("SIGINT", () => {
      watcher.stop();
      console.log("\nStopped watching.");
      process.exit(0);
    });

    // Prevent the process from exiting
    await new Promise(() => {});
  } else {
    console.log(`Generating declarations in ${rootDir}...\n`);

    const generated = await generateDeclarations({
      rootDir,
      onWrite: (source, decl) => {
        console.log(`✓ ${decl}`);
      },
      onError: (error, source) => {
        console.error(`Error processing ${source}: ${error.message}`);
      },
    });

    if (generated.length === 0) {
      console.log("No @JSONSchema types found.");
    } else {
      console.log(`\nGenerated ${generated.length} declaration file(s).`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
