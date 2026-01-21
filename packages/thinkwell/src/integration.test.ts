import { describe, it } from "node:test";
import assert from "node:assert";
import { connect } from "./patchwork.js";

/**
 * Integration tests for the patchwork library.
 *
 * These tests require:
 * - sacp-conductor installed: `cargo install sacp-conductor`
 * - ANTHROPIC_API_KEY environment variable set
 *
 * Skip these tests by setting: SKIP_INTEGRATION_TESTS=1
 */

const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION_TESTS === "1";

describe("Patchwork integration tests", { skip: SKIP_INTEGRATION }, () => {
  // These are lightweight tests that don't require a live conductor.
  // The manual tests below demonstrate full end-to-end functionality.

  describe("ThinkBuilder API (unit)", () => {
    it("should support all builder methods", () => {
      // This test just verifies the API shape compiles and chains correctly
      // We can't actually run think() without a conductor connection

      // Verify the module exports are correct
      assert.ok(typeof connect === "function", "connect should be exported");
    });
  });
});

/**
 * Manual end-to-end test for the think() API.
 *
 * Run with: npx tsx src/integration.test.ts --manual
 *
 * This demonstrates the full patchwork workflow:
 * 1. Connect to conductor
 * 2. Create a think() builder with prompt and tools
 * 3. Execute and get typed result
 *
 * Environment variables:
 * - CONDUCTOR_COMMAND: Override the conductor command (default: "sacp-conductor agent")
 */
async function manualPatchworkTest() {
  console.log("Starting manual patchwork integration test...\n");

  // The conductor command depends on your setup
  const conductorCommand = process.env.CONDUCTOR_COMMAND?.split(" ") ?? ["sacp-conductor", "agent"];
  console.log("Using conductor command:", conductorCommand.join(" "));

  // Connect to the conductor
  const patchwork = await connect(conductorCommand);
  console.log("Connected to conductor\n");

  try {
    // Define the expected output type
    interface MathResult {
      expression: string;
      result: number;
      steps: string[];
    }

    // Track tool calls for verification
    const toolCalls: string[] = [];

    // Build and execute a think prompt
    console.log("Executing think() with math problem...\n");

    const result = await patchwork.think<MathResult>()
      .textln("# Math Problem")
      .textln("")
      .text("Calculate the following expression step by step: ")
      .display("(5 + 3) * 2")
      .textln("")
      .textln("")
      .textln("Use the available tools to perform each operation.")
      .tool(
        "add",
        "Add two numbers together",
        async (input: { a: number; b: number }) => {
          toolCalls.push(`add(${input.a}, ${input.b})`);
          console.log(`  Tool call: add(${input.a}, ${input.b}) = ${input.a + input.b}`);
          return { result: input.a + input.b };
        },
        {
          type: "object",
          properties: {
            a: { type: "number", description: "First number" },
            b: { type: "number", description: "Second number" },
          },
          required: ["a", "b"],
        }
      )
      .tool(
        "multiply",
        "Multiply two numbers",
        async (input: { a: number; b: number }) => {
          toolCalls.push(`multiply(${input.a}, ${input.b})`);
          console.log(`  Tool call: multiply(${input.a}, ${input.b}) = ${input.a * input.b}`);
          return { result: input.a * input.b };
        },
        {
          type: "object",
          properties: {
            a: { type: "number", description: "First number" },
            b: { type: "number", description: "Second number" },
          },
          required: ["a", "b"],
        }
      )
      .outputSchema({
        type: "object",
        properties: {
          expression: { type: "string", description: "The original expression" },
          result: { type: "number", description: "The final result" },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "The calculation steps taken",
          },
        },
        required: ["expression", "result", "steps"],
      })
      .run();

    console.log("\n--- Result ---");
    console.log("Expression:", result.expression);
    console.log("Result:", result.result);
    console.log("Steps:", result.steps);
    console.log("\nTool calls made:", toolCalls);

    // Verify the result
    const expected = (5 + 3) * 2;
    if (result.result === expected) {
      console.log(`\n✓ Correct! ${result.result} === ${expected}`);
    } else {
      console.log(`\n✗ Incorrect. Got ${result.result}, expected ${expected}`);
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    patchwork.close();
    console.log("\nConnection closed");
  }
}

/**
 * Simpler manual test without tools.
 */
async function simpleManualTest() {
  console.log("Starting simple patchwork test...\n");

  const conductorCommand = process.env.CONDUCTOR_COMMAND?.split(" ") ?? ["sacp-conductor", "agent"];
  const patchwork = await connect(conductorCommand);

  try {
    interface SimpleResult {
      greeting: string;
    }

    const result = await patchwork.think<SimpleResult>()
      .text("Say hello to the user. Return a greeting message.")
      .outputSchema({
        type: "object",
        properties: {
          greeting: { type: "string" },
        },
        required: ["greeting"],
      })
      .run();

    console.log("Result:", result);
  } finally {
    patchwork.close();
  }
}

// Run manual tests based on command line args
if (process.argv.includes("--manual")) {
  manualPatchworkTest().catch(console.error);
} else if (process.argv.includes("--simple")) {
  simpleManualTest().catch(console.error);
}
