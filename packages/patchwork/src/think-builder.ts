import {
  SacpConnection,
  McpOverAcpHandler,
  McpServerBuilder,
  mcpServer,
  SessionBuilder,
  type JsonSchema,
  type SchemaProvider,
  type ToolHandler,
} from "@dherman/sacp";

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
  private readonly _connection: SacpConnection;
  private readonly _mcpHandler: McpOverAcpHandler;
  private _promptParts: string[] = [];
  private _tools: Map<string, ToolDefinition> = new Map();
  private _schemaProvider: SchemaProvider<Output> | undefined;
  private _cwd: string | undefined;
  private _systemPrompt: string | undefined;

  constructor(
    connection: SacpConnection,
    mcpHandler: McpOverAcpHandler,
    schema?: SchemaProvider<Output>
  ) {
    this._connection = connection;
    this._mcpHandler = mcpHandler;
    this._schemaProvider = schema;
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
   * Interpolate a value using toString()
   */
  display(value: unknown): this {
    const text = value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
    this._promptParts.push(text);
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
   * import { schemaOf } from "@dherman/patchwork";
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
   * patchwork.think(outputSchema)
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
   * Set the expected output schema.
   *
   * This generates a return_result tool that the LLM must call
   * to provide the final output.
   *
   * @deprecated Use `patchwork.think(schemaOf<T>(schema))` instead to provide a typed schema at construction time.
   */
  outputSchema(schema: JsonSchema): this {
    console.warn(
      "ThinkBuilder.outputSchema() is deprecated. Use patchwork.think(schemaOf<T>(schema)) instead."
    );
    this._schemaProvider = { toJsonSchema: () => schema };
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
   * Set a system prompt for the session
   */
  systemPrompt(prompt: string): this {
    this._systemPrompt = prompt;
    return this;
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
    return new Promise<Output>((resolve, reject) => {
      this._executeRun(resolve, reject).catch(reject);
    });
  }

  private async _executeRun(
    resolve: (value: Output) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    // Build the prompt
    let prompt = this._promptParts.join("");

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
    const serverBuilder = mcpServer("patchwork");

    // Track if we've received a result
    let resultReceived = false;
    let result: Output | undefined;

    // Get the output schema for the return_result tool
    const outputSchema = this._schemaProvider?.toJsonSchema() ?? { type: "object" };

    // Add return instruction - the schema is already in the tool definition
    prompt += "\n\nWhen you have your answer, call the `return_result` MCP tool with the result.";

    // Add the return_result tool
    serverBuilder.tool(
      "return_result",
      "Return the final result",
      outputSchema,
      { type: "object", properties: { success: { type: "boolean" } } },
      async (input: unknown) => {
        result = input as Output;
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

    // Create and run the session
    const sessionBuilder = new SessionBuilder(this._connection, this._mcpHandler);
    sessionBuilder.withMcpServer(server);

    if (this._cwd) {
      sessionBuilder.cwd(this._cwd);
    }

    if (this._systemPrompt) {
      sessionBuilder.systemPrompt(this._systemPrompt);
    }

    try {
      await sessionBuilder.run(async (session) => {
        // Send the prompt
        await session.sendPrompt(prompt);

        // Read updates until we get a result or the session ends
        while (!resultReceived) {
          const update = await session.readUpdate();

          if (update.type === "stop") {
            if (!resultReceived) {
              reject(new Error("Session ended without calling return_result"));
            }
            break;
          }

          // Tool calls are handled by the MCP server
        }

        if (resultReceived && result !== undefined) {
          resolve(result);
        }
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
