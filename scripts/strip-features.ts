#!/usr/bin/env tsx
/**
 * Post-tsc stripping of disabled feature-gated declarations.
 *
 * Pass 1 (ts-morph): Remove exports/methods annotated with /** @feature(name) * /
 *         from .js and .d.ts files in dist/.
 * Pass 2 (esbuild):  Replace `features.x` references with literal booleans and
 *         eliminate dead branches in .js files.
 *
 * Usage (run from a package directory):
 *   tsx ../../scripts/strip-features.ts --mode=release
 *
 * In debug mode this script is a no-op (all features enabled, nothing to strip).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, SyntaxKind, type SourceFile, type Node } from "ts-morph";
import { transform } from "esbuild";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const modeArg = process.argv.find((a) => a.startsWith("--mode="));
const mode = modeArg?.split("=")[1];
if (mode !== "release") {
  // In debug mode there is nothing to strip.
  process.exit(0);
}

const config: { features: Record<string, boolean> } = JSON.parse(
  readFileSync(join(ROOT, "features.json"), "utf-8"),
);

const disabledFeatures = new Set(
  Object.entries(config.features)
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name),
);

// If every feature is enabled, nothing to strip.
if (disabledFeatures.size === 0) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FEATURE_RE = /@feature\((\w+)\)/;

/** Return the feature name if the leading comment is a @feature annotation. */
function featureNameFromComment(commentText: string): string | undefined {
  const m = FEATURE_RE.exec(commentText);
  return m?.[1];
}

/** Check if a node is preceded by a @feature(name) JSDoc for a disabled feature. */
function isDisabledFeatureNode(node: Node): boolean {
  const leadingComments = node.getLeadingCommentRanges();
  for (const c of leadingComments) {
    const name = featureNameFromComment(c.getText());
    if (name && disabledFeatures.has(name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pass 1: ts-morph declaration stripping
// ---------------------------------------------------------------------------

function stripDeclarations(distDir: string): void {
  const project = new Project({ useInMemoryFileSystem: false });

  // Add all .js and .d.ts files from dist/
  const jsFiles = collectFiles(distDir, (f) => f.endsWith(".js") || f.endsWith(".d.ts"));
  for (const file of jsFiles) {
    project.addSourceFileAtPath(file);
  }

  for (const sourceFile of project.getSourceFiles()) {
    let modified = false;

    // Process top-level statements (exports, declarations)
    for (const stmt of [...sourceFile.getStatements()]) {
      if (isDisabledFeatureNode(stmt)) {
        stmt.remove();
        modified = true;
      }
    }

    // Process class methods
    for (const cls of sourceFile.getClasses()) {
      for (const method of [...cls.getMethods()]) {
        if (isDisabledFeatureNode(method)) {
          method.remove();
          modified = true;
        }
      }
    }

    // Process interface methods (in .d.ts files)
    for (const iface of sourceFile.getInterfaces()) {
      for (const method of [...iface.getMethods()]) {
        if (isDisabledFeatureNode(method)) {
          method.remove();
          modified = true;
        }
      }
    }

    if (modified) {
      sourceFile.saveSync();
    }
  }
}

/** Recursively collect files matching a predicate. */
function collectFiles(dir: string, predicate: (file: string) => boolean): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, predicate));
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Pass 2: esbuild dead branch elimination
// ---------------------------------------------------------------------------

async function eliminateDeadBranches(distDir: string): Promise<void> {
  // Build define map: features.x → "true" or "false"
  const defines: Record<string, string> = {};
  for (const [name, enabled] of Object.entries(config.features)) {
    defines[`features.${name}`] = String(enabled);
  }

  const jsFiles = collectFiles(distDir, (f) => f.endsWith(".js") && !f.endsWith(".d.ts"));

  for (const file of jsFiles) {
    const source = readFileSync(file, "utf-8");
    const result = await transform(source, {
      define: defines,
      minifySyntax: true,
      loader: "js",
    });
    if (result.code !== source) {
      writeFileSync(file, result.code, "utf-8");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const distDir = join(process.cwd(), "dist");

  stripDeclarations(distDir);
  await eliminateDeadBranches(distDir);

  console.log(
    `Stripped features [${[...disabledFeatures].join(", ")}] from ${relative(ROOT, distDir)}`,
  );
}

main();
