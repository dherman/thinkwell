import type { AgentConnection, SessionOptions } from "./agent.js";
import type { SchemaProvider } from "@thinkwell/acp";
import { Plan } from "./think-builder.js";

/**
 * A session for multi-turn conversations with an agent.
 *
 * Sessions maintain conversation context across multiple `think()` calls,
 * allowing the agent to remember previous interactions. Create sessions
 * using `agent.createSession()`.
 *
 * @example
 * ```typescript
 * const session = await agent.createSession({ cwd: "/my/project" });
 *
 * // First turn
 * const analysis = await session
 *   .think(AnalysisSchema)
 *   .text("Analyze this codebase")
 *   .run();
 *
 * // Second turn - agent remembers context
 * const fixes = await session
 *   .think(FixesSchema)
 *   .text("Suggest fixes for the top issues")
 *   .run();
 *
 * session.close();
 * ```
 */
export class Session {
  private readonly _conn: AgentConnection;
  private readonly _sessionId: string;
  private readonly _options: SessionOptions | undefined;
  private _closed: boolean = false;

  /**
   * @internal
   */
  constructor(conn: AgentConnection, sessionId: string, options?: SessionOptions) {
    this._conn = conn;
    this._sessionId = sessionId;
    this._options = options;
  }

  /**
   * The unique session identifier
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Create a new plan for constructing a prompt with tools.
   *
   * Unlike `agent.think()`, prompts sent through a session maintain
   * conversation context - the agent remembers previous interactions.
   *
   * @param schema - A SchemaProvider that defines the expected output structure
   *
   * @example
   * ```typescript
   * const result = await session
   *   .think(schemaOf<{ answer: string }>({
   *     type: "object",
   *     properties: { answer: { type: "string" } },
   *     required: ["answer"]
   *   }))
   *   .text("What was the first thing I asked you?")
   *   .run();
   * ```
   */
  think<Output>(schema: SchemaProvider<Output>): Plan<Output> {
    if (this._closed) {
      throw new Error("Session is closed");
    }
    return new Plan<Output>(this._conn, schema, this._sessionId);
  }

  /**
   * Close the session.
   *
   * After closing, no more prompts can be sent through this session.
   * The agent connection remains open for other sessions.
   */
  close(): void {
    this._closed = true;
    // Note: ACP doesn't have an explicit session close message,
    // we just stop using the session ID
  }
}
