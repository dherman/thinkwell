import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type McpServer as AcpMcpServer,
} from "@agentclientprotocol/sdk";
import { McpOverAcpHandler } from "./mcp-over-acp-handler.js";
import type { ActiveSession, SessionUpdate } from "./session.js";
import type { McpServerConfig } from "./types.js";

/**
 * Session creation options
 */
export interface SessionOptions {
  cwd?: string;
  systemPrompt?: string;
  mcpServers?: McpServerConfig[];
}

/**
 * Connection to the SACP conductor via the ACP SDK.
 *
 * This class wraps the official @agentclientprotocol/sdk's ClientSideConnection
 * and adds SACP-specific functionality (MCP-over-ACP handling).
 */
export class SacpConnection {
  private readonly _process: ChildProcess;
  private readonly _connection: ClientSideConnection;
  private readonly _mcpHandler: McpOverAcpHandler;
  private readonly _sessionHandlers: Map<string, ActiveSession> = new Map();
  private _initialized: boolean = false;

  constructor(
    process: ChildProcess,
    connection: ClientSideConnection,
    mcpHandler: McpOverAcpHandler
  ) {
    this._process = process;
    this._connection = connection;
    this._mcpHandler = mcpHandler;
  }

  /**
   * Get the MCP handler for registering servers
   */
  get mcpHandler(): McpOverAcpHandler {
    return this._mcpHandler;
  }

  /**
   * Initialize the connection (negotiate protocol version and capabilities)
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    await this._connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    this._initialized = true;
  }

  /**
   * Create a new session
   */
  async createSession(options: SessionOptions): Promise<string> {
    await this.initialize();

    // Convert our McpServerConfig to the SDK's McpServer type
    const mcpServers: AcpMcpServer[] = (options.mcpServers ?? []).map((s) => ({
      type: "http" as const,
      name: s.name,
      url: s.url,
      headers: [],
    }));

    const request: NewSessionRequest = {
      cwd: options.cwd ?? process.cwd(),
      mcpServers,
    };

    const response = await this._connection.newSession(request);
    return response.sessionId;
  }

  /**
   * Send a prompt to an existing session
   */
  async sendPrompt(sessionId: string, content: string): Promise<PromptResponse> {
    const request: PromptRequest = {
      sessionId,
      prompt: [{ type: "text", text: content }],
    };

    return this._connection.prompt(request);
  }

  /**
   * Set the handler for session updates
   */
  setSessionHandler(sessionId: string, handler: ActiveSession): void {
    this._sessionHandlers.set(sessionId, handler);
  }

  /**
   * Remove the handler for session updates
   */
  removeSessionHandler(sessionId: string): void {
    this._sessionHandlers.delete(sessionId);
  }

  /**
   * Handle a session update notification from the agent
   */
  handleSessionUpdate(notification: SessionNotification): void {
    const { sessionId } = notification;
    const handler = this._sessionHandlers.get(sessionId);
    if (!handler) {
      console.error(`No handler for session: ${sessionId}`);
      return;
    }

    // Convert ACP notification to our SessionUpdate type
    const update = this._convertNotification(notification);
    if (update) {
      handler.pushUpdate(update);
    }
  }

  private _convertNotification(notification: SessionNotification): SessionUpdate | null {
    const { update } = notification;

    // Use the sessionUpdate discriminator to determine type
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk":
      case "agent_thought_chunk": {
        const content = update.content;
        if (content.type === "text") {
          return { type: "text", content: content.text };
        }
        break;
      }

      case "tool_call": {
        return {
          type: "tool_use",
          id: update.toolCallId,
          name: update.title,
          input: update.rawInput ?? {},
        };
      }

      case "plan":
      case "tool_call_update":
      case "available_commands_update":
      case "current_mode_update":
        // These are informational updates we don't need to handle
        break;
    }

    return null;
  }

  /**
   * Close the connection
   */
  close(): void {
    this._process.kill();
  }
}

/**
 * Create a Client implementation that handles incoming agent requests
 */
function createClient(
  connectionHolder: { connection: SacpConnection | null },
  mcpHandler: McpOverAcpHandler
): Client {
  return {
    // Required: Handle session updates from the agent
    sessionUpdate(notification: SessionNotification): Promise<void> {
      if (!connectionHolder.connection) {
        console.error("Connection not yet initialized, dropping session update");
        return Promise.resolve();
      }
      connectionHolder.connection.handleSessionUpdate(notification);
      return Promise.resolve();
    },

    // Required: Handle permission requests
    requestPermission(
      request: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      // For now, auto-approve by selecting the first option
      // In a real client, this would prompt the user
      const firstOption = request.options[0];
      return Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: firstOption?.optionId ?? "approve",
        },
      });
    },

    // Extension method handler for _mcp/* requests
    async extMethod(
      method: string,
      params: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      if (mcpHandler.isMcpRequest(method)) {
        const result = await mcpHandler.routeRequest(method, params);
        return (result as Record<string, unknown>) ?? {};
      }
      throw new Error(`Unknown extension method: ${method}`);
    },

    // Extension notification handler
    async extNotification(
      method: string,
      params: Record<string, unknown>
    ): Promise<void> {
      if (mcpHandler.isMcpRequest(method)) {
        await mcpHandler.routeRequest(method, params);
      }
    },
  };
}

/**
 * Convert Node.js streams to Web Streams for the ACP SDK
 */
function nodeToWebStreams(
  stdout: Readable,
  stdin: Writable
): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  // Convert Node readable to Web ReadableStream
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      stdout.on("end", () => {
        controller.close();
      });
      stdout.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      stdout.destroy();
    },
  });

  // Convert Node writable to Web WritableStream
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        stdin.write(Buffer.from(chunk), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        stdin.end(() => resolve());
      });
    },
    abort(reason) {
      stdin.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  });

  return { readable, writable };
}

/**
 * Connect to a conductor process
 */
export async function connect(command: string[]): Promise<SacpConnection> {
  if (command.length === 0) {
    throw new Error("Conductor command cannot be empty");
  }

  const [cmd, ...args] = command;
  const childProcess = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!childProcess.stdout || !childProcess.stdin) {
    throw new Error("Conductor process must have stdio");
  }

  // Log stderr for debugging
  childProcess.stderr?.on("data", (data: Buffer) => {
    console.error("[conductor stderr]", data.toString());
  });

  // Convert Node streams to Web streams for the SDK
  const { readable, writable } = nodeToWebStreams(
    childProcess.stdout,
    childProcess.stdin
  );

  // Create the ndjson stream
  const stream = ndJsonStream(writable, readable);

  // Create the MCP handler
  const mcpHandler = new McpOverAcpHandler();

  // Use a holder object to break the circular reference.
  // The client factory is called lazily by ClientSideConnection,
  // so we need the holder to be populated before any messages arrive.
  const connectionHolder: { connection: SacpConnection | null } = { connection: null };

  // Create the ACP client connection
  const clientConnection = new ClientSideConnection(
    (_agent: Agent) => createClient(connectionHolder, mcpHandler),
    stream
  );

  // Create our wrapper connection and store it in the holder
  const sacpConnection = new SacpConnection(childProcess, clientConnection, mcpHandler);
  connectionHolder.connection = sacpConnection;

  return sacpConnection;
}

/**
 * Create a session builder for this connection
 */
export function session(connection: SacpConnection): SessionBuilder {
  return new SessionBuilder(connection, connection.mcpHandler);
}

// Re-export for convenience
import { SessionBuilder } from "./session.js";
export { SessionBuilder };
