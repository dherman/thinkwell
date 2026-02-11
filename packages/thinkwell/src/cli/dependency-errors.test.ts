/**
 * Unit tests for dependency error message formatting.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  formatMissingDependencyError,
  hasMissingDependencies,
} from "./dependency-errors.js";
import type { DependencyCheckResult } from "./dependency-check.js";
import type { PackageManagerInfo } from "./package-manager.js";

// ============================================================================
// Helpers
// ============================================================================

function createPmInfo(name: "pnpm" | "npm" | "yarn"): PackageManagerInfo {
  return {
    name,
    lockfile: null,
    addCommand: (pkg: string, dev?: boolean): string => {
      switch (name) {
        case "pnpm":
          return dev ? `pnpm add -D ${pkg}` : `pnpm add ${pkg}`;
        case "yarn":
          return dev ? `yarn add -D ${pkg}` : `yarn add ${pkg}`;
        case "npm":
          return dev ? `npm install -D ${pkg}` : `npm install ${pkg}`;
      }
    },
    whyCommand: (pkg: string): string[] => [name, "why", pkg, "--json"],
  };
}

function createResult(overrides: {
  thinkwellFound?: boolean;
  typescriptFound?: boolean;
  pm?: "pnpm" | "npm" | "yarn";
}): DependencyCheckResult {
  const {
    thinkwellFound = false,
    typescriptFound = false,
    pm = "npm",
  } = overrides;

  return {
    thinkwell: {
      found: thinkwellFound,
      version: thinkwellFound ? "^0.5.0" : undefined,
      source: thinkwellFound ? "package.json" : undefined,
    },
    typescript: {
      found: typescriptFound,
      version: typescriptFound ? "^5.7.0" : undefined,
      source: typescriptFound ? "package.json" : undefined,
    },
    packageManager: createPmInfo(pm),
  };
}

// ============================================================================
// hasMissingDependencies
// ============================================================================

describe("hasMissingDependencies", () => {
  it("should return true when thinkwell is missing", () => {
    const result = createResult({ thinkwellFound: false, typescriptFound: true });
    assert.strictEqual(hasMissingDependencies(result), true);
  });

  it("should return true when typescript is missing", () => {
    const result = createResult({ thinkwellFound: true, typescriptFound: false });
    assert.strictEqual(hasMissingDependencies(result), true);
  });

  it("should return true when both are missing", () => {
    const result = createResult({ thinkwellFound: false, typescriptFound: false });
    assert.strictEqual(hasMissingDependencies(result), true);
  });

  it("should return false when both are found", () => {
    const result = createResult({ thinkwellFound: true, typescriptFound: true });
    assert.strictEqual(hasMissingDependencies(result), false);
  });
});

// ============================================================================
// formatMissingDependencyError
// ============================================================================

describe("formatMissingDependencyError", () => {
  describe("with no missing dependencies", () => {
    it("should return empty string when both deps are found", () => {
      const result = createResult({ thinkwellFound: true, typescriptFound: true });
      const message = formatMissingDependencyError(result);
      assert.strictEqual(message, "");
    });
  });

  describe("with thinkwell missing (pnpm)", () => {
    it("should format error with pnpm add command", () => {
      const result = createResult({
        thinkwellFound: false,
        typescriptFound: true,
        pm: "pnpm",
      });
      const message = formatMissingDependencyError(result);

      assert.ok(message.includes("Error:"), "Should include error prefix");
      assert.ok(message.includes("'thinkwell'"), "Should mention thinkwell");
      assert.ok(message.includes("pnpm add thinkwell"), "Should show pnpm add command");
      assert.ok(!message.includes("typescript"), "Should not mention typescript");
    });
  });

  describe("with typescript missing (npm)", () => {
    it("should format error with npm install -D command", () => {
      const result = createResult({
        thinkwellFound: true,
        typescriptFound: false,
        pm: "npm",
      });
      const message = formatMissingDependencyError(result);

      assert.ok(message.includes("Error:"), "Should include error prefix");
      assert.ok(message.includes("'typescript'"), "Should mention typescript");
      assert.ok(message.includes("npm install -D typescript"), "Should show npm install -D");
      // Note: The error message mentions "thinkwell" in the explanation text
      // (e.g., "thinkwell expects explicit dependencies") - that's fine.
      // What we verify is that there's no "npm install thinkwell" command.
      assert.ok(!message.includes("npm install thinkwell"), "Should not include thinkwell add command");
    });
  });

  describe("with both missing (yarn)", () => {
    it("should format error with yarn add commands for both", () => {
      const result = createResult({
        thinkwellFound: false,
        typescriptFound: false,
        pm: "yarn",
      });
      const message = formatMissingDependencyError(result);

      assert.ok(message.includes("Error:"), "Should include error prefix");
      assert.ok(message.includes("missing required dependencies"), "Should indicate multiple missing");
      assert.ok(message.includes("yarn add thinkwell"), "Should show yarn add thinkwell");
      assert.ok(message.includes("yarn add -D typescript"), "Should show yarn add -D typescript");
    });
  });

  describe("error message content", () => {
    it("should explain why explicit dependencies are required", () => {
      const result = createResult({ thinkwellFound: false, typescriptFound: false });
      const message = formatMissingDependencyError(result);

      assert.ok(
        message.includes("explicit configuration"),
        "Should explain explicit config requirement",
      );
      assert.ok(
        message.includes("versions you expect"),
        "Should explain version expectation",
      );
    });

    it("should mention thinkwell init as remediation", () => {
      const result = createResult({ thinkwellFound: false, typescriptFound: false });
      const message = formatMissingDependencyError(result);

      assert.ok(
        message.includes("thinkwell init"),
        "Should mention thinkwell init command",
      );
    });
  });

  describe("package manager specific commands", () => {
    it("should use pnpm add for pnpm projects", () => {
      const result = createResult({
        thinkwellFound: false,
        typescriptFound: false,
        pm: "pnpm",
      });
      const message = formatMissingDependencyError(result);

      assert.ok(message.includes("pnpm add thinkwell"));
      assert.ok(message.includes("pnpm add -D typescript"));
    });

    it("should use npm install for npm projects", () => {
      const result = createResult({
        thinkwellFound: false,
        typescriptFound: false,
        pm: "npm",
      });
      const message = formatMissingDependencyError(result);

      assert.ok(message.includes("npm install thinkwell"));
      assert.ok(message.includes("npm install -D typescript"));
    });

    it("should use yarn add for yarn projects", () => {
      const result = createResult({
        thinkwellFound: false,
        typescriptFound: false,
        pm: "yarn",
      });
      const message = formatMissingDependencyError(result);

      assert.ok(message.includes("yarn add thinkwell"));
      assert.ok(message.includes("yarn add -D typescript"));
    });
  });
});
