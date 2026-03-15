import { describe, it } from "node:test";
import assert from "node:assert";
import { McpOverAcpHandler } from "@thinkwell/acp";
import { createPlan } from "./think-builder.js";
import type { AgentConnection, SessionHandler } from "./agent.js";

/**
 * Regression test for the return_result race condition.
 *
 * The ACP SDK's ClientSideConnection#receive loop dispatches messages
 * without awaiting #processMessage. When an agent sends _mcp/message
 * (for return_result) followed immediately by the prompt response,
 * the prompt response can resolve before the return_result handler
 * finishes its async chain — causing "Session ended without calling
 * return_result".
 *
 * We reproduce this by mocking AgentConnection.prompt() to fire the
 * return_result tool call with a microtask delay (simulating the real
 * async handler chain) while resolving the prompt response immediately.
 */

function createMockConnection(opts: { delayTicks: number }): {
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
          // Fire-and-forget: simulate the ACP SDK dispatching the
          // _mcp/message without awaiting #processMessage.
          (async () => {
            for (let i = 0; i < opts.delayTicks; i++) await Promise.resolve();
            await capturedServer.handleMethod("tools/call", {
              name: "return_result",
              arguments: { message: "Hello!" },
            }, { connectionId: "c1", sessionId: "test-session" });
          })();
        }
        // Prompt response resolves immediately (before tool handler completes)
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

const schema = {
  toJsonSchema: () => ({
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  }),
};

describe("return_result race condition", () => {
  it("should resolve result when return_result handler is delayed by many microtask hops", async () => {
    // 20 microtask hops simulates the real async chain depth in the
    // ACP SDK (extMethod → routeRequest → handleMessage → handleToolsCall).
    const { conn, cleanup } = createMockConnection({ delayTicks: 20 });

    try {
      const result = await createPlan(conn, schema)
        .text("Say hello")
        .run() as { message: string };

      assert.strictEqual(result.message, "Hello!");
    } finally {
      cleanup();
    }
  });

  it("should resolve result with no delay (synchronous path)", async () => {
    const { conn, cleanup } = createMockConnection({ delayTicks: 0 });

    try {
      const result = await createPlan(conn, schema)
        .text("Say hello")
        .run() as { message: string };

      assert.strictEqual(result.message, "Hello!");
    } finally {
      cleanup();
    }
  });
});
