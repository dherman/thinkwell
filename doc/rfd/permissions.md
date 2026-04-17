# RFD: Permissions and Trust Model for Thinkwell

## Summary

Thinkwell currently auto-approves all permission requests from ACP agents. This design document explores the space of giving thinkwell programmers control over agent trust — from reactive permission handling (answering when the agent asks) through proactive capability enforcement (restricting what the agent can do regardless of whether it asks).

## Background

### The Two-Level Permission Story

There are two independent permission boundaries in the thinkwell/ACP architecture, and they operate at different layers:

1. **Agent-side permissions**: The agent (e.g., Claude Code) decides whether to *ask* permission before acting. In permissive mode (`--dangerously-skip-permissions`), it just acts. In normal mode, it sends `session/request_permission` before sensitive operations like file edits and shell commands.

2. **Client-side permissions**: Thinkwell, as the ACP client, *answers* those requests. This is where the programmer's trust policy lives.

These layers are complementary. The agent controls its own internal governance. Thinkwell controls what the orchestrating program is willing to authorize. Neither replaces the other — but when designed well, thinkwell's permission model can make the agent's blunt `--dangerously-skip-permissions` flag unnecessary.

### Current State

Thinkwell auto-approves all permission requests in two places:

In `packages/thinkwell/src/agent.ts` (the high-level API):

```typescript
requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  const firstOption = request.options[0];
  return Promise.resolve({
    outcome: { outcome: "selected", optionId: firstOption?.optionId ?? "approve" },
  });
}
```

In `packages/acp/src/connection.ts` (the lower-level ACP layer), with a comment that reads:

```typescript
// For now, auto-approve by selecting the first option
// In a real client, this would prompt the user
```

### ACP's Permission Protocol

ACP already defines a rich permission mechanism via the `session/request_permission` method. When the agent wants permission, it sends a `RequestPermissionRequest` containing:

- **`sessionId`** — which conversation this is about
- **`toolCall`** — details about the operation: `title` ("Edit src/main.ts"), `kind` ("edit"), `status`, `locations` (affected file paths), `rawInput` (the full tool input, opaque)
- **`options`** — an array of `PermissionOption`, each with a `kind` (`"allow_once"`, `"allow_always"`, `"reject_once"`, `"reject_always"`), a human-readable `name`, and an `optionId`

The client responds with either `{ outcome: "selected", optionId: "..." }` or `{ outcome: "cancelled" }`.

This protocol surface is well-designed for human-in-the-loop workflows. Thinkwell just needs to stop swallowing it.

### Use Cases

| Pattern | Description | Example |
|---------|-------------|---------|
| Fully autonomous | Auto-approve everything (current behavior) | Background batch processing |
| Policy-based | Rules that auto-approve/deny based on tool kind, paths, etc. | "Allow reads, deny writes, allow test execution" |
| Interactive | Prompt a human for each sensitive operation | CLI tools, IDE integrations |
| Mixed | Auto-approve safe operations, prompt for risky ones | "Allow reads, prompt for edits and commands" |

## Design: Reactive Permission Handling

### Core Abstraction

The fundamental type is an async callback function. This is the right primitive because thinkwell is a library, not a UI — it cannot assume a terminal, a web server, or any particular interaction model. A function gives the programmer maximum flexibility: it can be a policy lookup, a terminal prompt, a Slack message, or a hardcoded answer.

```typescript
/**
 * A function that decides how to handle a permission request from the agent.
 */
export type PermissionHandler =
  (request: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>;
```

Thinkwell defines its own `PermissionRequest` type, decoupled from ACP's raw `RequestPermissionRequest`, consistent with how `ThoughtEvent` and `ToolKind` decouple from ACP's raw session update types:

```typescript
export interface PermissionRequest {
  /** The session where the request originated. */
  sessionId: string;
  /** Human-readable title of the operation (e.g., "Edit src/main.ts"). */
  title: string;
  /** Category of tool: read, edit, execute, etc. */
  kind?: ToolKind;
  /** File paths affected by this operation. */
  locations?: Array<{ uri: string }>;
  /** Raw input to the tool (agent-specific, opaque). */
  rawInput?: unknown;
  /** The options the agent is offering. */
  options: PermissionOptionInfo[];
}

export interface PermissionOptionInfo {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type PermissionDecision =
  | { decision: "select"; optionId: string }
  | { decision: "cancel" };
```

### Three Configuration Levels

Permissions are configurable at three levels, with inner scopes layering on top of outer ones:

**Agent level** — default for all sessions and plans:

```typescript
const agent = await open('claude', {
  permissions: permissions.allowKinds("read", "search"),
});
```

**Session level** — override for a specific conversation:

```typescript
const session = await agent.createSession({
  cwd: "/my/project",
  permissions: permissions.allowAll(),
});
```

**Plan level** — override for a single execution:

```typescript
const result = await agent
  .think(SummarySchema)
  .text("Summarize this file")
  .permissions(permissions.denyAll())
  .run();
```

### Layered Composition

When a permission request arrives, handlers are consulted in order: Plan, then Session, then Agent, then the global default (`permissions.allowAll()` for backwards compatibility). Each handler can either make a decision or pass through to the next layer.

This requires a way for handlers to signal "no opinion." One approach is a sentinel return value:

```typescript
export type PermissionDecision =
  | { decision: "select"; optionId: string }
  | { decision: "cancel" }
  | { decision: "pass" };  // defer to next layer
```

With `"pass"`, composition is natural: a plan-level handler can handle writes but pass reads through to the session-level handler.

### Built-in Handlers

Thinkwell should ship composable handler factories:

```typescript
export const permissions = {
  /** Auto-approve everything. */
  allowAll(): PermissionHandler,

  /** Cancel/reject everything. */
  denyAll(): PermissionHandler,

  /**
   * Allow specific tool kinds, pass on the rest.
   * Useful as a layer: allow reads at the session level, handle writes at the plan level.
   */
  allowKinds(...kinds: ToolKind[]): PermissionHandler,

  /**
   * First-match policy rules. Unmatched requests use the default.
   */
  policy(rules: PolicyRule[], opts?: { default?: "allow" | "deny" | "pass" }): PermissionHandler,

  /**
   * Compose handlers: try each in order, first non-pass wins.
   */
  chain(...handlers: PermissionHandler[]): PermissionHandler,

  /**
   * Wrap a handler with a timeout.
   */
  withTimeout(ms: number, handler: PermissionHandler, opts: { onTimeout: "allow" | "deny" }): PermissionHandler,
};
```

Policy rules enable declarative configuration:

```typescript
const handler = permissions.policy([
  { kind: "read",    decision: "allow" },
  { kind: "search",  decision: "allow" },
  { kind: "execute", decision: "allow", when: (req) => req.title.includes("npm test") },
  { kind: "edit",    decision: "deny",  when: (req) =>
    req.locations?.some(l => l.uri.includes("node_modules"))
  },
], { default: "deny" });
```

### Interaction with Agent Permission Modes

When the agent runs in permissive mode (e.g., `--dangerously-skip-permissions`), it never sends `session/request_permission` calls. Thinkwell's handler is simply never invoked. This is correct: the two levels are independent.

The recommended pattern would shift from "use `--dangerously-skip-permissions`" to "run your agent in normal mode and define your trust policy in thinkwell." This gives the programmer fine-grained control instead of a binary all-or-nothing flag.

### Wiring

The `createClient()` function in `agent.ts` constructs the ACP `Client` interface. Its `requestPermission` method needs to:

1. Convert the ACP `RequestPermissionRequest` to a thinkwell `PermissionRequest`
2. Look up the handler chain for the request's `sessionId`
3. Walk the chain (plan → session → agent → default) until a handler returns a non-pass decision
4. Convert the `PermissionDecision` back to an ACP `RequestPermissionResponse`

This requires `AgentConnection` to track per-session permission handlers alongside the existing per-session `SessionHandler` map.

## Design: Proactive Capability Enforcement

### The Reactive Model's Limitation

The reactive permission handler depends on the agent cooperating — the agent must send `requestPermission` for the handler to be invoked. If the agent runs in permissive mode, or if it has a bug, or if a future agent simply doesn't implement the permission protocol, the handler provides no protection.

### The Conductor as Enforcement Point

Thinkwell's conductor already routes all ACP messages through a central event loop and supports proxy chains:

```
Client <-> Conductor <-> [Proxy 0] <-> [Proxy 1] <-> ... <-> Agent
```

This architecture provides a natural enforcement point. A **capability enforcement proxy** could sit in the proxy chain and inspect every message, blocking operations that violate the programmer's trust policy — regardless of whether the agent asks permission.

The conductor RFD explicitly anticipated this: "Don't preclude exposing a Component API for proxy authors later."

### What the Proxy Can See

ACP defines several client-facing methods that the agent calls to interact with the environment:

| ACP Method | What it does | Enforceable? |
|------------|-------------|--------------|
| `session/write_text_file` | Write/create a file | Yes — check path against allowed patterns |
| `session/read_text_file` | Read a file | Yes — check path against allowed patterns |
| `session/create_terminal` | Create a terminal session | Yes — can block entirely |
| `session/terminal_output` | Send terminal commands | Yes — inspect commands against allowlist |
| `session/kill_terminal_command` | Kill a terminal process | Yes |
| `session/request_permission` | Ask for permission (pass-through to reactive handler) | N/A |
| Extension methods (`_mcp/*`) | MCP tool calls | Yes — inspect tool names and inputs |

A capability enforcement proxy would:
1. Inspect each agent-to-client request
2. Check it against the capability envelope
3. Allow matching requests to pass through
4. Return an error response for violations (the agent sees "permission denied" and can adapt)

### Declarative Capability Envelope

The programmer declares what the agent is allowed to do:

```typescript
const agent = await open('claude', {
  capabilities: {
    filesystem: {
      read: ['src/**', 'docs/**'],
      write: ['src/**'],
      deny: ['**/.env', '**/secrets*'],
    },
    execute: {
      allow: ['npm test', 'npm run lint'],
    },
    network: false,
  },
});
```

Under the hood, this compiles into proxy rules that the conductor enforces.

### Built-in vs. Separate Proxy

**Option A: Built into the conductor.** The conductor itself understands capability restrictions and enforces them during message routing. Simpler to wire up, but couples enforcement logic into the conductor.

**Option B: Separate proxy component.** A standalone capability proxy that plugs into the proxy chain like any other proxy. More modular, follows the conductor's existing component model, and allows the enforcement proxy to be developed and tested independently.

Option B is architecturally cleaner and more consistent with the conductor's existing design. The enforcement proxy is just another proxy — it receives messages, inspects them, and either forwards or blocks.

## Design: Spawn-Level Sandboxing

### What the Process Can See

When thinkwell spawns an agent process, that process inherits access to the filesystem, environment variables, and network. Spawn-level sandboxing restricts this at the OS level — the agent literally cannot access what it can't see.

Thinkwell already provides `env` and `cwd` options at spawn time. This could be extended:

```typescript
const agent = await open('claude', {
  env: { /* only these vars — secrets stripped */ },
  cwd: '/my/project',
  // Potential future options:
  // sandbox: { network: false, readonlyPaths: [...] }
});
```

### Scope Boundary

OS-level sandboxing (containers, namespaces, seccomp, etc.) is powerful but platform-specific and out of scope for thinkwell's core. Thinkwell's role is to make it easy to configure the agent's environment; actual isolation belongs to the deployment environment (Docker, nsjail, Firecracker, etc.).

What thinkwell can do:
- Strip environment variables (already supported via `env`)
- Set the working directory (already supported via `cwd`)
- Document recommended sandboxing approaches for different platforms

What thinkwell should not do:
- Implement its own filesystem sandbox
- Depend on platform-specific isolation APIs

## The Unified Trust Model

The three mechanisms form a layered defense:

```
Spawn Configuration (hard boundary)
  - Restricts the universe: what the process can physically access
  - Enforcement: OS-level, impossible to bypass from within the process
  - Granularity: Coarse (whole process)

    Capability Enforcement Proxy (proactive policy)
      - Restricts within the universe: what operations are allowed
      - Enforcement: Message-level interception, agent cannot bypass via ACP
      - Granularity: Fine (per-operation, per-path)

        Permission Handler (reactive approval)
          - Catches edge cases: operations that pass policy but need human judgment
          - Enforcement: Agent cooperation (agent must ask)
          - Granularity: Finest (interactive, context-dependent)
```

These layers compose naturally:

1. **Spawn** restricts the universe — the agent can't access files outside its `cwd`, can't see secrets stripped from env
2. **Proxy** enforces policy within that universe — blocks writes to config files, restricts terminal commands to an allowlist
3. **Handler** catches what policy can't — unusual operations, one-off approvals, or interactive confirmation for destructive actions

A capability declaration at the top level compiles down to all three:

```typescript
const agent = await open('claude', {
  // Declarative — the "what I want" layer
  capabilities: {
    filesystem: { read: ['src/**'], write: ['src/**'] },
    execute: { allow: ['npm test'] },
  },
  // Reactive — for anything that passes the capability filter
  permissions: myInteractiveHandler,
});
```

## Implementation Phases

| Phase | What | Complexity | Value |
|-------|------|------------|-------|
| **V1** | Permission handler callback + built-in policies | Low | Immediate — enables human-in-the-loop |
| **V2** | Capability enforcement proxy in conductor chain | Medium | Real safety — proactive, agent can't bypass |
| **V3** | Declarative capability envelope that compiles to proxy rules | Medium | DX — nice abstraction on top of V1+V2 |
| **V4** | Spawn sandboxing helpers / documentation | Variable | Defense in depth |

V1 is the foundation and provides immediate value. V2 is where the real safety guarantee lives. V3 is the ergonomic layer that makes V2 pleasant to use. V4 is defense-in-depth that complements the others.

## Open Questions

### Should enforcement be built into the conductor or a separate proxy?

The conductor RFD anticipated a future "Component API for proxy authors." A separate enforcement proxy is more consistent with this vision and more modular. But it requires the proxy authoring API to exist.

### ToolKind vocabulary: standardized or agent-specific?

The `kind` field in permission requests (and tool call updates) uses values like `"read"`, `"edit"`, `"execute"`. These values are agent-defined, not standardized by ACP. Claude Code might use `"edit"` while another agent uses `"file_write"`.

This affects the portability of built-in policies like `allowKinds("read")`. Options:
- Document that kind values are agent-specific and policies may need agent-aware rules
- Define a thinkwell-level normalization layer that maps agent-specific kinds to canonical ones
- Work with ACP to standardize the vocabulary

Thinkwell already defines its own `ToolKind` type in `thought-event.ts`. This could serve as the normalization target.

### Multi-agent trust delegation

If thinkwell orchestrates multiple agents (or an agent spawns sub-agents), should trust be transitive? If Agent A is allowed to edit files, and it spawns Agent B, should B inherit that permission?

This is the classic capability delegation problem. For now, each agent connection has its own independent trust configuration. Transitive trust is a future design problem.

### MCP tool restrictions

The permission model as described governs the agent's built-in tools (file I/O, terminal, etc.). Should there also be a way to restrict which *MCP tools* the agent can call?

Currently, MCP tools registered via `Plan.tool()` are all available to the agent. But if skills or external MCP servers provide tools, a programmer might want to restrict which ones are accessible in a given session or plan.

This is related but distinct from the permission model — it's more about tool visibility than authorization. It could be addressed by:
- Filtering `tools/list` responses based on session/plan configuration
- A separate `allowedTools` option rather than overloading the permission handler
