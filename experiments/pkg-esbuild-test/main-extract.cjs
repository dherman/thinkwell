#!/usr/bin/env node
/**
 * Test script to see if esbuild can work from pkg by extracting the binary.
 *
 * Strategy: Extract the esbuild binary from the pkg snapshot to a temp location
 * on disk, then set ESBUILD_BINARY_PATH to point to it.
 */

const { copyFileSync, chmodSync, mkdirSync, existsSync, readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir, homedir } = require('node:os');

// Simple test: try to bundle a small piece of code
const testCode = `
export function greet(name) {
  return "Hello, " + name + "!";
}
`;

async function main() {
  console.log("Testing esbuild from pkg binary with extraction...\n");

  // Check if we're running from a pkg binary
  const isPkg = process.pkg !== undefined;
  console.log(`Running from pkg binary: ${isPkg}`);
  console.log(`Process executable: ${process.execPath}`);
  console.log(`__dirname: ${__dirname}`);
  console.log("");

  if (isPkg) {
    // Extract esbuild binary to a cache directory
    const cacheDir = join(homedir(), '.cache', 'thinkwell-esbuild');
    const esbuildBinaryDest = join(cacheDir, 'esbuild');

    console.log(`Extracting esbuild to: ${esbuildBinaryDest}`);

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    // The esbuild binary is at this path inside the snapshot
    const esbuildBinarySrc = join(__dirname, 'node_modules/@esbuild/darwin-arm64/bin/esbuild');

    console.log(`Source path: ${esbuildBinarySrc}`);

    try {
      // Read the binary from the snapshot and write to real filesystem
      const binaryContent = readFileSync(esbuildBinarySrc);
      require('node:fs').writeFileSync(esbuildBinaryDest, binaryContent);
      chmodSync(esbuildBinaryDest, 0o755);
      console.log(`Extracted successfully!`);

      // Tell esbuild where to find the binary
      process.env.ESBUILD_BINARY_PATH = esbuildBinaryDest;
      console.log(`Set ESBUILD_BINARY_PATH=${esbuildBinaryDest}`);
    } catch (e) {
      console.error(`Failed to extract: ${e.message}`);
      process.exit(1);
    }
  }

  console.log("");

  // Now try to use esbuild
  // Clear require cache to ensure esbuild re-evaluates ESBUILD_BINARY_PATH
  delete require.cache[require.resolve('esbuild')];
  const { build } = require('esbuild');

  try {
    // Create a temp directory for the test
    const tempDir = '/tmp/pkg-esbuild-test';
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    // Write test source file
    const inputFile = join(tempDir, 'input.js');
    const outputFile = join(tempDir, 'output.js');
    require('node:fs').writeFileSync(inputFile, testCode);

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

    console.log("\nSuccess! esbuild works from pkg binary with extraction.");
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
