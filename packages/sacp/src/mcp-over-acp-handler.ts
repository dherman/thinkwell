import type { McpServer } from "./mcp-server.js";
import type {
  McpConnectRequest,
  McpConnectResponse,
  McpContext,
  McpDisconnectNotification,
  McpMessageRequest,
} from "./types.js";

/**
 * Active MCP connection state
 */
interface McpConnection {
  connectionId: string;
  server: McpServer;
  sessionId: string;
}

/**
 * Pending tools discovery state
 */
interface ToolsDiscoveryState {
  resolve: () => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * Handler for MCP-over-ACP protocol messages.
 *
 * This class manages the lifecycle of MCP connections tunneled through ACP:
 * - mcp/connect: Establishes a new MCP connection
 * - mcp/message: Routes MCP requests to the appropriate server
 * - mcp/disconnect: Tears down an MCP connection
 *
 * Note: The ACP SDK strips the underscore prefix from extension methods,
 * so we receive "mcp/connect" even though the wire format is "_mcp/connect".
 */
export class McpOverAcpHandler {
  /** Maps acp:uuid URLs to registered MCP servers */
  private readonly _serversByUrl: Map<string, McpServer> = new Map();
  /** Maps connection IDs to active connections */
  private readonly _connections: Map<string, McpConnection> = new Map();
  /** Current session ID for context */
  private _sessionId: string = "";
  /** Maps session IDs to pending tools discovery promises */
  private readonly _toolsDiscoveryBySession: Map<string, ToolsDiscoveryState> = new Map();

  /**
   * Register an MCP server to handle requests for its acp: URL
   */
  register(server: McpServer): void {
    this._serversByUrl.set(server.acpUrl, server);
  }

  /**
   * Unregister an MCP server
   */
  unregister(server: McpServer): void {
    this._serversByUrl.delete(server.acpUrl);
  }

  /**
   * Set the current session ID for context
   */
  setSessionId(sessionId: string): void {
    this._sessionId = sessionId;
  }

  /**
   * Handle an incoming mcp/connect request
   */
  handleConnect(params: Record<string, unknown>): McpConnectResponse {
    // The protocol uses "acp_url" as the parameter name
    // Generate connectionId if not provided by conductor
    const connectionId = (params.connectionId as string) ?? `conn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = (params.acp_url ?? params.url) as string;

    const server = this._serversByUrl.get(url);
    if (!server) {
      throw new Error(`No MCP server registered for URL: ${url}`);
    }

    // Store the connection
    this._connections.set(connectionId, {
      connectionId,
      server,
      sessionId: this._sessionId,
    });

    // Include tool definitions in the connect response
    // The conductor bridge may use this to provide tool info to the agent
    const tools = server.getToolDefinitions();

    // Return response with snake_case field names to match the Rust conductor's expectations
    // Note: The conductor only requires connection_id, but we include extra info for potential use
    return {
      connection_id: connectionId,
      connectionId, // Also include camelCase for backwards compatibility
      serverInfo: {
        name: server.name,
        version: "0.1.0",
      },
      capabilities: {
        tools: {},
      },
      // Include tools directly - the bridge may forward this to the agent
      tools,
    } as McpConnectResponse;
  }

  /**
   * Handle an incoming mcp/message request.
   *
   * IMPORTANT: The response to _mcp/message is just the raw MCP result,
   * NOT wrapped in {connectionId, result}. The conductor expects the raw
   * MCP response (e.g., InitializeResult, ToolsListResult) directly.
   */
  async handleMessage(params: Record<string, unknown>): Promise<unknown> {
    const connectionId = params.connectionId as string;
    const method = params.method as string;
    const mcpParams = params.params as unknown;

    const connection = this._connections.get(connectionId);
    if (!connection) {
      // Return MCP-style error for unknown connection
      throw new Error(`Unknown connection: ${connectionId}`);
    }

    // If this is a tools/list request, resolve any pending tools discovery promise
    if (method === "tools/list") {
      this._resolveToolsDiscovery(connection.sessionId);
    }

    const context: McpContext = {
      connectionId,
      sessionId: connection.sessionId,
    };

    // Return the raw MCP result - the conductor will wrap it appropriately
    return await connection.server.handleMethod(method, mcpParams, context);
  }

  /**
   * Wait for the agent to discover tools via tools/list.
   *
   * This is used to avoid a race condition where the client sends a prompt
   * before the agent has finished MCP initialization. The promise resolves
   * when tools/list is called or when the timeout expires.
   *
   * @param sessionId - The session to wait for
   * @param timeout - Maximum time to wait in milliseconds (default: 2000ms)
   */
  waitForToolsDiscovery(sessionId: string, timeout: number = 2000): Promise<void> {
    // If there's already a pending promise for this session, return it
    const existing = this._toolsDiscoveryBySession.get(sessionId);
    if (existing) {
      return new Promise((resolve) => {
        const originalResolve = existing.resolve;
        existing.resolve = () => {
          originalResolve();
          resolve();
        };
      });
    }

    return new Promise((resolve) => {
      const state: ToolsDiscoveryState = {
        resolve: () => {
          if (state.timeoutId) {
            clearTimeout(state.timeoutId);
          }
          this._toolsDiscoveryBySession.delete(sessionId);
          resolve();
        },
        timeoutId: setTimeout(() => {
          state.timeoutId = null;
          state.resolve();
        }, timeout),
      };
      this._toolsDiscoveryBySession.set(sessionId, state);
    });
  }

  /**
   * Resolve the tools discovery promise for a session
   */
  private _resolveToolsDiscovery(sessionId: string): void {
    const state = this._toolsDiscoveryBySession.get(sessionId);
    if (state) {
      state.resolve();
    }
  }

  /**
   * Handle an incoming mcp/disconnect notification
   */
  handleDisconnect(params: Record<string, unknown>): void {
    const connectionId = params.connectionId as string;
    this._connections.delete(connectionId);
  }

  /**
   * Check if this is an MCP-over-ACP request.
   * Note: The ACP SDK strips the underscore prefix, so we check for "mcp/".
   */
  isMcpRequest(method: string): boolean {
    return method.startsWith("mcp/");
  }

  /**
   * Route an MCP-over-ACP request to the appropriate handler.
   * Note: Methods arrive without the underscore prefix (e.g., "mcp/connect" not "_mcp/connect").
   */
  async routeRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case "mcp/connect":
        return this.handleConnect(params);
      case "mcp/message":
        return this.handleMessage(params);
      case "mcp/disconnect":
        this.handleDisconnect(params);
        return undefined;
      default:
        throw new Error(`Unknown MCP-over-ACP method: ${method}`);
    }
  }
}
