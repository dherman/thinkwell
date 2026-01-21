# Thinkwell ACP TypeScript MVP Design Document

This document describes the design for a minimal TypeScript implementation of ACP (Agent Client Protocol) extensions sufficient for the Thinkwell library.

## Background

### What is Thinkwell?

Thinkwell is a library for blending deterministic code with LLM-powered reasoning. It provides a builder-style API for constructing prompts and registering typed tool functions that the LLM can invoke:

```typescript
const summary: FileSummary = await agent.think(FileSummarySchema)
  .text("Summarize this file:")
  .quote(contents)
  .tool("record", "Record an item", async (input: RecordInput) => {
    results.push(input.item);
    return { success: true };
  })
  .run();
```

The architecture depends on:
- **@thinkwell/acp**: Extensions to ACP for MCP-over-ACP and session management
- **sacp-conductor**: A binary that orchestrates proxy chains and bridges MCP traffic

### What is @thinkwell/acp?

The @thinkwell/acp package extends the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) with:

1. **MCP-over-ACP**: Tunneling MCP tool calls through the ACP channel
   - `_mcp/connect` - Establish an MCP connection
   - `_mcp/message` - Envelope for MCP requests/responses/notifications
   - `_mcp/disconnect` - Tear down an MCP connection

2. **Proxy protocol**: Extensions for building proxy chains (not needed for MVP)
   - `_proxy/successor` - Message forwarding
   - `_proxy/initialize` - Proxy initialization

3. **Session management**: Builders for creating sessions with MCP servers attached

4. **Conductor**: A binary that manages proxy chains and bridges `acp:` URLs to HTTP MCP

## Design Goals

1. **Minimal scope**: Only implement what thinkwell needs
2. **Leverage existing SDKs**: Use the official ACP and MCP TypeScript SDKs where possible
3. **No throwaway work**: Everything we build should be reusable in a fuller SACP port
4. **Runtime portable**: Avoid Node-specific APIs where practical (e.g., prefer TCP over subprocess spawning)

## Architecture

### High-Level Component Diagram

```
┌────────────────────────────────────────────────────────────┐
│                   Your Application                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                    thinkwell                          │  │
│  │  - ThinkBuilder API                                  │  │
│  │  - Tool registration                                 │  │
│  │  - Prompt composition                                │  │
│  └──────────────────────────────────────────────────────┘  │
│                            │                               │
│                            ▼                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  @thinkwell/acp                       │  │
│  │  - McpOverAcpHandler (handles _mcp/* requests)       │  │
│  │  - McpServerBuilder (tool registration)              │  │
│  │  - SessionBuilder (session + MCP server management)  │  │
│  └──────────────────────────────────────────────────────┘  │
│                            │                               │
│                            ▼                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           @agentclientprotocol/sdk                   │  │
│  │  - ClientSideConnection                              │  │
│  │  - ACP protocol types                                │  │
│  └──────────────────────────────────────────────────────┘  │
│                            │                               │
└────────────────────────────┼───────────────────────────────┘
                             │ stdio
                             ▼
┌────────────────────────────────────────────────────────────┐
│                    sacp-conductor                          │
│  - Bridges acp: URLs to HTTP MCP for the agent             │
│  - Routes messages between client and agent                │
│  - Manages MCP connection lifecycle                        │
└────────────────────────────────────────────────────────────┘
                             │ ACP
                             ▼
                       ┌───────────┐
                       │   Agent   │
                       └───────────┘
```

### Key Design Decision: Use Conductor for MCP Bridging

We considered two approaches for exposing tools to the agent:

**Option A: MCP-over-ACP (chosen)**
- Register tools with `acp:uuid` URLs in session requests
- Conductor bridges these to HTTP for the agent
- Handle `_mcp/message` requests in our TypeScript code
- All traffic flows through the single ACP channel

**Option B: Direct HTTP MCP Server (rejected)**
- Run a standalone MCP HTTP server on localhost
- Pass `http://localhost:port` directly to the agent
- Agent connects to our server directly, bypassing conductor

We chose Option A because:

1. **Not throwaway work**: The `_mcp/message` handling code is exactly what a full SACP port requires
2. **Works with remote agents**: Traffic is tunneled through ACP, no localhost exposure needed
3. **Matches protocol design**: This is how SACP is intended to work
4. **Single channel**: Easier to debug than correlating two separate protocol streams
5. **Security**: Tools are managed through ACP, not exposed on the network

## Module Design

### @thinkwell/acp

The core library providing ACP extensions over the official ACP SDK.

#### McpServerBuilder

Fluent builder for defining MCP tools that will be exposed via ACP:

```typescript
interface McpServerBuilder {
  /** Set instructions for the MCP server */
  instructions(text: string): this;

  /** Register a tool with input/output JSON schemas */
  tool<I, O>(
    name: string,
    description: string,
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    handler: (input: I, context: McpContext) => Promise<O>
  ): this;

  /** Build the server configuration */
  build(): McpServer;
}
```

#### McpServer

Handles incoming `_mcp/message` requests and dispatches to registered tools:

```typescript
interface McpServer {
  /** Unique identifier for this server (used in acp: URLs) */
  readonly id: string;

  /** Handle an incoming MCP-over-ACP request */
  handleMessage(message: McpOverAcpMessage): Promise<McpOverAcpResponse>;

  /** Get the acp: URL for this server */
  get acpUrl(): string;

  /** Get MCP server config for session requests */
  toSessionConfig(): McpServerConfig;
}
```

#### SessionBuilder

Creates ACP sessions with MCP servers attached:

```typescript
interface SessionBuilder {
  /** Attach an MCP server to this session */
  withMcpServer(server: McpServer): this;

  /** Set the working directory for the session */
  cwd(path: string): this;

  /** Start the session and run a callback */
  run<T>(callback: (session: ActiveSession) => Promise<T>): Promise<T>;
}
```

#### ActiveSession

Represents an active ACP session:

```typescript
interface ActiveSession {
  /** Send a prompt to the agent */
  sendPrompt(content: string): void;

  /** Read the next update from the agent */
  readUpdate(): Promise<SessionMessage>;

  /** Read all updates until completion, returning concatenated text */
  readToString(): Promise<string>;

  /** The session ID */
  readonly sessionId: string;
}

type SessionMessage =
  | { type: 'message'; content: MessageContent }
  | { type: 'stop'; reason: StopReason };
```

#### McpOverAcpHandler

Integrates with the ACP client to handle MCP-over-ACP messages:

```typescript
interface McpOverAcpHandler {
  /** Register an MCP server to handle requests for its connection */
  register(server: McpServer): void;

  /** Handle incoming _mcp/connect request */
  handleConnect(request: McpConnectRequest): McpConnectResponse;

  /** Handle incoming _mcp/message request */
  handleMessage(request: McpOverAcpMessage): Promise<unknown>;

  /** Handle incoming _mcp/disconnect notification */
  handleDisconnect(notification: McpDisconnectNotification): void;
}
```

### thinkwell

The high-level API built on @thinkwell/acp.

#### Agent

Main entry point for connecting to agents:

```typescript
class Agent {
  /** Connect to an agent */
  static connect(command: string, options?: ConnectOptions): Promise<Agent>;

  /** Create a new think builder */
  think<Output>(schema: SchemaProvider<Output>): ThinkBuilder<Output>;

  /** Create a session for multi-turn conversations */
  createSession(options?: SessionOptions): Promise<Session>;

  /** Close the connection */
  close(): void;
}
```

#### ThinkBuilder

Fluent builder for composing prompts with tools:

```typescript
interface ThinkBuilder<Output> {
  /** Add literal text to the prompt */
  text(content: string): this;

  /** Add a line of text with newline */
  textln(content: string): this;

  /** Interpolate a value using toString() */
  display(value: unknown): this;

  /** Register a tool and reference it in the prompt */
  tool<I, O>(
    name: string,
    description: string,
    handler: (input: I) => Promise<O>
  ): this;

  /** Register a tool without adding a prompt reference */
  defineTool<I, O>(
    name: string,
    description: string,
    handler: (input: I) => Promise<O>
  ): this;

  /** Execute and return the result */
  run(): Promise<Output>;
}
```

The `Output` type parameter is used to:
1. Generate a JSON schema for the expected return type
2. Automatically register a `return_result` tool that the LLM calls to provide the output
3. Type the return value of `run()`

## Protocol Details

### MCP-over-ACP Message Flow

When the agent calls a tool:

1. **Agent** sends HTTP MCP request to conductor's bridge server
2. **Conductor** wraps it in `_mcp/message` and sends to client:
   ```json
   {
     "method": "_mcp/message",
     "params": {
       "connectionId": "uuid",
       "method": "tools/call",
       "params": { "name": "record", "arguments": {...} }
     }
   }
   ```
3. **@thinkwell/acp** receives the request, dispatches to the registered tool handler
4. **@thinkwell/acp** sends response back:
   ```json
   {
     "result": {
       "connectionId": "uuid",
       "content": [{ "type": "text", "text": "{...}" }]
     }
   }
   ```
5. **Conductor** unwraps and sends HTTP response to agent

### Session Creation with MCP Servers

When creating a session with tools:

1. **thinkwell** builds prompt and registers tools with `McpServerBuilder`
2. **@thinkwell/acp** generates `acp:uuid` URL for the MCP server
3. **@thinkwell/acp** sends `session.new` request with:
   ```json
   {
     "method": "session.new",
     "params": {
       "cwd": "/path/to/workspace",
       "mcpServers": [
         { "type": "http", "name": "patchwork", "url": "acp:abc-123" }
       ]
     }
   }
   ```
4. **Conductor** intercepts, spawns HTTP bridge for `acp:abc-123`
5. **Agent** receives session with `http://localhost:port` MCP server
6. When agent calls tools, traffic flows back through conductor as `_mcp/message`

## Dependencies

### Required
- `@agentclientprotocol/sdk` - Official ACP TypeScript SDK
- `sacp-conductor` binary - For MCP bridging

### Development
- TypeScript 5.x
- Runtime: Node.js, Bun, or Deno (TBD based on testing)

## What We're NOT Building (MVP Scope)

The following features are out of scope for the MVP:

1. **Proxy protocol** (`_proxy/successor`, `_proxy/initialize`)
   - Not needed for basic thinkwell usage
   - Conductor handles proxy chains externally

2. **Conductor as a library**
   - We use the conductor binary, not the Rust library
   - No need to port conductor orchestration logic

3. **Component/Link type system**
   - A sophisticated Rust type system for composing components
   - TypeScript can use simpler patterns

4. **Handler chains / Responder pattern**
   - The Rust implementation's approach to serializing tool calls
   - JavaScript's async/await handles this naturally

5. **Multiple simultaneous sessions**
   - MVP focuses on single-session usage
   - Can be added later without architectural changes

## Future Evolution

After the MVP, a fuller @thinkwell/acp implementation could add:

1. **Native MCP server hosting** - Eliminate conductor dependency for local development
2. **Proxy building** - Implement `_proxy/*` protocol for custom proxies
3. **Multi-session support** - Handle multiple concurrent sessions
4. **Streaming responses** - Expose incremental updates during tool execution
5. **Component composition** - Port the component/link abstraction for complex topologies

The MVP design intentionally aligns with these future directions by:
- Handling `_mcp/*` protocol directly (not bypassing it)
- Using builder patterns that can be extended
- Keeping session management separate from MCP handling
