import { describe, it, after } from "node:test";
import assert from "node:assert";
import { open, schemaOf } from "./index.js";
import type { Agent, ThoughtEvent } from "./index.js";

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

  describe("Thinkwell API (unit)", () => {
    it("should export the expected API", () => {
      // Verify the module exports are correct
      assert.ok(typeof open === "function", "open should be exported");
      assert.ok(typeof schemaOf === "function", "schemaOf should be exported");
    });
  });
});

/**
 * Live agent integration tests for stream() and run().
 *
 * These require a running agent and ANTHROPIC_API_KEY.
 * Skip with: SKIP_INTEGRATION_TESTS=1
 */
const SKIP_LIVE = SKIP_INTEGRATION;

describe("Thought Stream live integration", { skip: SKIP_LIVE }, () => {
  let agent: Agent;

  after(async () => {
    if (agent) await agent.close();
  });

  async function ensureAgent(): Promise<Agent> {
    if (!agent) {
      agent = await open('claude');
    }
    return agent;
  }

  const GreetingSchema = schemaOf<{ greeting: string }>({
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"],
  });

  it("stream() should iterate and resolve .result", async () => {
    const a = await ensureAgent();
    const stream = a
      .think(GreetingSchema)
      .text("Say hello. Return a short greeting.")
      .stream();

    const events: ThoughtEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Iteration should complete (events may be empty if the agent jumps
    // straight to return_result without emitting thoughts or messages)
    assert.ok(Array.isArray(events), "Iteration should produce an array");

    // .result should resolve to a valid greeting
    const result = await stream.result;
    assert.ok(typeof result.greeting === "string", "Expected greeting to be a string");
    assert.ok(result.greeting.length > 0, "Expected non-empty greeting");
  });

  it("run() should return typed result (backward compat)", async () => {
    const a = await ensureAgent();
    const result = await a
      .think(GreetingSchema)
      .text("Say hello. Return a short greeting.")
      .run();

    assert.ok(typeof result.greeting === "string", "Expected greeting to be a string");
    assert.ok(result.greeting.length > 0, "Expected non-empty greeting");
  });

  it("early termination: break from for-await should not break .result", async () => {
    const a = await ensureAgent();
    const stream = a
      .think(GreetingSchema)
      .text("Say hello. Return a short greeting.")
      .stream();

    // Break immediately after first event
    let sawEvent = false;
    for await (const _event of stream) {
      sawEvent = true;
      break;
    }

    // .result should still resolve even though we broke out early
    const result = await stream.result;
    assert.ok(typeof result.greeting === "string", "Expected greeting after early break");
  });

  it("fire-and-forget: await .result without iterating", async () => {
    const a = await ensureAgent();
    const stream = a
      .think(GreetingSchema)
      .text("Say hello. Return a short greeting.")
      .stream();

    // Never iterate — just await the result
    const result = await stream.result;
    assert.ok(typeof result.greeting === "string", "Expected greeting from fire-and-forget");
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

  const agent = await open('claude');
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

  const agent = await open('claude');

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
