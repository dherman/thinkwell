import { describe, it } from "node:test";
import assert from "node:assert";
import { Agent, schemaOf } from "./index.js";

/**
 * Integration tests for the thinkwell library.
 *
 * These tests require:
 * - ANTHROPIC_API_KEY environment variable set
 *
 * Skip these tests by setting: SKIP_INTEGRATION_TESTS=1
 */

const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION_TESTS === "1";

describe("Thinkwell integration tests", { skip: SKIP_INTEGRATION }, () => {
  // These are lightweight tests that don't require a live conductor.
  // The manual tests below demonstrate full end-to-end functionality.

  describe("Agent API (unit)", () => {
    it("should export the expected API", () => {
      // Verify the module exports are correct
      assert.ok(typeof Agent === "function", "Agent should be exported");
      assert.ok(typeof Agent.connect === "function", "Agent.connect should be a static method");
      assert.ok(typeof schemaOf === "function", "schemaOf should be exported");
    });
  });
});

/**
 * Manual end-to-end test for the think() API.
 *
 * Run with: npx tsx src/integration.test.ts --manual
 *
 * This demonstrates the full thinkwell workflow:
 * 1. Connect to agent via conductor
 * 2. Create a think() builder with prompt and tools
 * 3. Execute and get typed result
 *
 * Environment variables:
 * - AGENT_COMMAND: The agent command (default: "npx -y @zed-industries/claude-code-acp")
 */
async function manualThinkwellTest() {
  console.log("Starting manual thinkwell integration test...\n");

  const agentCommand = process.env.AGENT_COMMAND ?? "npx -y @zed-industries/claude-code-acp";
  console.log("Using agent command:", agentCommand);

  // Connect to the agent
  const agent = await Agent.connect(agentCommand);
  console.log("Connected to agent\n");

  try {
    // Define the expected output type
    interface MathResult {
      expression: string;
      result: number;
      steps: string[];
    }

    const MathResultSchema = schemaOf<MathResult>({
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
    });

    // Track tool calls for verification
    const toolCalls: string[] = [];

    // Build and execute a think prompt
    console.log("Executing think() with math problem...\n");

    const result = await agent.think(MathResultSchema)
      .textln("# Math Problem")
      .textln("")
      .text("Calculate the following expression step by step: ")
      .quote("(5 + 3) * 2")
      .textln("")
      .textln("Use the available tools to perform each operation.")
      .tool(
        "add",
        "Add two numbers together",
        schemaOf<{ a: number; b: number }>({
          type: "object",
          properties: {
            a: { type: "number", description: "First number" },
            b: { type: "number", description: "Second number" },
          },
          required: ["a", "b"],
        }),
        async (input: { a: number; b: number }) => {
          toolCalls.push(`add(${input.a}, ${input.b})`);
          console.log(`  Tool call: add(${input.a}, ${input.b}) = ${input.a + input.b}`);
          return { result: input.a + input.b };
        }
      )
      .tool(
        "multiply",
        "Multiply two numbers",
        schemaOf<{ a: number; b: number }>({
          type: "object",
          properties: {
            a: { type: "number", description: "First number" },
            b: { type: "number", description: "Second number" },
          },
          required: ["a", "b"],
        }),
        async (input: { a: number; b: number }) => {
          toolCalls.push(`multiply(${input.a}, ${input.b})`);
          console.log(`  Tool call: multiply(${input.a}, ${input.b}) = ${input.a * input.b}`);
          return { result: input.a * input.b };
        }
      )
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
    await agent.close();
    console.log("\nConnection closed");
  }
}

/**
 * Simpler manual test without tools.
 */
async function simpleManualTest() {
  console.log("Starting simple thinkwell test...\n");

  const agentCommand = process.env.AGENT_COMMAND ?? "npx -y @zed-industries/claude-code-acp";
  const agent = await Agent.connect(agentCommand);

  try {
    interface SimpleResult {
      greeting: string;
    }

    const result = await agent.think(schemaOf<SimpleResult>({
      type: "object",
      properties: {
        greeting: { type: "string" },
      },
      required: ["greeting"],
    }))
      .text("Say hello to the user. Return a greeting message.")
      .run();

    console.log("Result:", result);
  } finally {
    await agent.close();
  }
}

// Run manual tests based on command line args
if (process.argv.includes("--manual")) {
  manualThinkwellTest().catch(console.error);
} else if (process.argv.includes("--simple")) {
  simpleManualTest().catch(console.error);
}
