/**
 * Tests for the Conductor class
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { Conductor, fromConnectors } from "./conductor.js";
import { createChannelPair, inProcess } from "./connectors/channel.js";
import type { ComponentConnection, ComponentConnector } from "./types.js";
import type { JsonRpcMessage } from "@thinkwell/protocol";

/**
 * Create a simple mock agent that responds to requests
 */
function createMockAgent(
  handler: (message: JsonRpcMessage, send: (msg: JsonRpcMessage) => void) => void
): ComponentConnector {
  return inProcess(async (connection) => {
    for await (const message of connection.messages) {
      handler(message, (msg) => connection.send(msg));
    }
  });
}

/**
 * Create an echo agent that echoes request params back as result
 */
function createEchoAgent(): ComponentConnector {
  return createMockAgent((message, send) => {
    if ("method" in message && "id" in message) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: message.params,
      });
    }
  });
}

/**
 * Create a connector for a client that we control
 */
function createTestClient(): {
  connector: ComponentConnector;
  clientSend: (msg: JsonRpcMessage) => void;
  receivedMessages: JsonRpcMessage[];
  waitForMessage: () => Promise<JsonRpcMessage>;
} {
  const receivedMessages: JsonRpcMessage[] = [];
  let messageResolve: ((msg: JsonRpcMessage) => void) | null = null;

  const pair = createChannelPair();

  // Track messages received from conductor
  (async () => {
    for await (const message of pair.right.messages) {
      receivedMessages.push(message);
      if (messageResolve) {
        messageResolve(message);
        messageResolve = null;
      }
    }
  })();

  return {
    connector: {
      async connect() {
        return pair.left;
      },
    },
    clientSend: (msg) => pair.right.send(msg),
    receivedMessages,
    waitForMessage: () =>
      new Promise<JsonRpcMessage>((resolve) => {
        if (receivedMessages.length > 0) {
          resolve(receivedMessages[receivedMessages.length - 1]);
        } else {
          messageResolve = resolve;
        }
      }),
  };
}

describe("Conductor", () => {
  describe("pass-through mode (no proxies)", () => {
    it("should forward initialize request to agent and return response", async () => {
      const initResponse = {
        serverInfo: { name: "test-agent", version: "1.0" },
        capabilities: { tools: true },
      };

      const agent = createMockAgent((message, send) => {
        if ("method" in message && message.method === "initialize") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: initResponse,
          });
        }
      });

      const conductor = new Conductor({
        instantiator: fromConnectors(agent),
      });

      const { connector, clientSend, waitForMessage, receivedMessages } = createTestClient();

      // Start conductor (don't await - it runs forever)
      const conductorPromise = conductor.connect(connector);

      // Send initialize request
      clientSend({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "test-client", version: "1.0" } },
      });

      // Wait for response
      const response = await waitForMessage();

      assert.equal(response.jsonrpc, "2.0");
      assert.equal((response as any).id, 1);
      assert.deepEqual((response as any).result, initResponse);

      // Shut down
      await conductor.shutdown();
    });

    it("should forward subsequent requests to agent", async () => {
      const agent = createEchoAgent();

      const conductor = new Conductor({
        instantiator: fromConnectors(agent),
      });

      const { connector, clientSend, waitForMessage, receivedMessages } = createTestClient();

      const conductorPromise = conductor.connect(connector);

      // Initialize first
      clientSend({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "test", version: "1.0" } },
      });
      await waitForMessage();

      // Now send another request
      clientSend({
        jsonrpc: "2.0",
        id: 2,
        method: "some/method",
        params: { foo: "bar" },
      });

      // Wait for the echo response
      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = receivedMessages.find((m) => (m as any).id === 2);
      assert.ok(response, "Should have received response for id 2");
      assert.deepEqual((response as any).result, { foo: "bar" });

      await conductor.shutdown();
    });

    it("should forward notifications to agent", async () => {
      const receivedNotifications: JsonRpcMessage[] = [];

      const agent = createMockAgent((message, send) => {
        if ("method" in message && !("id" in message)) {
          receivedNotifications.push(message);
        } else if ("method" in message && message.method === "initialize") {
          send({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      });

      const conductor = new Conductor({
        instantiator: fromConnectors(agent),
      });

      const { connector, clientSend, waitForMessage } = createTestClient();

      const conductorPromise = conductor.connect(connector);

      // Initialize
      clientSend({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      await waitForMessage();

      // Send notification
      clientSend({
        jsonrpc: "2.0",
        method: "some/notification",
        params: { data: 123 },
      });

      // Give time for the notification to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(receivedNotifications.length, 1);
      assert.equal((receivedNotifications[0] as any).method, "some/notification");
      assert.deepEqual((receivedNotifications[0] as any).params, { data: 123 });

      await conductor.shutdown();
    });

    it("should forward notifications from agent to client", async () => {
      let agentConnection: ComponentConnection | null = null;

      const agent: ComponentConnector = {
        async connect() {
          const pair = createChannelPair();
          agentConnection = pair.right;

          // Handle initialization on the agent side
          (async () => {
            for await (const message of pair.right.messages) {
              if ("method" in message && message.method === "initialize") {
                pair.right.send({ jsonrpc: "2.0", id: message.id, result: {} });
              }
            }
          })();

          return pair.left;
        },
      };

      const conductor = new Conductor({
        instantiator: fromConnectors(agent),
      });

      const { connector, clientSend, receivedMessages } = createTestClient();

      const conductorPromise = conductor.connect(connector);

      // Initialize
      clientSend({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Agent sends notification to client
      agentConnection!.send({
        jsonrpc: "2.0",
        method: "agent/notification",
        params: { status: "working" },
      });

      // Wait for notification to arrive
      await new Promise((resolve) => setTimeout(resolve, 50));

      const notification = receivedMessages.find(
        (m) => "method" in m && m.method === "agent/notification"
      );
      assert.ok(notification, "Should have received notification from agent");
      assert.deepEqual((notification as any).params, { status: "working" });

      await conductor.shutdown();
    });
  });

  describe("request/response correlation", () => {
    it("should correctly route concurrent responses back to original requesters", async () => {
      // Agent that responds with a delay, in reverse order
      const agent: ComponentConnector = inProcess(async (connection) => {
        const pending: Array<{ id: any; delay: number }> = [];

        for await (const message of connection.messages) {
          if ("method" in message && "id" in message) {
            if (message.method === "initialize") {
              connection.send({ jsonrpc: "2.0", id: message.id, result: {} });
            } else if (message.method === "slow") {
              // Respond after 100ms
              setTimeout(() => {
                connection.send({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { order: "slow" },
                });
              }, 100);
            } else if (message.method === "fast") {
              // Respond immediately
              connection.send({
                jsonrpc: "2.0",
                id: message.id,
                result: { order: "fast" },
              });
            }
          }
        }
      });

      const conductor = new Conductor({
        instantiator: fromConnectors(agent),
      });

      const { connector, clientSend, receivedMessages } = createTestClient();

      conductor.connect(connector);

      // Initialize
      clientSend({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send slow request first, then fast request
      clientSend({ jsonrpc: "2.0", id: 2, method: "slow", params: {} });
      clientSend({ jsonrpc: "2.0", id: 3, method: "fast", params: {} });

      // Wait for both responses
      await new Promise((resolve) => setTimeout(resolve, 200));

      const slowResponse = receivedMessages.find((m) => (m as any).id === 2);
      const fastResponse = receivedMessages.find((m) => (m as any).id === 3);

      assert.ok(slowResponse, "Should have received slow response");
      assert.ok(fastResponse, "Should have received fast response");
      assert.deepEqual((slowResponse as any).result, { order: "slow" });
      assert.deepEqual((fastResponse as any).result, { order: "fast" });

      await conductor.shutdown();
    });
  });
});
