#!/usr/bin/env thinkwell
/**
 * Test TypeScript with thinkwell imports.
 * This tests the transformation path (write to temp file, then require).
 */

// Import from thinkwell package
import { Agent } from "thinkwell";

// Type annotations
const agentName: string = "test-agent";

// Interface (will be stripped)
interface TestConfig {
  name: string;
  verbose: boolean;
}

const config: TestConfig = {
  name: agentName,
  verbose: true,
};

console.log("=== Thinkwell Import + TypeScript Test ===");
console.log("");
console.log("Agent class available:", typeof Agent === "function");
console.log("Config:", JSON.stringify(config));
console.log("");
console.log("=== Test Passed ===");
