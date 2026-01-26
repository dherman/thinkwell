import { describe, it, after } from "node:test";
import assert from "node:assert";
import { connect, connectToConductor } from "./connection.js";
import { mcpServer } from "./mcp-server.js";
import { SessionBuilder } from "./session.js";
import type { SacpConnection } from "./connection.js";
import {
  Conductor,
  fromConnectors,
  inProcess,
  createChannelPair,
  type ComponentConnector,
  type ComponentConnection,
  type JsonRpcMessage,
} from "@thinkwell/conductor";

/**
 * Integration tests for the TypeScript conductor.
 *
 * These tests verify the full communication flow between the client
 * and an agent via the in-process conductor.
 *
 * Skip live agent tests by setting:
 * SKIP_INTEGRATION_TESTS=1
 */

const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION_TESTS === "1";

/**
 * Create a mock agent that responds to ACP requests.
 *
 * This agent handles:
 * - initialize: Returns basic capabilities
 * - session/new: Returns a session ID
 * - session/prompt: Returns a simple response
 */
function createMockAcpAgent(): ComponentConnector {
  return inProcess(async (connection) => {
    for await (const message of connection.messages) {
      if (!("method" in message) || !("id" in message)) continue;

      const { id, method, params } = message as JsonRpcMessage & {
        id: number;
        method: string;
        params?: unknown;
      };

      switch (method) {
        case "initialize":
        case "acp/initialize":
          connection.send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: 1,
              serverInfo: { name: "mock-agent", version: "1.0.0" },
              capabilities: {},
            },
          });
          break;

        case "session/new":
          connection.send({
            jsonrpc: "2.0",
            id,
            result: {
              sessionId: "test-session-123",
            },
          });
          break;

        case "session/prompt":
          // Send a session update notification first
          connection.send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: (params as any)?.sessionId ?? "test-session-123",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Hello from mock agent!" },
              },
            },
          });
          // Then send the prompt response
          connection.send({
            jsonrpc: "2.0",
            id,
            result: {
              stopReason: "end_turn",
            },
          });
          break;

        default:
          // Echo other requests back as a simple response
          connection.send({
            jsonrpc: "2.0",
            id,
            result: { received: method, params },
          });
      }
    }
  });
}

describe("In-process conductor integration", () => {
  it("should connect to an in-process conductor and initialize", async () => {
    const mockAgent = createMockAcpAgent();

    const conductor = new Conductor({
      instantiator: fromConnectors(mockAgent),
    });

    const connection = await connectToConductor(conductor);

    try {
      await connection.initialize();
      // If we get here without throwing, initialization succeeded
      assert.ok(true, "Should initialize successfully");
    } finally {
      connection.close();
    }
  });

  it("should create a session through in-process conductor", async () => {
    const mockAgent = createMockAcpAgent();

    const conductor = new Conductor({
      instantiator: fromConnectors(mockAgent),
    });

    const connection = await connectToConductor(conductor);

    try {
      await connection.initialize();
      const sessionId = await connection.createSession({ cwd: process.cwd() });
      assert.strictEqual(sessionId, "test-session-123");
    } finally {
      connection.close();
    }
  });

  it("should send prompts and receive responses through in-process conductor", async () => {
    const mockAgent = createMockAcpAgent();

    const conductor = new Conductor({
      instantiator: fromConnectors(mockAgent),
    });

    const connection = await connectToConductor(conductor);

    try {
      await connection.initialize();
      const sessionId = await connection.createSession({ cwd: process.cwd() });
      const response = await connection.sendPrompt(sessionId, "Hello, agent!");

      assert.strictEqual(response.stopReason, "end_turn");
    } finally {
      connection.close();
    }
  });

  it("should handle session updates via the session handler", async () => {
    const mockAgent = createMockAcpAgent();

    const conductor = new Conductor({
      instantiator: fromConnectors(mockAgent),
    });

    const connection = await connectToConductor(conductor);
    const receivedUpdates: any[] = [];

    try {
      await connection.initialize();
      const sessionId = await connection.createSession({ cwd: process.cwd() });

      // Set up a session handler to capture updates
      connection.setSessionHandler(sessionId, {
        sessionId,
        pushUpdate: (update) => receivedUpdates.push(update),
        readUpdate: async () => receivedUpdates.shift() ?? { type: "stop", reason: "end_turn" },
        sendPrompt: async () => {},
      });

      // Send a prompt - the mock agent sends a session update before responding
      await connection.sendPrompt(sessionId, "Hello!");

      // Give time for the notification to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // We should have received the text update
      assert.ok(receivedUpdates.length > 0, "Should have received updates");
      assert.strictEqual(receivedUpdates[0].type, "text");
      assert.strictEqual(receivedUpdates[0].content, "Hello from mock agent!");
    } finally {
      connection.close();
    }
  });
});

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
 * - ANTHROPIC_API_KEY environment variable set (or other agent config)
 */
async function manualIntegrationTest() {
  console.log("Starting manual integration test...");

  // The agent command - defaults to Claude Code ACP
  const agentCommand = process.env.AGENT_COMMAND?.split(" ") ?? ["npx", "-y", "@zed-industries/claude-code-acp"];

  console.log("Using agent command:", agentCommand.join(" "));

  const connection = await connect(agentCommand);
  console.log("Connected to conductor (in-process)");

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
