#!/usr/bin/env tsx
/**
 * Pre-bundle thinkwell packages for pkg binary.
 *
 * pkg struggles with ESM modules because its module resolution doesn't
 * properly handle ESM import statements inside the /snapshot/ virtual filesystem.
 *
 * This script uses esbuild to bundle the thinkwell packages into CJS format,
 * which pkg can then include and resolve correctly.
 *
 * Output:
 *   dist-pkg/thinkwell.cjs      - bundled thinkwell package
 *   dist-pkg/acp.cjs            - bundled @thinkwell/acp package
 *   dist-pkg/protocol.cjs       - bundled @thinkwell/protocol package
 *   dist-pkg/cli-loader.cjs     - bundled CLI loader (includes schema processing)
 */

import { build } from "esbuild";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(ROOT_DIR, "dist-pkg");

// Packages to bundle
const PACKAGES = [
  {
    name: "thinkwell",
    entryPoint: resolve(ROOT_DIR, "dist/index.js"),
    output: "thinkwell.cjs",
  },
  {
    name: "@thinkwell/acp",
    entryPoint: resolve(ROOT_DIR, "../acp/dist/index.js"),
    output: "acp.cjs",
  },
  {
    name: "@thinkwell/protocol",
    entryPoint: resolve(ROOT_DIR, "../protocol/dist/index.js"),
    output: "protocol.cjs",
  },
  {
    name: "cli-loader",
    entryPoint: resolve(ROOT_DIR, "dist/cli/loader.js"),
    output: "cli-loader.cjs",
  },
];

async function bundlePackage(pkg: (typeof PACKAGES)[number]): Promise<void> {
  console.log(`Bundling ${pkg.name}...`);

  await build({
    entryPoints: [pkg.entryPoint],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: resolve(OUTPUT_DIR, pkg.output),
    // Don't bundle Node.js built-ins
    external: ["node:*"],
    // Mark @agentclientprotocol/sdk as external - it will be bundled by pkg separately
    // Actually, let's bundle it to avoid resolution issues
    // external: ["@agentclientprotocol/sdk"],
    sourcemap: false,
    minify: false,
    // Preserve names for debugging
    keepNames: true,
    // Target Node 24
    target: "node24",
    logLevel: "info",
  });

  console.log(`  ✓ ${pkg.output}`);
}

async function main(): Promise<void> {
  console.log("Pre-bundling thinkwell packages for pkg\n");

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Check that source files exist
  for (const pkg of PACKAGES) {
    if (!existsSync(pkg.entryPoint)) {
      console.error(`Error: Entry point not found: ${pkg.entryPoint}`);
      console.error("Run 'pnpm build' first to compile TypeScript sources.");
      process.exit(1);
    }
  }

  // Bundle each package
  for (const pkg of PACKAGES) {
    await bundlePackage(pkg);
  }

  console.log("\nPre-bundling completed successfully!");
  console.log(`CJS bundles are in: ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error("Bundle failed:", error.message);
  process.exit(1);
});
