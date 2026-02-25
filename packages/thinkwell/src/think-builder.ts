import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  mcpServer,
  createSkillServer,
  parseSkillMd,
  validateSkillName,
  validateSkillDescription,
  type SchemaProvider,
  type VirtualSkill,
  type StoredSkill,
  type SkillTool,
  type ResolvedSkill,
} from "@thinkwell/acp";
import type { AgentConnection, SessionHandler } from "./agent.js";
import type {
  NewSessionRequest,
  McpServer as AcpMcpServer,
} from "@agentclientprotocol/sdk";
import type { ThoughtEvent } from "./thought-event.js";
import { ThoughtStream } from "./thought-stream.js";

/**
 * A deferred stored skill: the path to a SKILL.md file that will be
 * parsed at run() time.
 */
interface DeferredStoredSkill {
  type: "stored";
  path: string;
}

/**
 * A virtual skill definition provided programmatically.
 * Validated eagerly at .skill() call time.
 */
interface DeferredVirtualSkill {
  type: "virtual";
  skill: VirtualSkill;
}

/**
 * Internal representation of a skill attachment before resolution.
 */
type DeferredSkill = DeferredStoredSkill | DeferredVirtualSkill;

/**
 * Input for defining a virtual skill via the .skill() method.
 */
export interface VirtualSkillDefinition {
  name: string;
  description: string;
  body: string;
  tools?: SkillTool[];
}

/**
 * Tool definition for internal tracking
 */
interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  handler: (input: I) => Promise<O>;
  inputSchema: SchemaProvider<I>;
  outputSchema: SchemaProvider<O>;
  includeInPrompt: boolean;
}

/** Internal event type: ThoughtEvent from the agent, or a synthetic stop signal. */
type InternalUpdate = ThoughtEvent | { type: "stop"; reason: string };

/**
 * Internal session handler for ThinkBuilder
 */
class ThinkSession implements SessionHandler {
  readonly sessionId: string;
  private readonly _conn: AgentConnection;
  private _pendingUpdates: InternalUpdate[] = [];
  private _updateResolvers: Array<(update: InternalUpdate) => void> = [];
  private _closed: boolean = false;

  constructor(sessionId: string, conn: AgentConnection) {
    this.sessionId = sessionId;
    this._conn = conn;
  }

  async sendPrompt(content: string): Promise<void> {
    const response = await this._conn.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: content }],
    });
    if (response.stopReason) {
      this._pushInternal({ type: "stop", reason: response.stopReason });
    }
  }

  pushUpdate(update: ThoughtEvent): void {
    this._pushInternal(update);
  }

  private _pushInternal(update: InternalUpdate): void {
    if (this._updateResolvers.length > 0) {
      const resolver = this._updateResolvers.shift()!;
      resolver(update);
    } else {
      this._pendingUpdates.push(update);
    }
  }

  async readUpdate(): Promise<InternalUpdate> {
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

  close(): void {
    this._closed = true;
    for (const resolver of this._updateResolvers) {
      resolver({ type: "stop", reason: "session_closed" });
    }
    this._updateResolvers = [];
  }
}

/**
 * Fluent builder for composing a plan — a prompt with tools, skills,
 * and an output schema — that an agent will execute.
 *
 * Plan provides a chainable API for:
 * - Adding literal text to the prompt
 * - Interpolating values
 * - Registering tools the LLM can call
 * - Executing the prompt and returning a typed result
 *
 * Plan is immutable: every builder method returns a **new** Plan with the
 * updated state, leaving the original unchanged.
 */
export interface Plan<Output> {
  /**
   * Add literal text to the prompt.
   */
  text(content: string): Plan<Output>;

  /**
   * Add a line of text with newline.
   */
  textln(content: string): Plan<Output>;

  /**
   * Quote some content delimited by XML-style tags.
   */
  quote(content: string, tag?: string): Plan<Output>;

  /**
   * Quote some content as a Markdown-style code block.
   */
  code(content: string, language?: string): Plan<Output>;

  /**
   * Register a tool and reference it in the prompt.
   *
   * The tool will be mentioned in the prompt text to help the LLM
   * understand that it's available.
   */
  tool<I, O>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    outputSchema: SchemaProvider<O>,
    handler: (input: I) => Promise<O>
  ): Plan<Output>;

  /**
   * Register a tool with only an input schema.
   */
  tool<I>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    handler: (input: I) => Promise<unknown>
  ): Plan<Output>;

  /**
   * Register a tool without schemas.
   */
  tool(
    name: string,
    description: string,
    handler: (input: unknown) => Promise<unknown>
  ): Plan<Output>;

  /**
   * Register a tool without adding a prompt reference.
   *
   * Use this for tools that should be available but don't need
   * to be explicitly mentioned in the prompt.
   */
  defineTool<I, O>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    outputSchema: SchemaProvider<O>,
    handler: (input: I) => Promise<O>
  ): Plan<Output>;

  /**
   * Register a tool with only an input schema (no prompt reference).
   */
  defineTool<I>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    handler: (input: I) => Promise<unknown>
  ): Plan<Output>;

  /**
   * Register a tool without schemas (no prompt reference).
   */
  defineTool(
    name: string,
    description: string,
    handler: (input: unknown) => Promise<unknown>
  ): Plan<Output>;

  /**
   * Attach a skill to this prompt.
   *
   * When called with a string, it is treated as a path to a SKILL.md file
   * that will be parsed at run() time (deferred stored skill).
   *
   * When called with an object, it is treated as a virtual skill definition
   * and validated eagerly.
   */
  skill(pathOrDef: string | VirtualSkillDefinition): Plan<Output>;

  /**
   * Set the working directory for the session.
   */
  cwd(path: string): Plan<Output>;

  /**
   * Execute the prompt and return the result.
   */
  run(): Promise<Output>;

  /**
   * Start executing the prompt, returning a stream handle that provides
   * both an async iterable of intermediate `ThoughtEvent`s and a `.result`
   * promise for the final typed output.
   *
   * Execution begins eagerly — the returned stream is already "hot".
   */
  stream(): ThoughtStream<Output>;
}

/**
 * Internal state bag for PlanImpl. Used by the clone helper to
 * selectively override fields.
 */
interface PlanState<Output> {
  conn: AgentConnection;
  promptParts: readonly string[];
  tools: ReadonlyMap<string, ToolDefinition>;
  skills: readonly DeferredSkill[];
  schemaProvider: SchemaProvider<Output> | undefined;
  cwd: string | undefined;
  existingSessionId: string | undefined;
}

class PlanImpl<Output> implements Plan<Output> {
  private readonly _conn: AgentConnection;
  private readonly _promptParts: readonly string[];
  private readonly _tools: ReadonlyMap<string, ToolDefinition>;
  private readonly _skills: readonly DeferredSkill[];
  private readonly _schemaProvider: SchemaProvider<Output> | undefined;
  private readonly _cwd: string | undefined;
  private readonly _existingSessionId: string | undefined;

  constructor(state: PlanState<Output>) {
    this._conn = state.conn;
    this._promptParts = state.promptParts;
    this._tools = state.tools;
    this._skills = state.skills;
    this._schemaProvider = state.schemaProvider;
    this._cwd = state.cwd;
    this._existingSessionId = state.existingSessionId;
  }

  private _clone(overrides: Partial<PlanState<Output>>): PlanImpl<Output> {
    return new PlanImpl<Output>({
      conn: this._conn,
      promptParts: this._promptParts,
      tools: this._tools,
      skills: this._skills,
      schemaProvider: this._schemaProvider,
      cwd: this._cwd,
      existingSessionId: this._existingSessionId,
      ...overrides,
    });
  }

  text(content: string): Plan<Output> {
    return this._clone({ promptParts: [...this._promptParts, content] });
  }

  textln(content: string): Plan<Output> {
    return this._clone({ promptParts: [...this._promptParts, content + "\n"] });
  }

  quote(content: string, tag: string = "quote"): Plan<Output> {
    const part = !content.includes("\n")
      ? `<${tag}>${content}</${tag}>\n`
      : `<${tag}>\n${content}\n</${tag}>\n`;
    return this._clone({ promptParts: [...this._promptParts, part] });
  }

  code(content: string, language: string = ""): Plan<Output> {
    return this._clone({
      promptParts: [...this._promptParts, `\`\`\`${language}\n${content}\n\`\`\`\n`],
    });
  }

  tool<I, O>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    outputSchema: SchemaProvider<O>,
    handler: (input: I) => Promise<O>
  ): Plan<Output>;
  tool<I>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    handler: (input: I) => Promise<unknown>
  ): Plan<Output>;
  tool(
    name: string,
    description: string,
    handler: (input: unknown) => Promise<unknown>
  ): Plan<Output>;
  tool<I, O>(
    name: string,
    description: string,
    inputSchemaOrHandler: SchemaProvider<I> | ((input: I) => Promise<O>),
    outputSchemaOrHandler?: SchemaProvider<O> | ((input: I) => Promise<O>),
    handler?: (input: I) => Promise<O>
  ): Plan<Output> {
    let inputSchema: SchemaProvider<unknown>;
    let outputSchema: SchemaProvider<unknown>;
    let actualHandler: (input: unknown) => Promise<unknown>;

    if (typeof inputSchemaOrHandler === "function") {
      inputSchema = { toJsonSchema: () => ({ type: "object" }) };
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = inputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else if (typeof outputSchemaOrHandler === "function") {
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = outputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else {
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = outputSchemaOrHandler as SchemaProvider<unknown>;
      actualHandler = handler as (input: unknown) => Promise<unknown>;
    }

    const newTools = new Map(this._tools);
    newTools.set(name, {
      name,
      description,
      handler: actualHandler,
      inputSchema,
      outputSchema,
      includeInPrompt: true,
    });
    return this._clone({ tools: newTools });
  }

  defineTool<I, O>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    outputSchema: SchemaProvider<O>,
    handler: (input: I) => Promise<O>
  ): Plan<Output>;
  defineTool<I>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    handler: (input: I) => Promise<unknown>
  ): Plan<Output>;
  defineTool(
    name: string,
    description: string,
    handler: (input: unknown) => Promise<unknown>
  ): Plan<Output>;
  defineTool<I, O>(
    name: string,
    description: string,
    inputSchemaOrHandler: SchemaProvider<I> | ((input: I) => Promise<O>),
    outputSchemaOrHandler?: SchemaProvider<O> | ((input: I) => Promise<O>),
    handler?: (input: I) => Promise<O>
  ): Plan<Output> {
    let inputSchema: SchemaProvider<unknown>;
    let outputSchema: SchemaProvider<unknown>;
    let actualHandler: (input: unknown) => Promise<unknown>;

    if (typeof inputSchemaOrHandler === "function") {
      inputSchema = { toJsonSchema: () => ({ type: "object" }) };
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = inputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else if (typeof outputSchemaOrHandler === "function") {
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = outputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else {
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = outputSchemaOrHandler as SchemaProvider<unknown>;
      actualHandler = handler as (input: unknown) => Promise<unknown>;
    }

    const newTools = new Map(this._tools);
    newTools.set(name, {
      name,
      description,
      handler: actualHandler,
      inputSchema,
      outputSchema,
      includeInPrompt: false,
    });
    return this._clone({ tools: newTools });
  }

  skill(pathOrDef: string | VirtualSkillDefinition): Plan<Output> {
    if (typeof pathOrDef === "string") {
      return this._clone({ skills: [...this._skills, { type: "stored", path: pathOrDef }] });
    } else {
      validateSkillName(pathOrDef.name);
      validateSkillDescription(pathOrDef.description);
      return this._clone({
        skills: [...this._skills, {
          type: "virtual",
          skill: {
            name: pathOrDef.name,
            description: pathOrDef.description,
            body: pathOrDef.body,
            tools: pathOrDef.tools,
          },
        }],
      });
    }
  }

  cwd(path: string): Plan<Output> {
    return this._clone({ cwd: path });
  }

  private async _resolveSkills(): Promise<ResolvedSkill[]> {
    const resolved: ResolvedSkill[] = [];

    for (const deferred of this._skills) {
      if (deferred.type === "virtual") {
        resolved.push(deferred.skill);
      } else {
        const content = await readFile(deferred.path, "utf-8");
        const parsed = parseSkillMd(content);
        const stored: StoredSkill = {
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          basePath: dirname(deferred.path),
        };
        resolved.push(stored);
      }
    }

    return resolved;
  }

  private _buildSkillsPrompt(skills: ResolvedSkill[]): string {
    if (skills.length === 0) return "";

    let xml = "<available_skills>\n";
    for (const skill of skills) {
      xml += `  <skill>\n`;
      xml += `    <name>${skill.name}</name>\n`;
      xml += `    <description>${skill.description}</description>\n`;
      xml += `  </skill>\n`;
    }
    xml += "</available_skills>\n";

    xml += "\n";
    xml += "The above skills are available to you. When a task matches a skill's description,\n";
    xml += "call the `activate_skill` tool with the skill name to load its full instructions.\n";
    xml += "If the skill provides tools, use `call_skill_tool` to invoke them.\n";
    xml += "If the skill references files, use `read_skill_file` to access them.\n";

    return xml + "\n";
  }

  async run(): Promise<Output> {
    return this.stream().result;
  }

  stream(): ThoughtStream<Output> {
    const stream = new ThoughtStream<Output>();
    this._executeStream(stream).catch((err) => stream.rejectResult(err));
    return stream;
  }

  private async _executeStream(stream: ThoughtStream<Output>): Promise<void> {
    // Ensure initialized
    if (!this._conn.initialized) {
      await this._conn.connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });
      this._conn.initialized = true;
    }

    // Resolve deferred skills
    const resolvedSkills = await this._resolveSkills();

    // Build the prompt: skills block first, then user prompt parts
    let prompt = this._buildSkillsPrompt(resolvedSkills) + this._promptParts.join("");

    // Add tool references to the prompt
    const toolsWithPrompt = Array.from(this._tools.values()).filter(
      (t) => t.includeInPrompt
    );
    if (toolsWithPrompt.length > 0) {
      prompt += "\n\nAvailable tools:\n";
      for (const tool of toolsWithPrompt) {
        prompt += `- ${tool.name}: ${tool.description}\n`;
      }
    }

    // Create the MCP server builder
    const serverBuilder = mcpServer("thinkwell");

    // Track if we've received a result
    let resultReceived = false;
    let result: Output | undefined;

    // Get the output schema for the return_result tool.
    // The Anthropic API requires tool input schemas to have type: "object" at
    // the root. Union types (anyOf/oneOf) don't satisfy this, so we wrap them
    // in a single-property object and unwrap in the handler.
    const rawSchema = this._schemaProvider?.toJsonSchema() ?? { type: "object" };
    const needsWrap = rawSchema.type !== "object";
    const outputSchema = needsWrap
      ? { type: "object", properties: { result: rawSchema }, required: ["result"] }
      : rawSchema;

    // Add return instruction
    prompt += "\n\nWhen you have your answer, call the `return_result` MCP tool with the result.";

    // Add the return_result tool
    serverBuilder.tool(
      "return_result",
      "Return the final result",
      outputSchema,
      { type: "object", properties: { success: { type: "boolean" } } },
      async (input: unknown) => {
        result = (needsWrap ? (input as Record<string, unknown>).result : input) as Output;
        resultReceived = true;
        return { success: true };
      }
    );

    // Add all registered tools
    for (const tool of this._tools.values()) {
      serverBuilder.tool(
        tool.name,
        tool.description,
        tool.inputSchema.toJsonSchema(),
        tool.outputSchema.toJsonSchema(),
        async (input: unknown, _context) => {
          return tool.handler(input);
        }
      );
    }

    const server = serverBuilder.build();

    // Build skill MCP server if skills are present
    const skillServer = resolvedSkills.length > 0
      ? createSkillServer(resolvedSkills)
      : undefined;

    // Register the MCP server(s)
    this._conn.mcpHandler.register(server);
    if (skillServer) {
      this._conn.mcpHandler.register(skillServer);
    }
    this._conn.mcpHandler.setSessionId(this._existingSessionId ?? "pending");

    try {
      // Create or reuse session
      let sessionId: string;

      if (this._existingSessionId) {
        // Reuse existing session
        sessionId = this._existingSessionId;
      } else {
        // Create new ephemeral session
        const mcpServers: AcpMcpServer[] = [{
          type: "http" as const,
          name: server.name,
          url: server.acpUrl,
          headers: [],
        }];

        if (skillServer) {
          mcpServers.push({
            type: "http" as const,
            name: skillServer.name,
            url: skillServer.acpUrl,
            headers: [],
          });
        }

        const request: NewSessionRequest = {
          cwd: this._cwd ?? process.cwd(),
          mcpServers,
        };

        const response = await this._conn.connection.newSession(request);
        sessionId = response.sessionId;
      }

      // Update MCP handler with actual session ID
      this._conn.mcpHandler.setSessionId(sessionId);

      // Create internal session handler
      const session = new ThinkSession(sessionId, this._conn);
      this._conn.sessionHandlers.set(sessionId, session);

      // Wait for MCP tools discovery
      await this._conn.mcpHandler.waitForToolsDiscovery(sessionId, 2000);

      try {
        // Start the prompt without awaiting - we need to read updates concurrently
        const promptPromise = session.sendPrompt(prompt);

        // Read updates, forwarding events to the stream and watching for result
        while (!resultReceived) {
          const update = await session.readUpdate();

          if (update.type === "stop") {
            if (!resultReceived) {
              stream.rejectResult(new Error("Session ended without calling return_result"));
            }
            break;
          }

          // Forward the event to stream consumers
          stream.pushEvent(update);
        }

        // Wait for the prompt to complete (it should already be done since we got a stop)
        await promptPromise;

        if (resultReceived && result !== undefined) {
          stream.resolveResult(result);
        }
      } finally {
        stream.close();
        session.close();
        this._conn.sessionHandlers.delete(sessionId);
      }
    } finally {
      // Unregister MCP server(s)
      this._conn.mcpHandler.unregister(server);
      if (skillServer) {
        this._conn.mcpHandler.unregister(skillServer);
      }
    }
  }
}

/**
 * Create a new Plan for composing a prompt with tools.
 *
 * This is the factory function for creating Plan instances. It is used
 * internally by `Agent.think()` and `Session.think()`.
 */
export function createPlan<Output>(
  conn: AgentConnection,
  schema?: SchemaProvider<Output>,
  existingSessionId?: string,
): Plan<Output> {
  return new PlanImpl<Output>({
    conn,
    promptParts: [],
    tools: new Map(),
    skills: [],
    schemaProvider: schema,
    cwd: undefined,
    existingSessionId,
  });
}

/** @deprecated Use {@link Plan} instead. */
export type ThinkBuilder<Output> = Plan<Output>;
