# @thinkwell/conductor: TypeScript Conductor Design

This document describes the design for porting the Rust `sacp-conductor` to TypeScript as a new `@thinkwell/conductor` package.

## Background

### What is the Conductor?

The **conductor** is an orchestrator for ACP proxy chains. It sits between a client (editor/application) and an agent, managing a chain of proxy components that can intercept, transform, and augment ACP messages bidirectionally.

```
Client ←→ Conductor ←→ [Proxy 0] ←→ [Proxy 1] ←→ ... ←→ Agent
```

The conductor's responsibilities:

1. **Process Management**: Spawns component subprocesses, manages their lifecycle
2. **Message Routing**: Routes all messages through a central event loop, preserving order
3. **Capability Management**: Negotiates proxy capabilities during initialization
4. **MCP Bridge Adaptation**: Bridges MCP-over-ACP for agents that don't support native ACP transport

### Current State

Thinkwell currently depends on a pre-built Rust `sacp-conductor` binary for MCP bridging. This works but creates distribution challenges:

- Requires platform-specific binaries
- Complicates npm packaging
- Makes debugging harder
- Limits extensibility

A pure TypeScript conductor would eliminate these friction points.

### Reference Implementation

The Rust implementation is in `doc/.local/symposium-acp/src/sacp-conductor/`. Key files:

| File | Purpose |
|------|---------|
| `src/conductor.rs` | Core conductor logic (~1600 lines) |
| `src/conductor/mcp_bridge.rs` | MCP-over-ACP bridging |
| `src/lib.rs` | CLI and public API |
| `src/trace.rs` | Observability/tracing |

## Goals

1. **Eliminate binary dependency**: Pure TypeScript, npm-installable
2. **Preserve semantics**: Same message routing and protocol behavior as Rust
3. **Share code**: Build on `@thinkwell/acp` abstractions where possible
4. **Future-proof**: Don't preclude exposing a Component API for proxy authors later

## Non-Goals (for now)

1. CLI interface (programmatic API sufficient)
2. Proxy authoring API (internal implementation detail for now)
3. Full tracing/visualization (can add later)
4. Worker-based parallelism (single-threaded is fine)

## Design

### Package Structure

```
packages/
  conductor/
    src/
      index.ts           # Public API
      conductor.ts       # Core Conductor class
      message-queue.ts   # Central message routing
      component.ts       # Component abstraction
      connectors/
        index.ts
        stdio.ts         # Subprocess spawning
        channel.ts       # In-memory (testing)
      mcp-bridge/
        index.ts
        http-listener.ts # HTTP bridge for MCP
      types.ts           # Internal types
```

### Key Abstractions

#### 1. Roles (Simplified)

The Rust implementation uses a sophisticated compile-time role system. For TypeScript, we use a simpler runtime model:

```typescript
// Role identifiers
type RoleId = 'client' | 'agent' | 'proxy' | 'conductor';

// Role relationships (encode at runtime what Rust does at compile time)
const ROLE_COUNTERPART: Record<RoleId, RoleId> = {
  client: 'agent',
  agent: 'client',
  proxy: 'conductor',
  conductor: 'proxy',
};
```

This loses compile-time safety but keeps the code simple. We validate at boundaries.

#### 2. Dispatch (Message Envelope)

Messages flow through the conductor in a unified envelope:

```typescript
type Dispatch =
  | { type: 'request'; id: JsonRpcId; method: string; params: unknown; responder: Responder }
  | { type: 'notification'; method: string; params: unknown }
  | { type: 'response'; id: JsonRpcId; result?: unknown; error?: JsonRpcError };

interface Responder {
  respond(result: unknown): void;
  respondWithError(error: JsonRpcError): void;
}
```

The `Responder` abstraction decouples response routing from the message itself, enabling the conductor to intercept and redirect responses.

#### 3. Component Connector

Components are things the conductor can connect to:

```typescript
interface ComponentConnector {
  /** Open a bidirectional JSON-RPC connection */
  connect(): Promise<ComponentConnection>;
}

interface ComponentConnection {
  /** Send a message to this component */
  send(message: JsonRpcMessage): void;

  /** Receive messages from this component */
  messages: AsyncIterable<JsonRpcMessage>;

  /** Close the connection */
  close(): Promise<void>;
}
```

Built-in connectors:

- **StdioConnector**: Spawns a subprocess, communicates via stdin/stdout
- **ChannelConnector**: In-memory for testing or embedded components

#### 4. Component Instantiator

Components are instantiated lazily when the first `initialize` request arrives:

```typescript
interface ComponentInstantiator {
  instantiate(
    initRequest: InitializeRequest
  ): Promise<InstantiatedComponents>;
}

// For agent mode: proxies + agent
interface InstantiatedComponents {
  proxies: ComponentConnector[];
  agent: ComponentConnector;
}

// Simple case: static list of commands
function fromCommands(commands: string[]): ComponentInstantiator {
  return {
    async instantiate() {
      const connectors = commands.map(cmd => new StdioConnector(cmd));
      return {
        proxies: connectors.slice(0, -1),
        agent: connectors[connectors.length - 1],
      };
    }
  };
}

// Dynamic case: examine init request to decide what to spawn
function dynamic(
  factory: (req: InitializeRequest) => Promise<InstantiatedComponents>
): ComponentInstantiator {
  return { instantiate: factory };
}
```

#### 5. Conductor Message Queue

All routing flows through a central queue, preserving message ordering:

```typescript
type ConductorMessage =
  | { type: 'left-to-right'; targetIndex: number; dispatch: Dispatch }
  | { type: 'right-to-left'; sourceIndex: SourceIndex; dispatch: Dispatch }
  | { type: 'mcp-connection-received'; acpUrl: string; ... }
  | { type: 'mcp-connection-established'; connectionId: string; ... }
  | { type: 'mcp-client-to-server'; connectionId: string; message: Dispatch }
  | { type: 'mcp-connection-disconnected'; connectionId: string };

type SourceIndex = { type: 'proxy'; index: number } | { type: 'successor' };

class MessageQueue {
  private queue: ConductorMessage[] = [];
  private resolvers: Array<(msg: ConductorMessage) => void> = [];

  push(message: ConductorMessage): void {
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!(message);
    } else {
      this.queue.push(message);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConductorMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        yield await new Promise(resolve => this.resolvers.push(resolve));
      }
    }
  }
}
```

#### 6. The Conductor Class

```typescript
interface ConductorConfig {
  name?: string;
  instantiator: ComponentInstantiator;
  mcpBridgeMode?: 'http' | 'disabled';
}

class Conductor {
  private readonly config: ConductorConfig;
  private readonly messageQueue = new MessageQueue();
  private proxies: ComponentConnection[] = [];
  private agent: ComponentConnection | null = null;
  private mcpBridge: McpBridge | null = null;
  private initialized = false;

  constructor(config: ConductorConfig) {
    this.config = config;
  }

  /** Connect to a client and run the message loop */
  async connect(client: ComponentConnector): Promise<void> {
    const clientConn = await client.connect();

    // Pump client messages into the queue
    this.pumpMessages(clientConn, 'client');

    // Main event loop
    for await (const msg of this.messageQueue) {
      await this.handleMessage(clientConn, msg);
    }
  }

  private async handleMessage(
    client: ComponentConnection,
    msg: ConductorMessage
  ): Promise<void> {
    switch (msg.type) {
      case 'left-to-right':
        await this.forwardLeftToRight(client, msg.targetIndex, msg.dispatch);
        break;
      case 'right-to-left':
        await this.forwardRightToLeft(client, msg.sourceIndex, msg.dispatch);
        break;
      // ... MCP bridge messages
    }
  }
}
```

### Message Routing Details

#### Left-to-Right Flow (Client → Agent)

```
Client → Conductor → Proxy[0] → Proxy[1] → ... → Agent
```

1. Client sends `initialize` request
2. Conductor intercepts, instantiates components
3. Conductor sends `_proxy/initialize` to each proxy (not last)
4. Conductor sends `initialize` to agent (last component)
5. Responses flow back; conductor aggregates capabilities

For subsequent messages:
- Conductor forwards to `Proxy[0]`
- Each proxy uses `_proxy/successor/*` to forward to next
- Agent receives unwrapped messages

#### Right-to-Left Flow (Agent → Client)

```
Agent → ... → Proxy[1] → Proxy[0] → Conductor → Client
```

Messages from components going "backward" (notifications, agent-initiated requests):
- Conductor wraps in `_proxy/successor/*` for proxies
- Sends unwrapped to client

#### Successor Message Wrapping

When proxy N wants to talk to proxy N+1:
1. Proxy N sends `_proxy/successor/request` or `_proxy/successor/notification`
2. Conductor unwraps, forwards to proxy N+1 (or agent)
3. Response comes back, conductor wraps and returns to proxy N

### MCP Bridge

When the agent calls tools via MCP-over-ACP:

```
Agent → Conductor → [_mcp/message] → Client's McpOverAcpHandler
```

The conductor's MCP bridge:
1. Listens on ephemeral HTTP port per `acp:$UUID` URL
2. When session starts, transforms `acp:` URLs to `http://localhost:$PORT`
3. Agent makes HTTP requests to localhost
4. Bridge converts to `_mcp/message` and routes through conductor
5. Client's `McpOverAcpHandler` invokes tool and returns result

```typescript
class McpBridge {
  private listeners = new Map<string, McpBridgeListener>();
  private connections = new Map<string, McpBridgeConnection>();

  async transformMcpServer(
    server: McpServer,
    messageQueue: MessageQueue
  ): Promise<McpServer> {
    if (!server.url.startsWith('acp:')) {
      return server;
    }

    // Spawn HTTP listener
    const listener = await this.spawnListener(server.url, messageQueue);
    this.listeners.set(server.url, listener);

    // Return transformed server config
    return {
      ...server,
      url: `http://localhost:${listener.port}`,
    };
  }
}
```

### Package Dependencies

Shared types live in a new `@thinkwell/protocol` package:

```
@thinkwell/protocol    # Shared types (JSON-RPC, MCP-over-ACP, Dispatch)
    ↑           ↑
    |           |
@thinkwell/acp  @thinkwell/conductor
```

```typescript
// @thinkwell/protocol exports shared types
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  McpConnectRequest,
  McpConnectResponse,
  McpMessageRequest,
  McpMessageResponse,
  McpDisconnectNotification,
  Dispatch,
  Responder,
} from '@thinkwell/protocol';
```

### Integration with @thinkwell/acp

The `SacpConnection` class in `@thinkwell/acp` currently spawns a subprocess. With the TypeScript conductor, we can run it in-process:

```typescript
// Current: subprocess
const connection = await connect(['sacp-conductor', 'agent', 'claude-agent']);

// Future: in-process conductor
const conductor = new Conductor({
  instantiator: fromCommands(['claude-agent']),
});
const connection = await connectToConductor(conductor);
```

This doesn't change the `SacpConnection` API—just how the conductor runs.

### Error Handling

The conductor follows the Rust implementation's approach:

- **Component crash**: Log error, shut down entire conductor
- **Invalid messages**: Log to stderr, continue processing
- **Initialization failure**: Return error response, shut down

```typescript
class Conductor {
  private handleComponentError(index: number, error: Error): void {
    console.error(`Component ${index} crashed:`, error);
    this.shutdown();
  }

  private shutdown(): void {
    for (const proxy of this.proxies) {
      proxy.close().catch(() => {});
    }
    this.agent?.close().catch(() => {});
    // The message loop will exit when connections close
  }
}
```

## Implementation Plan

See [doc/plan.md](../plan.md) for the detailed implementation checklist.

## Design Decisions

### 1. Process Management Semantics

**Decision**: Match Rust's behavior (any crash → full shutdown). More sophisticated restart/retry logic can come later.

### 2. In-Process Conductor

**Decision**: The conductor runs in-process by default, avoiding subprocess overhead. This is straightforward because:
- The conductor's message loop shares the Node.js event loop (fine for I/O-bound work)
- Child agent/proxy subprocesses still use stdio normally
- Errors surface as exceptions rather than subprocess exit codes

### 3. Proxy Mode (Conductor as Proxy)

**Decision**: Defer. This is an advanced feature for nested conductor topologies. Start with agent mode only.

### 4. Shared Types

**Decision**: Extract shared types to `@thinkwell/protocol` to avoid circular dependencies between `@thinkwell/acp` and `@thinkwell/conductor`.

## Open Questions

### 1. Backpressure

**Question**: The message queue can grow unbounded. Should we add backpressure?

**Tentative answer**: Defer. The single-threaded nature of Node.js naturally rate-limits. We can add explicit backpressure if memory becomes an issue.

## Alternatives Considered

### 1. Port sacp to WebAssembly

**Pros**: Exact same semantics, proven code
**Cons**: Larger binary size, debugging difficulty, async/wasm-bindgen complexity

**Decision**: TypeScript port is more maintainable and debuggable.

### 2. Use Node worker_threads

**Pros**: True parallelism, isolation
**Cons**: Complexity, IPC overhead, not needed for I/O-bound work

**Decision**: Single-threaded is sufficient. Message routing is not CPU-bound.

### 3. Minimal Conductor (MCP bridge only)

**Pros**: Smaller scope, faster to implement
**Cons**: Can't add proxies later without significant rework

**Decision**: Build the full routing infrastructure. The marginal cost is low and enables future features.

## Security Considerations

- **Subprocess spawning**: Only spawn commands explicitly provided
- **Port binding**: Only bind to localhost for MCP bridge
- **Message validation**: Validate JSON-RPC structure, reject malformed messages

## Testing Strategy

1. **Unit tests**: Message queue, dispatch handling, connector logic
2. **Integration tests**: Full conductor with mock components
3. **End-to-end tests**: Real agent subprocess, MCP tool invocation
4. **Comparison tests**: Validate behavior matches Rust conductor
