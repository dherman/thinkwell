import { describe, it } from "node:test";
import assert from "node:assert";
import { McpOverAcpHandler } from "@thinkwell/acp";
import { createPlan } from "./think-builder.js";
import type { AgentConnection, SessionHandler } from "./agent.js";

/**
 * Tests for return_result handling edge cases.
 *
 * These tests use a mock AgentConnection to exercise the result
 * resolution logic in PlanImpl._executeStream without needing a
 * real agent process.
 */

const schema = {
  toJsonSchema: () => ({
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  }),
};

/**
 * Create a mock AgentConnection where the prompt handler calls
 * return_result via the MCP server and then returns the prompt
 * response — matching real agent behavior where the agent waits
 * for the MCP round-trip before completing the prompt.
 */
function createMockConnection(): {
  conn: AgentConnection;
  cleanup: () => void;
} {
  const mcpHandler = new McpOverAcpHandler();
  const sessionHandlers = new Map<string, SessionHandler>();

  let capturedServer: any = null;
  const origRegister = mcpHandler.register.bind(mcpHandler);
  mcpHandler.register = (server: any) => {
    capturedServer = server;
    origRegister(server);
  };

  const conn: AgentConnection = {
    conductor: { shutdown: async () => {} } as any,
    connection: {
      initialize: async () => ({
        protocolVersion: 1,
        serverInfo: { name: "mock" },
        capabilities: {},
      }),
      newSession: async () => ({ sessionId: "test-session" }),
      prompt: async () => {
        if (capturedServer) {
          // Real agents wait for the MCP round-trip before completing
          // the prompt — _mcp/message is a JSON-RPC request, so the
          // agent blocks until it gets the response.
          await capturedServer.handleMethod("tools/call", {
            name: "return_result",
            arguments: { message: "Hello!" },
          }, { connectionId: "c1", sessionId: "test-session" });
        }
        return { stopReason: "end_turn" };
      },
    } as any,
    mcpHandler,
    sessionHandlers,
    initialized: false,
    conductorPromise: Promise.resolve(),
  };

  mcpHandler.waitForToolsDiscovery = async () => {};

  return {
    conn,
    cleanup: () => {
      if (capturedServer) mcpHandler.unregister(capturedServer);
    },
  };
}

describe("return_result handling", () => {
  it("should resolve result via MCP round-trip", async () => {
    const { conn, cleanup } = createMockConnection();

    try {
      const result = await createPlan(conn, schema)
        .text("Say hello")
        .run() as { message: string };

      assert.strictEqual(result.message, "Hello!");
    } finally {
      cleanup();
    }
  });

  it("should reject when agent never calls return_result", async () => {
    const mcpHandler = new McpOverAcpHandler();
    const sessionHandlers = new Map<string, SessionHandler>();

    const conn: AgentConnection = {
      conductor: { shutdown: async () => {} } as any,
      connection: {
        initialize: async () => ({
          protocolVersion: 1,
          serverInfo: { name: "mock" },
          capabilities: {},
        }),
        newSession: async () => ({ sessionId: "test-session" }),
        prompt: async () => {
          return { stopReason: "end_turn" };
        },
      } as any,
      mcpHandler,
      sessionHandlers,
      initialized: false,
      conductorPromise: Promise.resolve(),
    };

    mcpHandler.waitForToolsDiscovery = async () => {};

    await assert.rejects(
      createPlan(conn, schema).text("Say hello").run(),
      { message: "Agent session ended without returning a result" }
    );
  });

  it("should reject when agent calls return_result with schema-violating input", async () => {
    const mcpHandler = new McpOverAcpHandler();
    const sessionHandlers = new Map<string, SessionHandler>();

    let capturedServer: any = null;
    const origRegister = mcpHandler.register.bind(mcpHandler);
    mcpHandler.register = (server: any) => {
      capturedServer = server;
      origRegister(server);
    };

    const conn: AgentConnection = {
      conductor: { shutdown: async () => {} } as any,
      connection: {
        initialize: async () => ({
          protocolVersion: 1,
          serverInfo: { name: "mock" },
          capabilities: {},
        }),
        newSession: async () => ({ sessionId: "test-session" }),
        prompt: async () => {
          if (capturedServer) {
            // Agent calls return_result with empty object (missing required "message")
            await capturedServer.handleMethod("tools/call", {
              name: "return_result",
              arguments: {},
            }, { connectionId: "c1", sessionId: "test-session" });
          }
          return { stopReason: "end_turn" };
        },
      } as any,
      mcpHandler,
      sessionHandlers,
      initialized: false,
      conductorPromise: Promise.resolve(),
    };

    mcpHandler.waitForToolsDiscovery = async () => {};

    try {
      await assert.rejects(
        createPlan(conn, schema).text("Say hello").run(),
        (err: Error) => {
          assert.ok(err instanceof TypeError, "expected TypeError");
          assert.match(err.message, /missing required field/i);
          return true;
        }
      );
    } finally {
      if (capturedServer) mcpHandler.unregister(capturedServer);
    }
  });

  it("should only accept the first call to acceptResult (guard against double invocation)", async () => {
    const mcpHandler = new McpOverAcpHandler();
    const sessionHandlers = new Map<string, SessionHandler>();

    let capturedServer: any = null;
    const origRegister = mcpHandler.register.bind(mcpHandler);
    mcpHandler.register = (server: any) => {
      capturedServer = server;
      origRegister(server);
    };

    const conn: AgentConnection = {
      conductor: { shutdown: async () => {} } as any,
      connection: {
        initialize: async () => ({
          protocolVersion: 1,
          serverInfo: { name: "mock" },
          capabilities: {},
        }),
        newSession: async () => ({ sessionId: "test-session" }),
        prompt: async () => {
          if (capturedServer) {
            await capturedServer.handleMethod("tools/call", {
              name: "return_result",
              arguments: { message: "Correct!" },
            }, { connectionId: "c1", sessionId: "test-session" });

            // Second call with wrong data — should be ignored
            try {
              await capturedServer.handleMethod("tools/call", {
                name: "return_result",
                arguments: { message: "Wrong!" },
              }, { connectionId: "c1", sessionId: "test-session" });
            } catch {
              // Ignore
            }
          }
          return { stopReason: "end_turn" };
        },
      } as any,
      mcpHandler,
      sessionHandlers,
      initialized: false,
      conductorPromise: Promise.resolve(),
    };

    mcpHandler.waitForToolsDiscovery = async () => {};

    try {
      const result = await createPlan(conn, schema)
        .text("Say hello")
        .run() as { message: string };

      assert.strictEqual(result.message, "Correct!");
    } finally {
      if (capturedServer) mcpHandler.unregister(capturedServer);
    }
  });
});
