# Thinkwell API Reference

Complete API surface for the `thinkwell` package.

## Exports

```typescript
// Core
export function open(name: AgentName, options?: AgentOptions): Promise<Agent>;
export function open(options: CustomAgentOptions): Promise<Agent>;

// Types
export type AgentName = 'claude' | 'codex' | 'gemini' | 'kiro' | 'opencode' | 'auggie';

export interface AgentOptions {
  env?: Record<string, string>;   // Environment variables for the agent process
  timeout?: number;                // Connection timeout in milliseconds
}

export interface CustomAgentOptions extends AgentOptions {
  cmd: string;                     // Shell command to spawn the agent process
}

// Schema helper
export function schemaOf<T>(schema: JsonSchema): SchemaProvider<T>;

// Classes
export class Plan<Output> { ... }
export class Session { ... }
export class ThoughtStream<Output> { ... }

// Re-exports from @thinkwell/acp
export type { JsonSchema, SchemaProvider, JsonValue, JsonObject };
export type { Skill, VirtualSkill, StoredSkill, SkillTool };
```

## Agent

Created via `open()`. Provides the entry point for sending prompts.

```typescript
interface Agent {
  // Ephemeral single-shot prompt (creates a new session each time)
  think<Output>(schema: SchemaProvider<Output>): Plan<Output>;

  // Multi-turn conversation with persistent context
  createSession(options?: SessionOptions): Promise<Session>;

  // Shut down the agent connection
  close(): Promise<void>;
}

interface SessionOptions {
  cwd?: string;           // Working directory for the session
  systemPrompt?: string;  // System prompt for the session
}
```

## Session

Created via `agent.createSession()`. Maintains conversation context across multiple `think()` calls.

```typescript
class Session {
  readonly sessionId: string;

  // Same as agent.think(), but within this session's context
  think<Output>(schema: SchemaProvider<Output>): Plan<Output>;

  // Stop using this session (agent connection stays open)
  close(): void;
}
```

## Plan

Fluent builder for composing prompts. Obtained from `agent.think()` or `session.think()`.

> **Note:** `Plan` was previously named `ThinkBuilder`. The old name still works as a deprecated alias.

### Content Methods

```typescript
class Plan<Output> {
  // Add literal text to the prompt
  text(content: string): this;

  // Add text with trailing newline
  textln(content: string): this;

  // Add content in XML-style tags: <tag>content</tag>
  // Default tag is "quote"
  quote(content: string, tag?: string): this;

  // Add content as a fenced Markdown code block
  code(content: string, language?: string): this;
}
```

### Tool Methods

```typescript
class Plan<Output> {
  // Overload 1: No input/output schema
  tool(
    name: string,
    description: string,
    handler: (input: unknown) => Promise<unknown>
  ): this;

  // Overload 2: With input schema
  tool<I>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    handler: (input: I) => Promise<unknown>
  ): this;

  // Overload 3: With input and output schemas
  tool<I, O>(
    name: string,
    description: string,
    inputSchema: SchemaProvider<I>,
    outputSchema: SchemaProvider<O>,
    handler: (input: I) => Promise<O>
  ): this;

  // Same three overloads, but the tool is NOT mentioned in prompt text.
  // Use for infrastructure tools that should be available but not highlighted.
  defineTool(name, description, handler): this;
  defineTool(name, description, inputSchema, handler): this;
  defineTool(name, description, inputSchema, outputSchema, handler): this;
}
```

### Skill Methods

```typescript
class Plan<Output> {
  // Stored skill: path to a directory containing SKILL.md
  skill(path: string): this;

  // Virtual skill: defined programmatically
  skill(definition: VirtualSkillDefinition): this;
}

interface VirtualSkillDefinition {
  name: string;                // 1-64 chars, lowercase alphanumeric + hyphens
  description: string;         // 1-1024 chars
  body: string;                // Markdown instructions
  tools?: SkillTool[];         // Optional handler functions
}

interface SkillTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  handler: (input: I) => Promise<O>;
}
```

### Configuration Methods

```typescript
class Plan<Output> {
  // Set working directory for the session
  cwd(path: string): this;
}
```

### Execution Methods

```typescript
class Plan<Output> {
  // Execute the prompt, return typed result
  run(): Promise<Output>;

  // Execute the prompt, return streaming handle
  stream(): ThoughtStream<Output>;
}
```

## ThoughtStream

Returned by `.stream()`. Provides both streaming events and the final result.

```typescript
class ThoughtStream<Output> implements AsyncIterable<ThoughtEvent> {
  // Final typed result (resolves when agent calls return_result)
  readonly result: Promise<Output>;

  // Async iteration over events
  [Symbol.asyncIterator](): AsyncIterator<ThoughtEvent>;
}
```

Execution semantics:
- Execution starts eagerly when `stream()` is called
- The iterator and `result` promise are independent
- You can iterate events, await result, or both concurrently
- Breaking out of iteration is safe — `result` still resolves

## ThoughtEvent

Discriminated union of streaming event types:

```typescript
type ThoughtEvent =
  | { type: "thought"; text: string }
  | { type: "message"; text: string }
  | { type: "tool_start"; id: string; title: string; kind?: ToolKind }
  | { type: "tool_update"; id: string; status: string; content?: ToolContent[] }
  | { type: "tool_done"; id: string; status: "completed" | "failed" }
  | { type: "plan"; entries: PlanEntry[] };

type ToolKind =
  | "read" | "edit" | "delete" | "move"
  | "search" | "execute" | "think" | "fetch"
  | "switch_mode" | "other";

type ToolContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string; newText: string }
  | { type: "terminal"; terminalId: string };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string };

interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}
```

## SchemaProvider

The interface that connects type information to JSON Schema generation:

```typescript
interface SchemaProvider<T> {
  toJsonSchema(): JsonSchema;
}
```

Two ways to obtain a `SchemaProvider`:

1. **`@JSONSchema` annotation** — auto-generates `TypeName.Schema`:
   ```typescript
   /** @JSONSchema */
   interface Greeting { message: string; }
   // Greeting.Schema is a SchemaProvider<Greeting>
   ```

2. **`schemaOf()` helper** — wraps a raw JSON Schema object:
   ```typescript
   import { schemaOf } from "thinkwell";
   const schema = schemaOf<{ answer: string }>({
     type: "object",
     properties: { answer: { type: "string" } },
     required: ["answer"]
   });
   ```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `THINKWELL_AGENT` | Override the agent name (e.g., `gemini`) |
| `THINKWELL_AGENT_CMD` | Override the agent spawn command entirely |

These take precedence over the name or options passed to `open()`.
