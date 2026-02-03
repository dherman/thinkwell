#!/usr/bin/env node
/**
 * Test script to see if esbuild can be loaded from within a pkg binary.
 *
 * esbuild uses platform-specific native binaries (@esbuild/darwin-arm64, etc.)
 * which may or may not work when bundled with pkg.
 */

const { build } = require('esbuild');
const { writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

// Simple test: try to bundle a small piece of code
const testCode = `
export function greet(name) {
  return "Hello, " + name + "!";
}
`;

async function main() {
  console.log("Testing esbuild from pkg binary...\n");

  // Check if we're running from a pkg binary
  const isPkg = process.pkg !== undefined;
  console.log(`Running from pkg binary: ${isPkg}`);
  console.log(`Process executable: ${process.execPath}`);
  console.log(`__dirname: ${__dirname}`);
  console.log("");

  try {
    // Create a temp directory for the test
    const tempDir = isPkg ? '/tmp/pkg-esbuild-test' : join(__dirname, 'temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    // Write test source file
    const inputFile = join(tempDir, 'input.js');
    const outputFile = join(tempDir, 'output.js');
    writeFileSync(inputFile, testCode);

    console.log("Attempting to bundle with esbuild...");

    // Try to use esbuild
    const result = await build({
      entryPoints: [inputFile],
      bundle: true,
      format: 'esm',
      outfile: outputFile,
      write: true,
      logLevel: 'info',
    });

    console.log("\nSuccess! esbuild works from pkg binary.");
    console.log(`Output written to: ${outputFile}`);
    console.log(`Warnings: ${result.warnings.length}`);
    console.log(`Errors: ${result.errors.length}`);

  } catch (error) {
    console.error("\nFailed to use esbuild:");
    console.error(`  ${error.message}`);
    if (error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack.split('\n').slice(1, 5).join('\n'));
    }
    process.exit(1);
  }
}

main();
