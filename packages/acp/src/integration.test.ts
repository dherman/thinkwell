import { describe, it, after } from "node:test";
import assert from "node:assert";
import { connect } from "./connection.js";
import { mcpServer } from "./mcp-server.js";
import { SessionBuilder } from "./session.js";
import type { SacpConnection } from "./connection.js";

/**
 * Integration tests that require the sacp-conductor binary.
 *
 * These tests verify the full communication flow between the client
 * and an agent via the conductor.
 *
 * Prerequisites:
 * - sacp-conductor must be installed: `cargo install sacp-conductor`
 * - An agent must be configured (e.g., Claude via API key)
 *
 * Skip these tests if conductor is not available by setting:
 * SKIP_INTEGRATION_TESTS=1
 *
 * Note: The conductor command is `sacp-conductor agent` which runs
 * the agent orchestrator. Without proxies, it acts as a simple passthrough.
 */

const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION_TESTS === "1";

describe("Integration tests", { skip: SKIP_INTEGRATION }, () => {
  // These tests don't spawn the conductor since that requires
  // a full agent setup. Instead, they test the components that
  // would be used with a conductor connection.

  describe("MCP Server registration (unit)", () => {
    it("should create and register an MCP server", () => {
      const server = mcpServer("test-server")
        .instructions("A test MCP server")
        .tool(
          "echo",
          "Echo the input back",
          { type: "object", properties: { message: { type: "string" } } },
          { type: "object", properties: { echoed: { type: "string" } } },
          async (input: { message: string }) => ({ echoed: input.message })
        )
        .build();

      // Verify the server is configured correctly
      assert.ok(server.id, "Server should have an ID");
      assert.ok(server.acpUrl.startsWith("acp:"), "Server should have acp: URL");

      const definitions = server.getToolDefinitions();
      assert.strictEqual(definitions.length, 1);
      assert.strictEqual(definitions[0].name, "echo");
    });

    it("should handle tool calls locally", async () => {
      const server = mcpServer("calc")
        .tool(
          "add",
          "Add two numbers",
          { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
          { type: "number" },
          async (input: { a: number; b: number }) => input.a + input.b
        )
        .build();

      const result = await server.handleMethod(
        "tools/call",
        { name: "add", arguments: { a: 5, b: 3 } },
        { connectionId: "test", sessionId: "test" }
      ) as { content: { text: string }[] };

      assert.strictEqual(result.content[0].text, "8");
    });
  });
});

/**
 * Standalone test that can be run manually to verify full end-to-end flow.
 *
 * Run with: npx tsx src/integration.test.ts --manual
 *
 * This requires:
 * - sacp-conductor installed
 * - ANTHROPIC_API_KEY environment variable set (or other agent config)
 */
async function manualIntegrationTest() {
  console.log("Starting manual integration test...");
  console.log("Note: This requires sacp-conductor agent to be running with a configured agent.\n");

  // The conductor command depends on your setup. Common options:
  // - ["sacp-conductor", "agent"] - bare conductor with no proxies
  // - ["sacp-conductor", "agent", "claude"] - with Claude proxy
  const conductorCommand = process.env.CONDUCTOR_COMMAND?.split(" ") ?? ["sacp-conductor", "agent"];

  console.log("Using conductor command:", conductorCommand.join(" "));

  const connection = await connect(conductorCommand);
  console.log("Connected to conductor");

  try {
    await connection.initialize();
    console.log("Initialized connection");

    const server = mcpServer("manual-test")
      .instructions("A test server for manual integration testing")
      .tool(
        "get_time",
        "Get the current time",
        { type: "object" },
        { type: "object", properties: { time: { type: "string" } } },
        async () => ({ time: new Date().toISOString() })
      )
      .tool(
        "add",
        "Add two numbers",
        {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
        { type: "object", properties: { result: { type: "number" } } },
        async (input: { a: number; b: number }) => ({ result: input.a + input.b })
      )
      .build();

    connection.mcpHandler.register(server);
    console.log("Registered MCP server:", server.acpUrl);

    const sessionBuilder = new SessionBuilder(connection, connection.mcpHandler);
    sessionBuilder.withMcpServer(server);
    sessionBuilder.cwd(process.cwd());

    console.log("Running session...");

    await sessionBuilder.run(async (session) => {
      console.log("Session created:", session.sessionId);

      // Send a simple prompt
      await session.sendPrompt("What is 2 + 2? Use the add tool to calculate it.");

      // Read responses
      let done = false;
      while (!done) {
        const update = await session.readUpdate();
        console.log("Update:", JSON.stringify(update, null, 2));

        if (update.type === "stop") {
          done = true;
        }
      }
    });

    console.log("Session completed");
  } finally {
    connection.close();
    console.log("Connection closed");
  }
}

// Run manual test if --manual flag is passed
if (process.argv.includes("--manual")) {
  manualIntegrationTest().catch(console.error);
}
