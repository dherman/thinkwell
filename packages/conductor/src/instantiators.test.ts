/**
 * Tests for component instantiator helpers
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fromCommands,
  fromConnectors,
  dynamic,
  staticInstantiator,
} from "./instantiators.js";
import { inProcess, createChannelPair } from "./connectors/channel.js";
import type { ComponentConnector, InitializeRequest } from "./types.js";

describe("Component Instantiators", () => {
  describe("fromConnectors", () => {
    it("should create instantiator with just an agent", async () => {
      const agentConnector = inProcess(async () => {});
      const instantiator = fromConnectors(agentConnector);

      const result = await instantiator.instantiate({
        method: "initialize",
        params: {},
      });

      assert.equal(result.proxies.length, 0);
      assert.strictEqual(result.agent, agentConnector);
    });

    it("should create instantiator with agent and proxies", async () => {
      const proxyConnector = inProcess(async () => {});
      const agentConnector = inProcess(async () => {});
      const instantiator = fromConnectors(agentConnector, [proxyConnector]);

      const result = await instantiator.instantiate({
        method: "initialize",
        params: {},
      });

      assert.equal(result.proxies.length, 1);
      assert.strictEqual(result.proxies[0], proxyConnector);
      assert.strictEqual(result.agent, agentConnector);
    });

    it("should create instantiator with multiple proxies", async () => {
      const proxy1 = inProcess(async () => {});
      const proxy2 = inProcess(async () => {});
      const proxy3 = inProcess(async () => {});
      const agent = inProcess(async () => {});
      const instantiator = fromConnectors(agent, [proxy1, proxy2, proxy3]);

      const result = await instantiator.instantiate({
        method: "initialize",
        params: {},
      });

      assert.equal(result.proxies.length, 3);
      assert.strictEqual(result.proxies[0], proxy1);
      assert.strictEqual(result.proxies[1], proxy2);
      assert.strictEqual(result.proxies[2], proxy3);
      assert.strictEqual(result.agent, agent);
    });
  });

  describe("fromCommands", () => {
    it("should throw error if no commands provided", () => {
      assert.throws(() => fromCommands([]), {
        message: "At least one command (the agent) is required",
      });
    });

    it("should create instantiator with single command as agent", async () => {
      // We can't actually spawn a process in unit tests, but we can verify
      // the structure is correct by checking the instantiator exists
      const instantiator = fromCommands(["echo"]);

      // Verify instantiator was created (we won't call instantiate since it would spawn)
      assert.ok(instantiator);
      assert.ok(typeof instantiator.instantiate === "function");
    });

    it("should create instantiator with multiple commands", async () => {
      const instantiator = fromCommands(["proxy1", "proxy2", "agent"]);

      assert.ok(instantiator);
      assert.ok(typeof instantiator.instantiate === "function");
    });
  });

  describe("staticInstantiator", () => {
    it("should create instantiator with just agent", async () => {
      const instantiator = staticInstantiator({
        agent: "echo",
      });

      assert.ok(instantiator);
      assert.ok(typeof instantiator.instantiate === "function");
    });

    it("should create instantiator with agent and proxies", async () => {
      const instantiator = staticInstantiator({
        proxies: ["proxy1", "proxy2"],
        agent: "agent",
      });

      assert.ok(instantiator);
      assert.ok(typeof instantiator.instantiate === "function");
    });

    it("should accept command options", async () => {
      const instantiator = staticInstantiator({
        agent: {
          command: "my-agent",
          args: ["--mode", "test"],
          env: { DEBUG: "true" },
        },
      });

      assert.ok(instantiator);
      assert.ok(typeof instantiator.instantiate === "function");
    });
  });

  describe("dynamic", () => {
    it("should call factory with initialize request", async () => {
      let receivedRequest: InitializeRequest | null = null;
      const mockAgent = inProcess(async () => {});

      const instantiator = dynamic(async (initRequest) => {
        receivedRequest = initRequest;
        return {
          proxies: [],
          agent: mockAgent,
        };
      });

      const testRequest: InitializeRequest = {
        method: "initialize",
        params: {
          clientInfo: { name: "test-client", version: "1.0" },
          capabilities: { mcp_acp_transport: true },
        },
      };

      const result = await instantiator.instantiate(testRequest);

      assert.ok(receivedRequest);
      assert.equal(receivedRequest.method, "initialize");
      assert.deepEqual(receivedRequest.params?.clientInfo, {
        name: "test-client",
        version: "1.0",
      });
      assert.equal(receivedRequest.params?.capabilities?.mcp_acp_transport, true);
      assert.strictEqual(result.agent, mockAgent);
    });

    it("should allow factory to choose components based on request", async () => {
      const basicAgent = inProcess(async () => {});
      const advancedAgent = inProcess(async () => {});
      const loggingProxy = inProcess(async () => {});

      const instantiator = dynamic(async (initRequest) => {
        const capabilities = initRequest.params?.capabilities ?? {};
        const isAdvanced = "advanced" in capabilities;

        return {
          proxies: isAdvanced ? [loggingProxy] : [],
          agent: isAdvanced ? advancedAgent : basicAgent,
        };
      });

      // Basic request - no advanced capability
      const basicResult = await instantiator.instantiate({
        method: "initialize",
        params: { capabilities: {} },
      });
      assert.equal(basicResult.proxies.length, 0);
      assert.strictEqual(basicResult.agent, basicAgent);

      // Advanced request - with advanced capability
      const advancedResult = await instantiator.instantiate({
        method: "initialize",
        params: { capabilities: { advanced: true } },
      });
      assert.equal(advancedResult.proxies.length, 1);
      assert.strictEqual(advancedResult.proxies[0], loggingProxy);
      assert.strictEqual(advancedResult.agent, advancedAgent);
    });

    it("should allow factory to inspect MCP servers", async () => {
      let inspectedServers: Array<{ name: string; url: string }> = [];
      const mockAgent = inProcess(async () => {});

      const instantiator = dynamic(async (initRequest) => {
        inspectedServers = (initRequest.params?.mcpServers ?? []) as Array<{
          name: string;
          url: string;
        }>;
        return {
          proxies: [],
          agent: mockAgent,
        };
      });

      const testServers = [
        { name: "server1", url: "acp:uuid-1" },
        { name: "server2", url: "http://localhost:8080" },
      ];

      await instantiator.instantiate({
        method: "initialize",
        params: {
          mcpServers: testServers,
        },
      });

      assert.equal(inspectedServers.length, 2);
      assert.deepEqual(inspectedServers, testServers);
    });

    it("should propagate factory errors", async () => {
      const instantiator = dynamic(async () => {
        throw new Error("Factory failed");
      });

      await assert.rejects(
        instantiator.instantiate({ method: "initialize", params: {} }),
        { message: "Factory failed" }
      );
    });
  });

  describe("lazy instantiation", () => {
    it("should not call instantiate until requested", async () => {
      let instantiateCalled = false;
      const mockAgent = inProcess(async () => {});

      const instantiator = dynamic(async () => {
        instantiateCalled = true;
        return {
          proxies: [],
          agent: mockAgent,
        };
      });

      // Just creating the instantiator should not call instantiate
      assert.equal(instantiateCalled, false);

      // Calling instantiate should trigger the factory
      await instantiator.instantiate({ method: "initialize", params: {} });
      assert.equal(instantiateCalled, true);
    });

    it("should call instantiate fresh each time", async () => {
      let callCount = 0;
      const mockAgent = inProcess(async () => {});

      const instantiator = dynamic(async () => {
        callCount++;
        return {
          proxies: [],
          agent: mockAgent,
        };
      });

      await instantiator.instantiate({ method: "initialize", params: {} });
      assert.equal(callCount, 1);

      await instantiator.instantiate({ method: "initialize", params: {} });
      assert.equal(callCount, 2);
    });
  });
});
