import { v4 as uuidv4 } from "uuid";
import type {
  JsonSchema,
  McpContext,
  McpServerConfig,
  McpToolDefinition,
  McpToolsCallParams,
  McpToolsCallResult,
  McpToolsListResult,
  RegisteredTool,
  ToolHandler,
} from "./types.js";

/**
 * Fluent builder for creating MCP servers with registered tools
 */
export class McpServerBuilder {
  private _name: string;
  private _instructions: string | undefined;
  private _tools: Map<string, RegisteredTool> = new Map();

  constructor(name: string) {
    this._name = name;
  }

  /**
   * Set instructions for the MCP server
   */
  instructions(text: string): this {
    this._instructions = text;
    return this;
  }

  /**
   * Register a tool with input/output JSON schemas
   */
  tool<I, O>(
    name: string,
    description: string,
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    handler: ToolHandler<I, O>
  ): this {
    this._tools.set(name, {
      name,
      description,
      inputSchema,
      outputSchema,
      handler: handler as ToolHandler,
    });
    return this;
  }

  /**
   * Build the MCP server
   */
  build(): McpServer {
    return new McpServer(
      this._name,
      this._instructions,
      new Map(this._tools)
    );
  }
}

/**
 * MCP server that handles tool calls via MCP-over-ACP
 */
export class McpServer {
  readonly id: string;
  readonly name: string;
  private readonly _instructions: string | undefined;
  private readonly _tools: Map<string, RegisteredTool>;

  constructor(
    name: string,
    instructions: string | undefined,
    tools: Map<string, RegisteredTool>
  ) {
    this.id = uuidv4();
    this.name = name;
    this._instructions = instructions;
    this._tools = tools;
  }

  /**
   * Get the acp: URL for this server
   */
  get acpUrl(): string {
    return `acp:${this.id}`;
  }

  /**
   * Get MCP server config for session requests
   */
  toSessionConfig(): McpServerConfig {
    return {
      type: "http",
      name: this.name,
      url: this.acpUrl,
    };
  }

  /**
   * Get the list of tool definitions for tools/list
   */
  getToolDefinitions(): McpToolDefinition[] {
    return Array.from(this._tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Handle an MCP method call or notification
   */
  async handleMethod(
    method: string,
    params: unknown,
    context: McpContext
  ): Promise<unknown> {
    switch (method) {
      case "tools/list":
        return this.handleToolsList();
      case "tools/call":
        return this.handleToolsCall(params as McpToolsCallParams, context);
      case "initialize":
        return this.handleInitialize();
      case "notifications/initialized":
        // Client notification after initialize - no response needed
        return undefined;
      default:
        throw new Error(`Unknown MCP method: ${method}`);
    }
  }

  private handleInitialize(): {
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    capabilities: { tools: Record<string, never> };
    instructions: string;
  } {
    // Use protocol version 2025-03-26 to match rmcp's behavior
    // Always include instructions to help Claude Code understand how to use tools
    const instructions = this._instructions ?? "You have access to tools. Call return_result when done.";
    return {
      protocolVersion: "2025-03-26",
      serverInfo: {
        name: this.name,
        version: "0.1.0",
      },
      capabilities: {
        tools: {},
      },
      instructions,
    };
  }

  private handleToolsList(): McpToolsListResult {
    return {
      tools: this.getToolDefinitions(),
    };
  }

  private async handleToolsCall(
    params: McpToolsCallParams,
    context: McpContext
  ): Promise<McpToolsCallResult> {
    const tool = this._tools.get(params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(params.arguments, context);
      const resultText =
        typeof result === "string" ? result : JSON.stringify(result);
      return {
        content: [{ type: "text", text: resultText }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Tool error: ${message}` }],
        isError: true,
      };
    }
  }
}

/**
 * Create a new MCP server builder
 */
export function mcpServer(name: string): McpServerBuilder {
  return new McpServerBuilder(name);
}
