#!/usr/bin/env tsx
/**
 * Bundle @yao-pkg/pkg CLI into a single CJS file for embedding in the compiled binary.
 *
 * When the thinkwell CLI is compiled with pkg, we cannot use @yao-pkg/pkg programmatically
 * because it uses dynamic imports that don't work inside pkg's virtual filesystem.
 *
 * Instead, we bundle the pkg CLI into a single CJS file that can be:
 * 1. Embedded as an asset in the compiled thinkwell binary
 * 2. Extracted to disk at runtime
 * 3. Executed via a subprocess using a downloaded portable Node.js
 *
 * This approach allows `thinkwell build` to work from compiled binaries without
 * requiring npm, npx, or any external dependencies.
 *
 * Output:
 *   dist-pkg/pkg-cli.cjs - Self-contained pkg CLI bundle (~1-2 MB)
 */

import { build } from "esbuild";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(ROOT_DIR, "dist-pkg");

export async function bundlePkgCli(): Promise<void> {
  console.log("Bundling @yao-pkg/pkg CLI...");

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Find the pkg CLI entry point
  const require = createRequire(import.meta.url);
  let pkgBinPath: string;
  let pkgDir: string;
  try {
    pkgBinPath = require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
    pkgDir = dirname(require.resolve("@yao-pkg/pkg/package.json"));
  } catch {
    console.error("Error: @yao-pkg/pkg not found in dependencies");
    console.error("Run 'pnpm install' to install dependencies.");
    process.exit(1);
  }

  const outputFile = resolve(OUTPUT_DIR, "pkg-cli.cjs");

  try {
    await build({
      entryPoints: [pkgBinPath],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      outfile: outputFile,
      // Bundle all dependencies except:
      // - node:* builtins
      // - @aws-sdk/client-s3 (optional dependency of unzipper, used for S3 streams)
      external: ["node:*", "@aws-sdk/client-s3"],
      sourcemap: false,
      minify: false,
      keepNames: true,
      // No shebang - this file is executed via `node pkg-cli.cjs`, not directly
      logLevel: "info",
      // Note: No shebang banner - this file is executed via `node pkg-cli.cjs`, not directly
      plugins: [
        {
          // Plugin to rewrite require.resolve paths for pkg's prelude files
          // These need to resolve relative to where pkg-cli.cjs will be placed
          name: "pkg-prelude-resolver",
          setup(build) {
            // Intercept require.resolve calls in the bundled code by
            // transforming the source files that use them
            build.onLoad({ filter: /packer\.js$/ }, async (args) => {
              const fs = await import("node:fs/promises");
              let contents = await fs.readFile(args.path, "utf-8");

              // Rewrite the require.resolve paths to use paths relative to pkg-cli.cjs
              // Original: require.resolve('../prelude/bootstrap.js')
              // New: require.resolve('./pkg-prelude/bootstrap.js')
              contents = contents.replace(
                /require\.resolve\(['"]\.\.\/prelude\/bootstrap\.js['"]\)/g,
                "require.resolve('./pkg-prelude/bootstrap.js')"
              );
              contents = contents.replace(
                /require\.resolve\(['"]\.\.\/prelude\/diagnostic\.js['"]\)/g,
                "require.resolve('./pkg-prelude/diagnostic.js')"
              );
              // common.js is in the same directory after bundling, but we place it as pkg-common.cjs
              // Actually, common.js content gets bundled, so this resolve should work
              // But let's rewrite it to be safe
              contents = contents.replace(
                /require\.resolve\(['"]\.\/common['"]\)/g,
                "require.resolve('./pkg-common.cjs')"
              );

              return {
                contents,
                loader: "js",
              };
            });
          },
        },
      ],
    });

    console.log(`  ✓ pkg-cli.cjs`);

    // Copy pkg's package.json (needed for version info at runtime)
    // pkg reads ../package.json relative to __dirname, so we place it in OUTPUT_DIR
    const pkgPackageJson = join(pkgDir, "package.json");
    copyFileSync(pkgPackageJson, join(OUTPUT_DIR, "package.json"));
    console.log(`  ✓ package.json (pkg version info)`);

    // Copy pkg prelude files that are read at runtime via require.resolve
    // These need to be at a relative path from pkg-cli.cjs
    const preludeDir = join(OUTPUT_DIR, "pkg-prelude");
    mkdirSync(preludeDir, { recursive: true });

    const preludeFiles = ["bootstrap.js", "diagnostic.js"];
    for (const file of preludeFiles) {
      const src = join(pkgDir, "prelude", file);
      const dest = join(preludeDir, file);
      copyFileSync(src, dest);
      console.log(`  ✓ pkg-prelude/${file}`);
    }

    // Also copy common.js from lib-es5 (used by packer.js)
    const commonSrc = join(pkgDir, "lib-es5", "common.js");
    const commonDest = join(OUTPUT_DIR, "pkg-common.cjs");
    if (existsSync(commonSrc)) {
      copyFileSync(commonSrc, commonDest);
      console.log(`  ✓ pkg-common.cjs`);
    }

    // Copy dictionary files that pkg uses for compression
    const dictionaryDir = join(OUTPUT_DIR, "pkg-dictionary");
    mkdirSync(dictionaryDir, { recursive: true });
    const pkgDictDir = join(pkgDir, "dictionary");
    if (existsSync(pkgDictDir)) {
      const dictFiles = ["v8-7.8.js", "v8-8.4.js", "v8-12.4.js"];
      for (const file of dictFiles) {
        const src = join(pkgDictDir, file);
        if (existsSync(src)) {
          const dest = join(dictionaryDir, file);
          copyFileSync(src, dest);
          console.log(`  ✓ pkg-dictionary/${file}`);
        }
      }
    }
  } catch (error) {
    console.error("Failed to bundle pkg CLI:", error);
    throw error;
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  bundlePkgCli()
    .then(() => {
      console.log("\npkg CLI bundling completed successfully!");
      console.log(`Output: ${resolve(OUTPUT_DIR, "pkg-cli.cjs")}`);
    })
    .catch((error) => {
      console.error("Bundle failed:", error.message);
      process.exit(1);
    });
}
