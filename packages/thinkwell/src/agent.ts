import {
  ClientSideConnection,
  type Client,
  type Agent as AcpAgent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type NewSessionRequest,
  type Stream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import {
  Conductor,
  fromCommands,
  createChannelPair,
  type CommandSpec,
  type ComponentConnection,
  type ComponentConnector,
  type JsonRpcMessage,
} from "@thinkwell/conductor";
import {
  McpOverAcpHandler,
  type SchemaProvider,
} from "@thinkwell/acp";
import { ThinkBuilder } from "./think-builder.js";
import { Session } from "./session.js";
import type { ThoughtEvent, ToolContent, ContentBlock } from "./thought-event.js";
import type {
  ToolCallContent as AcpToolCallContent,
  ContentBlock as AcpContentBlock,
} from "@agentclientprotocol/sdk";

/**
 * Known agent names that can be passed to `open()`.
 */
export type AgentName = 'claude' | 'codex' | 'gemini' | 'kiro' | 'opencode' | 'auggie';

/**
 * Maps agent names to their spawn commands.
 */
const AGENT_COMMANDS: Record<AgentName, string> = {
  claude: "npx -y @zed-industries/claude-agent-acp",
  codex: "npx -y @zed-industries/codex-acp",
  gemini: "npx -y @google/gemini-cli --experimental-acp",
  kiro: "kiro-cli acp",
  opencode: "opencode acp",
  auggie: "auggie --acp",
};

/**
 * Options for opening an agent connection.
 */
export interface AgentOptions {
  /**
   * Environment variables for the agent process.
   */
  env?: Record<string, string>;

  /**
   * Connection timeout in milliseconds.
   */
  timeout?: number;
}

/**
 * Options for opening an agent connection with a custom spawn command.
 *
 * Use this overload of `open()` when connecting to an agent that isn't
 * in the built-in {@link AgentName} list.
 *
 * @example
 * ```typescript
 * const agent = await open({ cmd: 'my-custom-agent --acp' });
 * ```
 */
export interface CustomAgentOptions extends AgentOptions {
  /**
   * The shell command to spawn the agent process.
   * The command is split on whitespace to extract the program and arguments.
   */
  cmd: string;
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
  pushUpdate(update: ThoughtEvent): void;
}

/**
 * Internal connection state shared between Agent and Session
 * @internal
 */
export interface AgentConnection {
  conductor: Conductor;
  connection: ClientSideConnection;
  mcpHandler: McpOverAcpHandler;
  sessionHandlers: Map<string, SessionHandler>;
  initialized: boolean;
  conductorPromise: Promise<void>;
}

/**
 * A connection to an AI agent (like Claude Code) that provides a fluent API
 * for blending deterministic code with LLM-powered reasoning.
 *
 * Use the top-level `open()` function to create an Agent instance.
 *
 * @example Simple usage with ephemeral sessions
 * ```typescript
 * import { open } from "thinkwell";
 *
 * /** @JSONSchema *​/
 * interface Summary {
 *   title: string;
 *   points: string[];
 * }
 *
 * const agent = await open('claude');
 * const summary = await agent
 *   .think(Summary.Schema)
 *   .text("Summarize this document:")
 *   .quote(document)
 *   .run();
 *
 * agent.close();
 * ```
 *
 * @example Multi-turn conversation with explicit session
 * ```typescript
 * import { open } from "thinkwell";
 * const agent = await open('claude');
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
export interface Agent {
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
   * /** @JSONSchema *​/
   * interface Answer { answer: string }
   *
   * const result = await agent
   *   .think(Answer.Schema)
   *   .text("What is 2 + 2?")
   *   .run();
   * ```
   */
  think<Output>(schema: SchemaProvider<Output>): ThinkBuilder<Output>;

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
  createSession(options?: SessionOptions): Promise<Session>;

  /**
   * Close the connection to the agent.
   *
   * This shuts down the conductor. Any active sessions will be invalidated.
   */
  close(): Promise<void>;
}

/** Symbol used to prevent external construction of AgentImpl. */
const AGENT_KEY = Symbol("Agent");

/**
 * @internal
 */
class AgentImpl implements Agent {
  private readonly _conn: AgentConnection;

  constructor(key: symbol, conn: AgentConnection) {
    if (key !== AGENT_KEY) {
      throw new Error("Agent cannot be constructed directly. Use open() instead.");
    }
    this._conn = conn;
  }

  think<Output>(schema: SchemaProvider<Output>): ThinkBuilder<Output> {
    return new ThinkBuilder<Output>(this._conn, schema);
  }

  async createSession(options?: SessionOptions): Promise<Session> {
    await this._initialize();

    const request: NewSessionRequest = {
      cwd: options?.cwd ?? process.cwd(),
      mcpServers: [],
    };

    const response = await this._conn.connection.newSession(request);
    return new Session(this._conn, response.sessionId, options);
  }

  async close(): Promise<void> {
    await this._conn.conductor.shutdown();
    try {
      await this._conn.conductorPromise;
    } catch (error) {
      // Conductor errors are already logged, just ensure we don't throw
      console.error('[Agent.close] Conductor promise error:', error);
    }
  }

  private async _initialize(): Promise<void> {
    if (this._conn.initialized) return;

    await this._conn.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    this._conn.initialized = true;
  }
}

/**
 * Convert a ComponentConnection to the SDK's Stream interface.
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
 * Convert an ACP ContentBlock to a Thinkwell ContentBlock, or null if unsupported.
 * @internal Exported for testing.
 */
export function convertContentBlock(block: AcpContentBlock): ContentBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "resource_link":
      return { type: "resource_link", uri: block.uri, name: block.name ?? undefined };
    default:
      return null;
  }
}

/**
 * Convert ACP ToolCallContent to Thinkwell ToolContent, or null if unsupported.
 * @internal Exported for testing.
 */
export function convertToolCallContent(content: AcpToolCallContent): ToolContent | null {
  switch (content.type) {
    case "diff":
      return { type: "diff", path: content.path, oldText: content.oldText ?? "", newText: content.newText };
    case "terminal":
      return { type: "terminal", terminalId: content.terminalId };
    case "content": {
      const block = convertContentBlock(content.content);
      if (!block) return null;
      return { type: "content", content: block };
    }
  }
}

/**
 * Convert ACP notification to ThoughtEvent.
 * @internal Exported for testing.
 */
export function convertNotification(notification: SessionNotification): ThoughtEvent | null {
  const { update } = notification;

  switch (update.sessionUpdate) {
    case "agent_thought_chunk": {
      const content = update.content;
      if (content.type === "text") {
        return { type: "thought", text: content.text };
      }
      break;
    }

    case "agent_message_chunk": {
      const content = update.content;
      if (content.type === "text") {
        return { type: "message", text: content.text };
      }
      break;
    }

    case "tool_call": {
      return {
        type: "tool_start",
        id: update.toolCallId,
        title: update.title,
        kind: update.kind,
      };
    }

    case "tool_call_update": {
      const status = update.status ?? "in_progress";
      if (status === "completed" || status === "failed") {
        return { type: "tool_done", id: update.toolCallId, status };
      }
      return {
        type: "tool_update",
        id: update.toolCallId,
        status,
        content: update.content?.map(convertToolCallContent).filter((c): c is ToolContent => c !== null),
      };
    }

    case "plan": {
      return {
        type: "plan",
        entries: update.entries.map((e) => ({
          content: e.content,
          status: e.status,
          priority: e.priority,
        })),
      };
    }

    case "user_message_chunk":
    case "available_commands_update":
    case "current_mode_update":
      break;
  }

  return null;
}

/**
 * Parse a command string into a CommandSpec with env vars attached.
 */
function parseCommandWithEnv(command: string, env: Record<string, string>): CommandSpec {
  const parts = command.split(/\s+/);
  return {
    command: parts[0],
    args: parts.slice(1),
    env,
  };
}

/**
 * Resolve the agent command string from the arguments to `open()`,
 * applying environment variable overrides.
 */
function resolveCommand(
  nameOrOptions: AgentName | (CustomAgentOptions),
  options?: AgentOptions,
): { command: string; options?: AgentOptions } {
  // Environment variable overrides take precedence
  const envCmd = process.env.THINKWELL_AGENT_CMD;
  const envAgent = process.env.THINKWELL_AGENT;

  if (envCmd) {
    const opts = typeof nameOrOptions === "string" ? options : nameOrOptions;
    return { command: envCmd, options: opts };
  }

  if (envAgent) {
    if (!(envAgent in AGENT_COMMANDS)) {
      throw new Error(
        `Unknown agent name in $THINKWELL_AGENT: '${envAgent}'. ` +
        `Valid names: ${Object.keys(AGENT_COMMANDS).join(", ")}`
      );
    }
    const opts = typeof nameOrOptions === "string" ? options : nameOrOptions;
    return { command: AGENT_COMMANDS[envAgent as AgentName], options: opts };
  }

  // No env override — resolve from arguments
  if (typeof nameOrOptions === "string") {
    return { command: AGENT_COMMANDS[nameOrOptions], options };
  }

  return { command: nameOrOptions.cmd, options: nameOrOptions };
}

/**
 * Open a connection to an AI agent.
 *
 * @example Named agent (the common case)
 * ```typescript
 * import { open } from "thinkwell";
 * const agent = await open('claude');
 * ```
 *
 * @example Custom command
 * ```typescript
 * const agent = await open({ cmd: 'myagent --acp' });
 * ```
 */
export async function open(name: AgentName, options?: AgentOptions): Promise<Agent>;
export async function open(options: CustomAgentOptions): Promise<Agent>;
export async function open(
  nameOrOptions: AgentName | (CustomAgentOptions),
  maybeOptions?: AgentOptions,
): Promise<Agent> {
  const { command, options } = resolveCommand(nameOrOptions, maybeOptions);

  // When env is provided, we need to pass a CommandOptions object.
  // Otherwise a plain string works (fromCommands parses it internally).
  const commandSpec: CommandSpec = options?.env
    ? parseCommandWithEnv(command, options.env)
    : command;

  const conductor = new Conductor({
    instantiator: fromCommands([commandSpec]),
  });

  // Create an in-memory channel pair for client ↔ conductor communication
  const pair = createChannelPair();

  // Create a Stream adapter from the ComponentConnection
  const stream = componentConnectionToStream(pair.left);

  // Create the MCP handler
  const mcpHandler = new McpOverAcpHandler();

  // Build the connection state
  const conn: AgentConnection = {
    conductor,
    connection: null!, // Set below after creating the client
    mcpHandler,
    sessionHandlers: new Map(),
    initialized: false,
    conductorPromise: null!, // Set below after starting the conductor
  };

  // Create the ACP client connection
  const clientConnection = new ClientSideConnection(
    (_agent: AcpAgent) => createClient(conn, mcpHandler),
    stream
  );
  conn.connection = clientConnection;

  // Create a connector that provides the other end of the channel
  const clientConnector: ComponentConnector = {
    async connect() {
      return pair.right;
    },
  };

  // Start the conductor's message loop in the background
  conn.conductorPromise = conductor.connect(clientConnector);

  // Handle conductor errors/completion
  conn.conductorPromise.catch((error: unknown) => {
    console.error("Conductor error:", error);
  });

  return new AgentImpl(AGENT_KEY, conn);
}
