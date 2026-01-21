import { describe, it } from "node:test";
import assert from "node:assert";
import { McpServerBuilder, McpServer, mcpServer } from "./mcp-server.js";
import type { McpContext } from "./types.js";

describe("McpServerBuilder", () => {
  it("should create a builder with a name", () => {
    const builder = new McpServerBuilder("test-server");
    const server = builder.build();

    assert.strictEqual(server.name, "test-server");
  });

  it("should set instructions", () => {
    const builder = mcpServer("test")
      .instructions("These are test instructions");

    const server = builder.build();

    // Verify instructions are included in initialize response
    const initResponse = server.handleMethod("initialize", {}, {
      connectionId: "conn-1",
      sessionId: "session-1",
    }) as Promise<{ instructions?: string }>;

    initResponse.then((response) => {
      assert.strictEqual(response.instructions, "These are test instructions");
    });
  });

  it("should register tools", () => {
    const builder = mcpServer("test")
      .tool(
        "add",
        "Add two numbers",
        { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
        { type: "number" },
        async (input: { a: number; b: number }) => input.a + input.b
      );

    const server = builder.build();
    const definitions = server.getToolDefinitions();

    assert.strictEqual(definitions.length, 1);
    assert.strictEqual(definitions[0].name, "add");
    assert.strictEqual(definitions[0].description, "Add two numbers");
  });

  it("should register multiple tools", () => {
    const builder = mcpServer("multi-tool")
      .tool("tool1", "First tool", { type: "object" }, { type: "object" }, async () => ({}))
      .tool("tool2", "Second tool", { type: "object" }, { type: "object" }, async () => ({}))
      .tool("tool3", "Third tool", { type: "object" }, { type: "object" }, async () => ({}));

    const server = builder.build();
    const definitions = server.getToolDefinitions();

    assert.strictEqual(definitions.length, 3);
    assert.deepStrictEqual(
      definitions.map((d) => d.name),
      ["tool1", "tool2", "tool3"]
    );
  });

  it("should generate unique IDs for servers", () => {
    const server1 = mcpServer("test").build();
    const server2 = mcpServer("test").build();

    assert.notStrictEqual(server1.id, server2.id);
  });
});

describe("McpServer", () => {
  it("should generate acp: URL", () => {
    const server = mcpServer("test").build();

    assert.ok(server.acpUrl.startsWith("acp:"));
    assert.strictEqual(server.acpUrl, `acp:${server.id}`);
  });

  it("should generate session config", () => {
    const server = mcpServer("my-server").build();
    const config = server.toSessionConfig();

    assert.strictEqual(config.type, "http");
    assert.strictEqual(config.name, "my-server");
    assert.strictEqual(config.url, server.acpUrl);
  });

  it("should handle initialize method", async () => {
    const server = mcpServer("test-server")
      .instructions("Test instructions")
      .build();

    const context: McpContext = { connectionId: "conn-1", sessionId: "session-1" };
    const result = await server.handleMethod("initialize", {}, context);

    assert.deepStrictEqual(result, {
      protocolVersion: "2025-03-26",
      serverInfo: { name: "test-server", version: "0.1.0" },
      capabilities: { tools: {} },
      instructions: "Test instructions",
    });
  });

  it("should handle tools/list method", async () => {
    const server = mcpServer("test")
      .tool("greet", "Say hello", { type: "object", properties: { name: { type: "string" } } }, { type: "string" }, async () => "hello")
      .build();

    const context: McpContext = { connectionId: "conn-1", sessionId: "session-1" };
    const result = await server.handleMethod("tools/list", {}, context) as { tools: unknown[] };

    assert.strictEqual(result.tools.length, 1);
    assert.deepStrictEqual(result.tools[0], {
      name: "greet",
      description: "Say hello",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
    });
  });

  it("should handle tools/call method", async () => {
    const server = mcpServer("test")
      .tool(
        "multiply",
        "Multiply two numbers",
        { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
        { type: "number" },
        async (input: { a: number; b: number }) => input.a * input.b
      )
      .build();

    const context: McpContext = { connectionId: "conn-1", sessionId: "session-1" };
    const result = await server.handleMethod(
      "tools/call",
      { name: "multiply", arguments: { a: 6, b: 7 } },
      context
    ) as { content: { text: string }[] };

    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(result.content[0].text, "42");
  });

  it("should return error for unknown tool", async () => {
    const server = mcpServer("test").build();

    const context: McpContext = { connectionId: "conn-1", sessionId: "session-1" };
    const result = await server.handleMethod(
      "tools/call",
      { name: "nonexistent", arguments: {} },
      context
    ) as { content: { text: string }[]; isError: boolean };

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Unknown tool"));
  });

  it("should catch and return tool errors", async () => {
    const server = mcpServer("test")
      .tool("fail", "Always fails", { type: "object" }, { type: "object" }, async () => {
        throw new Error("Something went wrong");
      })
      .build();

    const context: McpContext = { connectionId: "conn-1", sessionId: "session-1" };
    const result = await server.handleMethod(
      "tools/call",
      { name: "fail", arguments: {} },
      context
    ) as { content: { text: string }[]; isError: boolean };

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Something went wrong"));
  });

  it("should pass context to tool handlers", async () => {
    let receivedContext: McpContext | null = null;

    const server = mcpServer("test")
      .tool("capture-context", "Captures context", { type: "object" }, { type: "object" }, async (_input, ctx) => {
        receivedContext = ctx;
        return { captured: true };
      })
      .build();

    const context: McpContext = { connectionId: "test-conn", sessionId: "test-session" };
    await server.handleMethod("tools/call", { name: "capture-context", arguments: {} }, context);

    assert.deepStrictEqual(receivedContext, context);
  });

  it("should throw for unknown method", async () => {
    const server = mcpServer("test").build();
    const context: McpContext = { connectionId: "conn-1", sessionId: "session-1" };

    await assert.rejects(
      () => server.handleMethod("unknown/method", {}, context),
      /Unknown MCP method/
    );
  });
});
