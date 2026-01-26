import {
  ClientSideConnection,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type McpServer as AcpMcpServer,
  type Stream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import {
  Conductor,
  fromCommands,
  createChannelPair,
  type ComponentConnector,
  type ComponentConnection,
  type JsonRpcMessage,
} from "@thinkwell/conductor";
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
 * Cleanup function called when the connection closes
 */
type CleanupFn = () => void;

/**
 * Connection to the SACP conductor via the ACP SDK.
 *
 * This class wraps the official @agentclientprotocol/sdk's ClientSideConnection
 * and adds SACP-specific functionality (MCP-over-ACP handling).
 *
 * Supports two modes:
 * - Subprocess mode: spawns a conductor as a child process
 * - In-process mode: runs the conductor in the same process
 */
export class SacpConnection {
  private readonly _cleanup: CleanupFn;
  private readonly _connection: ClientSideConnection;
  private readonly _mcpHandler: McpOverAcpHandler;
  private readonly _sessionHandlers: Map<string, ActiveSession> = new Map();
  private _initialized: boolean = false;

  constructor(
    cleanup: CleanupFn,
    connection: ClientSideConnection,
    mcpHandler: McpOverAcpHandler
  ) {
    this._cleanup = cleanup;
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
    this._cleanup();
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
 * Connect to an agent via the TypeScript conductor.
 *
 * This creates an in-process conductor that spawns the specified agent command
 * as a subprocess and routes ACP messages through it.
 *
 * @param command - The agent command to run (e.g., ["claude-code-agent"])
 * @returns A SacpConnection for communicating with the agent
 */
export async function connect(command: string[]): Promise<SacpConnection> {
  if (command.length === 0) {
    throw new Error("Agent command cannot be empty");
  }

  // Create a conductor that spawns the agent as a subprocess
  const conductor = new Conductor({
    instantiator: fromCommands(command),
  });

  return connectToConductor(conductor);
}

/**
 * Connect to an in-process conductor.
 *
 * This runs the conductor in the same process, avoiding subprocess overhead.
 * The conductor will manage components (proxies and agent) according to its
 * configured instantiator.
 *
 * @param conductor - The configured Conductor instance to connect to
 * @returns A SacpConnection wrapping the in-process conductor
 */
export async function connectToConductor(
  conductor: Conductor
): Promise<SacpConnection> {
  // Create an in-memory channel pair for client ↔ conductor communication
  const pair = createChannelPair();

  // Create a Stream adapter from the ComponentConnection
  const stream = componentConnectionToStream(pair.left);

  // Create the MCP handler
  const mcpHandler = new McpOverAcpHandler();

  // Use a holder object to break the circular reference
  const connectionHolder: { connection: SacpConnection | null } = { connection: null };

  // Create the ACP client connection
  const clientConnection = new ClientSideConnection(
    (_agent: Agent) => createClient(connectionHolder, mcpHandler),
    stream
  );

  // Create a connector that provides the other end of the channel
  const clientConnector: ComponentConnector = {
    async connect() {
      return pair.right;
    },
  };

  // Start the conductor's message loop in the background
  const conductorPromise = conductor.connect(clientConnector);

  // Handle conductor errors/completion
  conductorPromise.catch((error) => {
    console.error("Conductor error:", error);
  });

  // Cleanup shuts down the conductor
  const cleanup = () => {
    conductor.shutdown().catch((error) => {
      console.error("Conductor shutdown error:", error);
    });
  };

  const sacpConnection = new SacpConnection(cleanup, clientConnection, mcpHandler);
  connectionHolder.connection = sacpConnection;

  return sacpConnection;
}

/**
 * Convert a ComponentConnection to the SDK's Stream interface.
 *
 * The SDK expects Web Streams of AnyMessage objects, while the conductor
 * uses a simpler send/messages interface.
 */
function componentConnectionToStream(connection: ComponentConnection): Stream {
  // Create a ReadableStream from the async iterable
  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      try {
        for await (const message of connection.messages) {
          controller.enqueue(message as AnyMessage);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  // Create a WritableStream that sends to the connection
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      connection.send(message as JsonRpcMessage);
    },
    close() {
      connection.close();
    },
  });

  return { readable, writable };
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
