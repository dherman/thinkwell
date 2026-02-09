/**
 * Categories of tools that can be invoked.
 * Mirrors ACP's ToolKind but kept as a Thinkwell-level type for decoupling.
 */
export type ToolKind =
  | "read" | "edit" | "delete" | "move"
  | "search" | "execute" | "think" | "fetch"
  | "switch_mode" | "other";

/**
 * A standard content block (text, image, etc.).
 * Simplified from ACP's ContentBlock to expose only user-facing fields.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string };

/**
 * Parsed from ACP's ToolCallContent discriminated union.
 * Exposed as typed variants so users get structured access to
 * file diffs, terminal output, etc. without raw ACP types.
 */
export type ToolContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string; newText: string }
  | { type: "terminal"; terminalId: string };

/**
 * A single entry in the agent's execution plan.
 */
export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/**
 * Thinkwell-level discriminated union of streaming events.
 *
 * These are protocol-independent — not raw ACP types — giving us
 * freedom to evolve the event vocabulary independently of the protocol.
 *
 * Events do not carry timestamps. ACP content chunks have no standard
 * timestamp field, so any timestamp would be client-side receipt time.
 */
export type ThoughtEvent =
  | { type: "thought"; text: string }
  | { type: "message"; text: string }
  | { type: "tool_start"; id: string; title: string; kind?: ToolKind }
  | { type: "tool_update"; id: string; status: string; content?: ToolContent[] }
  | { type: "tool_done"; id: string; status: "completed" | "failed" }
  | { type: "plan"; entries: PlanEntry[] };
