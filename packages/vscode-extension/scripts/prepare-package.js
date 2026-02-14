#!/usr/bin/env node
/**
 * Prepares the extension for vsce packaging in a pnpm workspace.
 *
 * pnpm uses symlinks in node_modules, which vsce/npm can't handle.
 * This script:
 * 1. Removes the pnpm node_modules entirely
 * 2. Creates a minimal node_modules with just the TS plugin's runtime files
 * 3. Generates a package-lock.json for vsce's npm list check
 *
 * After packaging, run `pnpm install` to restore the pnpm node_modules.
 */

const fs = require("fs");
const path = require("path");

const extensionDir = path.resolve(__dirname, "..");
const pluginSrc = path.resolve(__dirname, "../../vscode-ts-plugin");
const nodeModulesDir = path.join(extensionDir, "node_modules");
const pluginDst = path.join(nodeModulesDir, "@thinkwell/vscode-ts-plugin");

// Runtime files to copy from the TS plugin package
const files = [
  "package.json",
  "dist/index.js",
  "dist/scanner.js",
  "dist/virtual-declarations.js",
  "dist/standalone-resolver.js",
];

// Remove the entire pnpm-managed node_modules
fs.rmSync(nodeModulesDir, { recursive: true, force: true });

// Create a clean node_modules with just the TS plugin
fs.mkdirSync(path.join(pluginDst, "dist"), { recursive: true });

for (const file of files) {
  const src = path.join(pluginSrc, file);
  const dst = path.join(pluginDst, file);

  if (!fs.existsSync(src)) {
    console.error(`Missing: ${src}`);
    console.error("Run 'pnpm -r build' first.");
    process.exit(1);
  }

  fs.copyFileSync(src, dst);
}

// Strip the typescript dependency from the copied package.json
// (it's provided by tsserver at runtime, and npm list would complain)
const pluginPkg = JSON.parse(fs.readFileSync(path.join(pluginDst, "package.json"), "utf-8"));
delete pluginPkg.dependencies;
delete pluginPkg.devDependencies;
fs.writeFileSync(path.join(pluginDst, "package.json"), JSON.stringify(pluginPkg, null, 2));

// Save and rewrite extension's package.json to replace workspace:* with the real
// version (npm doesn't understand pnpm workspace protocol)
const extensionPkgPath = path.join(extensionDir, "package.json");
const extensionPkgOriginal = fs.readFileSync(extensionPkgPath, "utf-8");
fs.writeFileSync(path.join(extensionDir, "package.json.bak"), extensionPkgOriginal);

const extensionPkg = JSON.parse(extensionPkgOriginal);
if (extensionPkg.dependencies?.["@thinkwell/vscode-ts-plugin"]?.startsWith("workspace:")) {
  extensionPkg.dependencies["@thinkwell/vscode-ts-plugin"] = pluginPkg.version;
  fs.writeFileSync(extensionPkgPath, JSON.stringify(extensionPkg, null, 2) + "\n");
}

// Write a minimal package-lock.json for vsce's npm list check
const packageLock = {
  name: extensionPkg.name,
  version: extensionPkg.version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: extensionPkg.name,
      version: extensionPkg.version,
      dependencies: {
        "@thinkwell/vscode-ts-plugin": pluginPkg.version,
      },
    },
    "node_modules/@thinkwell/vscode-ts-plugin": {
      version: pluginPkg.version,
      resolved: "",
    },
  },
};

fs.writeFileSync(
  path.join(extensionDir, "package-lock.json"),
  JSON.stringify(packageLock, null, 2),
);

console.log(`Prepared ${files.length} plugin files and package-lock.json for packaging`);
