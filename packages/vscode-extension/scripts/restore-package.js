#!/usr/bin/env node
/**
 * Restores package.json and cleans up artifacts from prepare-package.js.
 */

const fs = require("fs");
const path = require("path");

const extensionDir = path.resolve(__dirname, "..");
const bakPath = path.join(extensionDir, "package.json.bak");
const pkgPath = path.join(extensionDir, "package.json");
const lockPath = path.join(extensionDir, "package-lock.json");

// Restore original package.json
if (fs.existsSync(bakPath)) {
  fs.copyFileSync(bakPath, pkgPath);
  fs.unlinkSync(bakPath);
}

// Remove generated package-lock.json
if (fs.existsSync(lockPath)) {
  fs.unlinkSync(lockPath);
}
