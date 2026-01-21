import type { McpServer } from "./mcp-server.js";
import type { McpOverAcpHandler } from "./mcp-over-acp-handler.js";
import type { SacpConnection } from "./connection.js";

/**
 * Session message from the agent
 */
export type SessionUpdate =
  | { type: "text"; content: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "stop"; reason: string };

/**
 * Prompt message to send to the agent
 */
export interface PromptMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Active session with an agent
 */
export class ActiveSession {
  readonly sessionId: string;
  private readonly _connection: SacpConnection;
  private readonly _mcpHandler: McpOverAcpHandler;
  private _pendingUpdates: SessionUpdate[] = [];
  private _updateResolvers: Array<(update: SessionUpdate) => void> = [];
  private _closed: boolean = false;

  constructor(
    sessionId: string,
    connection: SacpConnection,
    mcpHandler: McpOverAcpHandler
  ) {
    this.sessionId = sessionId;
    this._connection = connection;
    this._mcpHandler = mcpHandler;
    this._mcpHandler.setSessionId(sessionId);
  }

  /**
   * Send a prompt to the agent
   */
  async sendPrompt(content: string): Promise<void> {
    const response = await this._connection.sendPrompt(this.sessionId, content);
    // Push a stop update when the prompt completes
    if (response.stopReason) {
      this.pushUpdate({ type: "stop", reason: response.stopReason });
    }
  }

  /**
   * Push an update received from the agent
   */
  pushUpdate(update: SessionUpdate): void {
    if (this._updateResolvers.length > 0) {
      const resolver = this._updateResolvers.shift()!;
      resolver(update);
    } else {
      this._pendingUpdates.push(update);
    }
  }

  /**
   * Read the next update from the agent
   */
  async readUpdate(): Promise<SessionUpdate> {
    if (this._pendingUpdates.length > 0) {
      return this._pendingUpdates.shift()!;
    }

    if (this._closed) {
      return { type: "stop", reason: "session_closed" };
    }

    return new Promise((resolve) => {
      this._updateResolvers.push(resolve);
    });
  }

  /**
   * Read all updates until completion, returning concatenated text
   */
  async readToString(): Promise<string> {
    const parts: string[] = [];

    while (true) {
      const update = await this.readUpdate();

      if (update.type === "text") {
        parts.push(update.content);
      } else if (update.type === "stop") {
        break;
      }
      // tool_use updates are handled by the connection layer
    }

    return parts.join("");
  }

  /**
   * Mark the session as closed
   */
  close(): void {
    this._closed = true;
    // Resolve any pending readers
    for (const resolver of this._updateResolvers) {
      resolver({ type: "stop", reason: "session_closed" });
    }
    this._updateResolvers = [];
  }
}

/**
 * Options for waiting for MCP readiness
 */
export interface McpReadyOptions {
  /**
   * Whether to wait for the agent to call tools/list before proceeding.
   * Default: true when MCP servers are attached
   */
  enabled?: boolean;
  /**
   * Maximum time to wait for tools discovery in milliseconds.
   * Default: 2000ms
   */
  timeout?: number;
}

/**
 * Builder for creating ACP sessions with MCP servers
 */
export class SessionBuilder {
  private readonly _connection: SacpConnection;
  private readonly _mcpHandler: McpOverAcpHandler;
  private _mcpServers: McpServer[] = [];
  private _cwd: string | undefined;
  private _systemPrompt: string | undefined;
  private _mcpReadyOptions: McpReadyOptions = {};

  constructor(connection: SacpConnection, mcpHandler: McpOverAcpHandler) {
    this._connection = connection;
    this._mcpHandler = mcpHandler;
  }

  /**
   * Attach an MCP server to this session
   */
  withMcpServer(server: McpServer): this {
    this._mcpServers.push(server);
    this._mcpHandler.register(server);
    return this;
  }

  /**
   * Set the working directory for the session
   */
  cwd(path: string): this {
    this._cwd = path;
    return this;
  }

  /**
   * Set the system prompt for the session
   */
  systemPrompt(prompt: string): this {
    this._systemPrompt = prompt;
    return this;
  }

  /**
   * Configure waiting for MCP tools discovery.
   *
   * By default, when MCP servers are attached, the session will wait for
   * the agent to call tools/list before invoking the callback. This prevents
   * a race condition where the prompt is sent before the agent knows about
   * available tools.
   *
   * @param options - Options for MCP readiness waiting
   */
  waitForMcpReady(options: McpReadyOptions = {}): this {
    this._mcpReadyOptions = options;
    return this;
  }

  /**
   * Start the session and run a callback
   */
  async run<T>(callback: (session: ActiveSession) => Promise<T>): Promise<T> {
    // Create the session
    const sessionId = await this._connection.createSession({
      cwd: this._cwd,
      systemPrompt: this._systemPrompt,
      mcpServers: this._mcpServers.map((s) => s.toSessionConfig()),
    });

    const session = new ActiveSession(
      sessionId,
      this._connection,
      this._mcpHandler
    );

    // Set up the message pump for this session
    this._connection.setSessionHandler(sessionId, session);

    try {
      // Wait for MCP tools discovery if we have MCP servers attached
      const shouldWait = this._mcpServers.length > 0 &&
        (this._mcpReadyOptions.enabled !== false);

      if (shouldWait) {
        const timeout = this._mcpReadyOptions.timeout ?? 2000;
        await this._mcpHandler.waitForToolsDiscovery(sessionId, timeout);
      }

      return await callback(session);
    } finally {
      session.close();
      this._connection.removeSessionHandler(sessionId);
      // Unregister MCP servers
      for (const server of this._mcpServers) {
        this._mcpHandler.unregister(server);
      }
    }
  }
}
