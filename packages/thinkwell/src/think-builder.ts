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
 * Fluent builder for composing prompts with tools.
 *
 * ThinkBuilder provides a chainable API for:
 * - Adding literal text to the prompt
 * - Interpolating values
 * - Registering tools the LLM can call
 * - Executing the prompt and returning a typed result
 */
export class ThinkBuilder<Output> {
  private readonly _conn: AgentConnection;
  private _promptParts: string[] = [];
  private _tools: Map<string, ToolDefinition> = new Map();
  private _skills: DeferredSkill[] = [];
  private _schemaProvider: SchemaProvider<Output> | undefined;
  private _cwd: string | undefined;
  private _existingSessionId: string | undefined;

  constructor(
    conn: AgentConnection,
    schema?: SchemaProvider<Output>,
    existingSessionId?: string
  ) {
    this._conn = conn;
    this._schemaProvider = schema;
    this._existingSessionId = existingSessionId;
  }

  /**
   * Add literal text to the prompt
   */
  text(content: string): this {
    this._promptParts.push(content);
    return this;
  }

  /**
   * Add a line of text with newline
   */
  textln(content: string): this {
    this._promptParts.push(content + "\n");
    return this;
  }

  /**
   * Quote some content delimited by XML-style tags.
   */
  quote(content: string, tag: string = "quote"): this {
    if (!content.includes("\n")) {
      this._promptParts.push(`<${tag}>${content}</${tag}>\n`);
    } else {
      this._promptParts.push(
        `<${tag}>\n${content}\n</${tag}>\n`
      );
    }
    return this;
  }

  /**
   * Quote some content as a Markdown-style code block.
   */
  code(content: string, language: string = ""): this {
    this._promptParts.push(`\`\`\`${language}\n${content}\n\`\`\`\n`);
    return this;
  }

  /**
   * Register a tool and reference it in the prompt.
   *
   * The tool will be mentioned in the prompt text to help the LLM
   * understand that it's available.
   *
   * @param name - The tool name
   * @param description - A description of what the tool does
   * @param inputSchema - A SchemaProvider describing the expected input structure
   * @param outputSchema - A SchemaProvider describing the output structure
   * @param handler - The function to execute when the tool is called
   *
   * @example
   * ```typescript
   * import { schemaOf } from "thinkwell";
   *
   * interface SearchInput {
   *   query: string;
   *   limit?: number;
   * }
   *
   * interface SearchResult {
   *   matches: string[];
   *   total: number;
   * }
   *
   * agent.think(outputSchema)
   *   .tool(
   *     "search",
   *     "Search for documents",
   *     schemaOf<SearchInput>({
   *       type: "object",
   *       properties: {
   *         query: { type: "string" },
   *         limit: { type: "number" }
   *       },
   *       required: ["query"]
   *     }),
   *     schemaOf<SearchResult>({
   *       type: "object",
   *       properties: {
   *         matches: { type: "array", items: { type: "string" } },
   *         total: { type: "number" }
   *       },
   *       required: ["matches", "total"]
   *     }),
   *     async (input: SearchInput) => { ... }
   *   )
   *   .run();
   * ```
   */
  tool<I, O>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    outputSchema: SchemaProvider<O>,
    handler: (input: I) => Promise<O>
  ): this;

  /**
   * Register a tool with only an input schema.
   */
  tool<I>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    handler: (input: I) => Promise<unknown>
  ): this;

  /**
   * Register a tool without schemas.
   */
  tool(
    name: string,
    description: string,
    handler: (input: unknown) => Promise<unknown>
  ): this;

  tool<I, O>(
    name: string,
    description: string,
    inputSchemaOrHandler: SchemaProvider<I> | ((input: I) => Promise<O>),
    outputSchemaOrHandler?: SchemaProvider<O> | ((input: I) => Promise<O>),
    handler?: (input: I) => Promise<O>
  ): this {
    let inputSchema: SchemaProvider<unknown>;
    let outputSchema: SchemaProvider<unknown>;
    let actualHandler: (input: unknown) => Promise<unknown>;

    if (typeof inputSchemaOrHandler === "function") {
      // Overload 3: tool(name, description, handler)
      inputSchema = { toJsonSchema: () => ({ type: "object" }) };
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = inputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else if (typeof outputSchemaOrHandler === "function") {
      // Overload 2: tool(name, description, inputSchema, handler)
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = outputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else {
      // Overload 1: tool(name, description, inputSchema, outputSchema, handler)
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = outputSchemaOrHandler as SchemaProvider<unknown>;
      actualHandler = handler as (input: unknown) => Promise<unknown>;
    }

    this._tools.set(name, {
      name,
      description,
      handler: actualHandler,
      inputSchema,
      outputSchema,
      includeInPrompt: true,
    });
    return this;
  }

  /**
   * Register a tool without adding a prompt reference.
   *
   * Use this for tools that should be available but don't need
   * to be explicitly mentioned in the prompt.
   *
   * @param name - The tool name
   * @param description - A description of what the tool does
   * @param inputSchema - A SchemaProvider describing the expected input structure
   * @param outputSchema - A SchemaProvider describing the output structure
   * @param handler - The function to execute when the tool is called
   */
  defineTool<I, O>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    outputSchema: SchemaProvider<O>,
    handler: (input: I) => Promise<O>
  ): this;

  /**
   * Register a tool with only an input schema (no prompt reference).
   */
  defineTool<I>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    handler: (input: I) => Promise<unknown>
  ): this;

  /**
   * Register a tool without schemas (no prompt reference).
   */
  defineTool(
    name: string,
    description: string,
    handler: (input: unknown) => Promise<unknown>
  ): this;

  defineTool<I, O>(
    name: string,
    description: string,
    inputSchemaOrHandler: SchemaProvider<I> | ((input: I) => Promise<O>),
    outputSchemaOrHandler?: SchemaProvider<O> | ((input: I) => Promise<O>),
    handler?: (input: I) => Promise<O>
  ): this {
    let inputSchema: SchemaProvider<unknown>;
    let outputSchema: SchemaProvider<unknown>;
    let actualHandler: (input: unknown) => Promise<unknown>;

    if (typeof inputSchemaOrHandler === "function") {
      // Overload 3: defineTool(name, description, handler)
      inputSchema = { toJsonSchema: () => ({ type: "object" }) };
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = inputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else if (typeof outputSchemaOrHandler === "function") {
      // Overload 2: defineTool(name, description, inputSchema, handler)
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = { toJsonSchema: () => ({ type: "object" }) };
      actualHandler = outputSchemaOrHandler as (input: unknown) => Promise<unknown>;
    } else {
      // Overload 1: defineTool(name, description, inputSchema, outputSchema, handler)
      inputSchema = inputSchemaOrHandler as SchemaProvider<unknown>;
      outputSchema = outputSchemaOrHandler as SchemaProvider<unknown>;
      actualHandler = handler as (input: unknown) => Promise<unknown>;
    }

    this._tools.set(name, {
      name,
      description,
      handler: actualHandler,
      inputSchema,
      outputSchema,
      includeInPrompt: false,
    });
    return this;
  }

  /**
   * Attach a skill to this prompt.
   *
   * When called with a string, it is treated as a path to a SKILL.md file
   * that will be parsed at run() time (deferred stored skill).
   *
   * When called with an object, it is treated as a virtual skill definition
   * and validated eagerly.
   *
   * @param pathOrDef - Path to a SKILL.md file, or a virtual skill definition
   */
  skill(pathOrDef: string | VirtualSkillDefinition): this {
    if (typeof pathOrDef === "string") {
      this._skills.push({ type: "stored", path: pathOrDef });
    } else {
      // Validate eagerly for virtual skills
      validateSkillName(pathOrDef.name);
      validateSkillDescription(pathOrDef.description);
      this._skills.push({
        type: "virtual",
        skill: {
          name: pathOrDef.name,
          description: pathOrDef.description,
          body: pathOrDef.body,
          tools: pathOrDef.tools,
        },
      });
    }
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
   * Resolve all deferred skills into ResolvedSkill instances.
   *
   * - Virtual skills are passed through as-is.
   * - Stored skills are loaded from disk: SKILL.md is parsed and basePath is
   *   set to the directory containing the file.
   *
   * Skills are returned in attachment order.
   */
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

  /**
   * Build the `<available_skills>` XML block and infrastructure instructions.
   *
   * Returns the string to prepend before the user's prompt parts, or an
   * empty string when no skills are attached.
   */
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

  /**
   * Execute the prompt and return the result.
   *
   * This method:
   * 1. Builds the final prompt from all text parts
   * 2. Creates an MCP server with all registered tools
   * 3. Adds a return_result tool for the output
   * 4. Sends the prompt to the agent
   * 5. Handles tool calls until the agent returns a result
   * 6. Returns the typed result
   */
  async run(): Promise<Output> {
    return this.stream().result;
  }

  /**
   * Start executing the prompt, returning a stream handle that provides
   * both an async iterable of intermediate `ThoughtEvent`s and a `.result`
   * promise for the final typed output.
   *
   * Execution begins eagerly — the returned stream is already "hot".
   */
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
