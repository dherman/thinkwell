# RFD: Agent-Centric API for Thinkwell

**Implementation:** [PR #3](https://github.com/dherman/thinkwell/pull/3)

## Summary

Redesign Thinkwell's public API around the `Agent` type, with a static `Agent.connect()` method that hides conductor implementation details. Support both simple single-shot usage and advanced multi-session patterns.

## Motivation

The current API has several friction points:

1. **Naming**: Users think of themselves as connecting to an *agent*
2. **Conductor exposure**: Users must understand and construct conductor commands like `["sacp-conductor", "agent", "npx ..."]`
3. **Session model hidden**: The powerful multi-session capability of ACP is not exposed

The ACP protocol supports multiple concurrent sessions over a single agent connection. This enables powerful patterns like:
- Multi-turn conversations with preserved context
- Parallel reasoning tasks on the same agent
- Resource-efficient connection reuse

We want an API that makes the simple case trivial while exposing advanced capabilities when needed.

## Design

### Core Types

```typescript
// The main type users interact with
class Agent {
  // Entry point - hides conductor details
  static connect(command: string, options?: ConnectOptions): Promise<Agent>;

  // Simple case: ephemeral session per think() call
  think<Output>(schema?: SchemaProvider<Output>): ThinkBuilder<Output>;

  // Advanced: explicit session management
  createSession(options?: SessionOptions): Promise<Session>;

  // Cleanup
  close(): void;
}

// For multi-turn or advanced use cases
class Session {
  // Same API as Agent.think(), but uses this session's context
  think<Output>(schema?: SchemaProvider<Output>): ThinkBuilder<Output>;

  // Lower-level access for custom interaction patterns
  sendPrompt(content: string): Promise<void>;
  readUpdate(): Promise<SessionUpdate>;

  // Cleanup
  close(): void;
}
```

### Usage Examples

**Simple case (90% of users):**

```typescript
import { Agent } from "thinkwell";

const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");

const summary = await agent
  .think(SummarySchema)
  .text("Summarize this document:")
  .quote(document)
  .run();

console.log(summary.title);
agent.close();
```

**Multi-turn conversation:**

```typescript
const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");
const session = await agent.createSession({ cwd: "/my/project" });

// First turn
const analysis = await session
  .think(AnalysisSchema)
  .text("Analyze this codebase for security issues")
  .run();

// Second turn - same session, agent remembers context
const fixes = await session
  .think(FixesSchema)
  .text("Now suggest fixes for the top 3 issues you found")
  .run();

session.close();
agent.close();
```

**Batch processing with connection reuse:**

```typescript
const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");

for (const file of files) {
  const content = await fs.readFile(file, "utf-8");

  // Each think() creates a fresh ephemeral session
  // but reuses the same agent connection
  const summary = await agent
    .think(FileSummarySchema)
    .text("Summarize this file:")
    .code(content, "typescript")
    .run();

  console.log(`${file}: ${summary.oneLiner}`);
}

agent.close();
```

### Connection Options

```typescript
interface ConnectOptions {
  // Path to conductor binary (auto-detected if not specified)
  conductorPath?: string;

  // Environment variables for the agent process
  env?: Record<string, string>;

  // Connection timeout in milliseconds
  timeout?: number;
}
```

### Session Options

```typescript
interface SessionOptions {
  // Working directory for the session
  cwd?: string;

  // System prompt for the session
  systemPrompt?: string;

  // MCP servers to attach
  mcpServers?: McpServer[];
}
```

## Implementation Notes

### Conductor Discovery

The `Agent.connect()` method should find `sacp-conductor` automatically:

1. Check `options.conductorPath` if provided
2. Check `SACP_CONDUCTOR_PATH` environment variable
3. Look for `sacp-conductor` in PATH
4. Fall back to bundled binary (future consideration)

### Backward Compatibility

The existing deprecated APIs should be maintained for one major version:

```typescript
/** @deprecated Use Agent.connect() instead */
export async function connect(conductorCommand: string[]): Promise<Patchwork> {
  // ...existing implementation...
}

/** @deprecated Use Agent instead */
export class Patchwork {
  // ...existing implementation...
}
```

### Session Lifecycle

When `agent.think()` is called (without an explicit session):

1. Create a new ephemeral session
2. Build and attach the MCP server with registered tools
3. Send the prompt
4. Process updates until `return_result` is called
5. Close the session automatically
6. Return the typed result

When `session.think()` is called (with an explicit session):

1. Reuse the existing session (preserving conversation context)
2. Build and attach additional MCP tools for this think block
3. Send the prompt
4. Process updates until `return_result` is called
5. Keep the session open for subsequent calls
6. Return the typed result

## Alternatives Considered

### Keep a different class name

We could use a different class name for the connection. However, "Agent" directly describes what users are connecting to and working with.

### Require explicit sessions always

We could require users to always create sessions explicitly:

```typescript
const agent = await Agent.connect("...");
const session = await agent.createSession();
const result = await session.think(...).run();
```

This adds boilerplate for the common case where users don't need session persistence. The proposed design makes the simple case simple.

### Hide sessions entirely

We could hide sessions completely and only expose `agent.think()`. This would sacrifice the multi-turn capability, which is one of ACP's key features.

## Open Questions

1. **Should `Agent` be a class or interface?** A class allows static methods and clear instantiation semantics. An interface would allow multiple implementations but complicates the static `connect()` pattern.

2. **Session attachment of MCP servers**: When using explicit sessions with multiple `think()` calls, how should MCP servers be managed? Options:
   - Attach at session creation time only
   - Allow adding servers per-think (current behavior)
   - Accumulate servers across think calls

3. **Naming: `createSession` vs `session`**: The Rust API uses `session()` as a builder method. We could do either:
   - `agent.createSession()` - explicit about what it does
   - `agent.session()` - shorter, matches Rust

## Migration Path

1. Add `Agent` class with new API
2. Deprecate `Patchwork` and `connect()` with JSDoc warnings
3. Update all examples and documentation
4. Remove deprecated APIs in next major version
