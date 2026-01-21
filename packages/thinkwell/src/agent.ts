import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent as AcpAgent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type McpServer as AcpMcpServer,
} from "@agentclientprotocol/sdk";
import {
  McpOverAcpHandler,
  type SchemaProvider,
  type SessionUpdate,
} from "@thinkwell/acp";
import { ThinkBuilder } from "./think-builder.js";
import { Session } from "./session.js";

/**
 * Options for connecting to an agent
 */
export interface ConnectOptions {
  /**
   * Path to the conductor binary.
   * If not specified, uses SACP_CONDUCTOR_PATH env var or searches PATH.
   */
  conductorPath?: string;

  /**
   * Environment variables for the agent process
   */
  env?: Record<string, string>;

  /**
   * Connection timeout in milliseconds
   */
  timeout?: number;
}

/**
 * Options for creating a session
 */
export interface SessionOptions {
  /**
   * Working directory for the session
   */
  cwd?: string;

  /**
   * System prompt for the session
   */
  systemPrompt?: string;
}

/**
 * Interface for handling session updates
 * @internal
 */
export interface SessionHandler {
  pushUpdate(update: SessionUpdate): void;
}

/**
 * Internal connection state shared between Agent and Session
 * @internal
 */
export interface AgentConnection {
  process: ChildProcess;
  connection: ClientSideConnection;
  mcpHandler: McpOverAcpHandler;
  sessionHandlers: Map<string, SessionHandler>;
  initialized: boolean;
}

/**
 * The main entry point for Patchwork.
 *
 * Agent represents a connection to an AI agent (like Claude Code) and provides
 * a fluent API for blending deterministic code with LLM-powered reasoning.
 *
 * @example Simple usage with ephemeral sessions
 * ```typescript
 * import { Agent, schemaOf } from "@anthropic/patchwork";
 *
 * const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");
 *
 * const summary = await agent
 *   .think(schemaOf<{ title: string; points: string[] }>({
 *     type: "object",
 *     properties: {
 *       title: { type: "string" },
 *       points: { type: "array", items: { type: "string" } }
 *     },
 *     required: ["title", "points"]
 *   }))
 *   .text("Summarize this document:")
 *   .quote(document)
 *   .run();
 *
 * agent.close();
 * ```
 *
 * @example Multi-turn conversation with explicit session
 * ```typescript
 * const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");
 * const session = await agent.createSession({ cwd: "/my/project" });
 *
 * const analysis = await session
 *   .think(AnalysisSchema)
 *   .text("Analyze this codebase")
 *   .run();
 *
 * // Same session - agent remembers context
 * const fixes = await session
 *   .think(FixesSchema)
 *   .text("Suggest fixes for the top issues")
 *   .run();
 *
 * session.close();
 * agent.close();
 * ```
 */
export class Agent {
  private readonly _conn: AgentConnection;

  private constructor(conn: AgentConnection) {
    this._conn = conn;
  }

  /**
   * Connect to an agent.
   *
   * @param command - The command to spawn the agent process (e.g., "npx -y @zed-industries/claude-code-acp")
   * @param options - Connection options
   * @returns A connected Agent instance
   *
   * @example
   * ```typescript
   * const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");
   * ```
   */
  static async connect(command: string, options?: ConnectOptions): Promise<Agent> {
    const conductorPath = findConductor(options?.conductorPath);
    const conductorArgs = ["agent", command];

    const childProcess = spawn(conductorPath, conductorArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env ? { ...process.env, ...options.env } : process.env,
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

    // Build the connection state
    const conn: AgentConnection = {
      process: childProcess,
      connection: null!, // Set below after creating the client
      mcpHandler,
      sessionHandlers: new Map(),
      initialized: false,
    };

    // Create the ACP client connection
    const clientConnection = new ClientSideConnection(
      (_agent: AcpAgent) => createClient(conn, mcpHandler),
      stream
    );
    conn.connection = clientConnection;

    return new Agent(conn);
  }

  /**
   * Create a new think builder for constructing a prompt with tools.
   *
   * Each call to `think()` creates an ephemeral session that is automatically
   * closed when the prompt completes. For multi-turn conversations, use
   * `createSession()` instead.
   *
   * @param schema - A SchemaProvider that defines the expected output structure
   *
   * @example
   * ```typescript
   * const result = await agent
   *   .think(schemaOf<{ answer: string }>({
   *     type: "object",
   *     properties: { answer: { type: "string" } },
   *     required: ["answer"]
   *   }))
   *   .text("What is 2 + 2?")
   *   .run();
   * ```
   */
  think<Output>(schema: SchemaProvider<Output>): ThinkBuilder<Output>;

  /**
   * Create a new think builder without a schema.
   *
   * @deprecated Use `think(schemaOf<T>(schema))` instead to provide a typed schema.
   */
  think<Output>(): ThinkBuilder<Output>;

  think<Output>(schema?: SchemaProvider<Output>): ThinkBuilder<Output> {
    return new ThinkBuilder<Output>(this._conn, schema);
  }

  /**
   * Create a new session for multi-turn conversations.
   *
   * Sessions maintain conversation context across multiple `think()` calls,
   * allowing the agent to remember previous interactions.
   *
   * @param options - Session configuration options
   * @returns A Session instance
   *
   * @example
   * ```typescript
   * const session = await agent.createSession({ cwd: "/my/project" });
   *
   * // First turn
   * const result1 = await session.think(Schema1).text("...").run();
   *
   * // Second turn - agent remembers context
   * const result2 = await session.think(Schema2).text("...").run();
   *
   * session.close();
   * ```
   */
  async createSession(options?: SessionOptions): Promise<Session> {
    await this._initialize();

    const request: NewSessionRequest = {
      cwd: options?.cwd ?? process.cwd(),
      mcpServers: [],
    };

    const response = await this._conn.connection.newSession(request);
    return new Session(this._conn, response.sessionId, options);
  }

  /**
   * Close the connection to the agent.
   *
   * This terminates the conductor process. Any active sessions will be
   * invalidated.
   */
  close(): void {
    this._conn.process.kill();
  }

  /**
   * Get the internal connection for use by ThinkBuilder
   * @internal
   */
  get _connection(): AgentConnection {
    return this._conn;
  }

  /**
   * Initialize the connection (negotiate protocol version)
   * @internal
   */
  async _initialize(): Promise<void> {
    if (this._conn.initialized) return;

    await this._conn.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    this._conn.initialized = true;
  }
}

/**
 * Find the conductor binary
 */
function findConductor(explicitPath?: string): string {
  // 1. Use explicit path if provided
  if (explicitPath) {
    return explicitPath;
  }

  // 2. Check environment variable
  const envPath = process.env.SACP_CONDUCTOR_PATH;
  if (envPath) {
    return envPath;
  }

  // 3. Assume it's in PATH
  return "sacp-conductor";
}

/**
 * Convert Node.js streams to Web Streams for the ACP SDK
 */
function nodeToWebStreams(
  stdout: Readable,
  stdin: Writable
): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
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
 * Create a Client implementation that handles incoming agent requests
 */
function createClient(
  conn: AgentConnection,
  mcpHandler: McpOverAcpHandler
): Client {
  return {
    sessionUpdate(notification: SessionNotification): Promise<void> {
      const { sessionId } = notification;
      const handler = conn.sessionHandlers.get(sessionId);
      if (!handler) {
        console.error(`No handler for session: ${sessionId}`);
        return Promise.resolve();
      }

      const update = convertNotification(notification);
      if (update) {
        handler.pushUpdate(update);
      }
      return Promise.resolve();
    },

    requestPermission(
      request: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      const firstOption = request.options[0];
      return Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: firstOption?.optionId ?? "approve",
        },
      });
    },

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
 * Convert ACP notification to SessionUpdate
 */
function convertNotification(notification: SessionNotification): SessionUpdate | null {
  const { update } = notification;

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
      break;
  }

  return null;
}
