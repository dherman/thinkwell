#!/usr/bin/env tsx
/**
 * Pre-bundle thinkwell packages for the compiled binary.
 *
 * The compiled binary (built with pkg) struggles with ESM modules because its
 * module resolution doesn't properly handle ESM import statements inside the
 * /snapshot/ virtual filesystem.
 *
 * This script uses esbuild to bundle the thinkwell packages into CJS format,
 * which the binary can then include and resolve correctly.
 *
 * Output:
 *   dist-pkg/thinkwell.cjs      - bundled thinkwell package
 *   dist-pkg/acp.cjs            - bundled @thinkwell/acp package
 *   dist-pkg/protocol.cjs       - bundled @thinkwell/protocol package
 *   dist-pkg/cli-loader.cjs     - bundled CLI loader (includes schema processing)
 *   dist-pkg/cli-bundle.cjs     - bundled bundle command
 *   dist-pkg/pkg-cli.cjs        - bundled @yao-pkg/pkg CLI for subprocess execution
 *   dist-pkg/esbuild-bin/       - esbuild binaries for each platform
 */

import { build } from "esbuild";
import { mkdirSync, existsSync, copyFileSync, chmodSync, readdirSync, cpSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { bundlePkgCli } from "./bundle-pkg-cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(ROOT_DIR, "dist-pkg");

// Package configuration type
interface PackageConfig {
  name: string;
  entryPoint: string;
  output: string;
  /** Mark these packages as external (don't bundle them) */
  external?: string[];
}

// Packages to bundle
const PACKAGES: PackageConfig[] = [
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
  {
    name: "cli-build",
    entryPoint: resolve(ROOT_DIR, "dist/cli/build.js"),
    output: "cli-build.cjs",
  },
  {
    name: "cli-check",
    entryPoint: resolve(ROOT_DIR, "dist/cli/check.js"),
    output: "cli-check.cjs",
  },
  {
    name: "cli-bundle",
    entryPoint: resolve(ROOT_DIR, "dist/cli/bundle.js"),
    output: "cli-bundle.cjs",
    // NOTE: esbuild is NOT marked as external - we bundle its JS code, but its native binary
    // is extracted separately via extractEsbuildBinary() and ESBUILD_BINARY_PATH
    // @yao-pkg/pkg is external because it's only used at build time (not inside the compiled binary)
    external: ["@yao-pkg/pkg"],
  },
  {
    name: "cli-dependency-check",
    entryPoint: resolve(ROOT_DIR, "dist/cli/dependency-check.js"),
    output: "cli-dependency-check.cjs",
  },
  {
    name: "cli-dependency-errors",
    entryPoint: resolve(ROOT_DIR, "dist/cli/dependency-errors.js"),
    output: "cli-dependency-errors.cjs",
  },
];

async function bundlePackage(pkg: PackageConfig): Promise<void> {
  console.log(`Bundling ${pkg.name}...`);

  // Combine default externals with package-specific externals
  const externals = ["node:*", ...(pkg.external || [])];

  await build({
    entryPoints: [pkg.entryPoint],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: resolve(OUTPUT_DIR, pkg.output),
    // Don't bundle Node.js built-ins and package-specific externals
    external: externals,
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

/**
 * Copy esbuild platform binaries to dist-pkg for embedding in the pkg binary.
 *
 * This is necessary because pnpm's node_modules structure doesn't work well
 * with pkg's asset resolution. We copy the binaries to a known location
 * (dist-pkg/esbuild-bin/<platform>/esbuild) that the compiled binary can access.
 */
function copyEsbuildBinaries(): void {
  console.log("Copying esbuild binaries...");

  const require = createRequire(import.meta.url);

  // Platforms we support
  const platforms = [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
  ];

  const esbuildBinDir = join(OUTPUT_DIR, "esbuild-bin");
  mkdirSync(esbuildBinDir, { recursive: true });

  for (const platform of platforms) {
    const pkgName = `@esbuild/${platform}`;
    try {
      // Use require.resolve to find the package through pnpm's symlinks
      const pkgPath = require.resolve(`${pkgName}/package.json`);
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "bin", "esbuild");

      if (existsSync(binaryPath)) {
        const destDir = join(esbuildBinDir, platform);
        mkdirSync(destDir, { recursive: true });
        const destPath = join(destDir, "esbuild");
        copyFileSync(binaryPath, destPath);
        chmodSync(destPath, 0o755);
        console.log(`  ✓ ${platform}`);
      } else {
        console.log(`  - ${platform} (not installed on this system)`);
      }
    } catch {
      // Package not installed (expected for non-current platforms)
      console.log(`  - ${platform} (not installed)`);
    }
  }
}

/**
 * Copy TypeScript lib .d.ts files to dist-pkg for embedding in the pkg binary.
 *
 * TypeScript's type checker needs these lib files (lib.es2022.full.d.ts, etc.)
 * to provide built-in type definitions. When bundled with esbuild, only the JS
 * code is included - the .d.ts files must be copied separately.
 */
function copyTypeScriptLibFiles(): void {
  console.log("Copying TypeScript lib files...");

  const require = createRequire(import.meta.url);

  try {
    // Find TypeScript's lib directory
    // require.resolve("typescript") -> .../typescript/lib/typescript.js
    // So dirname gives us the lib directory directly
    const tsPath = require.resolve("typescript");
    const tsLibDir = dirname(tsPath);

    if (!existsSync(tsLibDir)) {
      console.error(`  Error: TypeScript lib directory not found: ${tsLibDir}`);
      process.exit(1);
    }

    // Copy the entire lib directory to dist-pkg/typescript-lib
    const destDir = join(OUTPUT_DIR, "typescript-lib");
    cpSync(tsLibDir, destDir, { recursive: true });

    // Count .d.ts files copied
    const dtsFiles = readdirSync(destDir).filter(f => f.endsWith(".d.ts"));
    console.log(`  ✓ Copied ${dtsFiles.length} .d.ts files to typescript-lib/`);
  } catch (error) {
    console.error("  Error copying TypeScript lib files:", error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log("Pre-bundling thinkwell packages for compiled binary\n");

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

  // Copy esbuild binaries
  copyEsbuildBinaries();

  // Copy TypeScript lib files for type checking
  copyTypeScriptLibFiles();

  // Bundle pkg CLI for subprocess execution from compiled binary
  await bundlePkgCli();

  console.log("\nPre-bundling completed successfully!");
  console.log(`CJS bundles are in: ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error("Bundle failed:", error.message);
  process.exit(1);
});
