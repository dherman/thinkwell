// New API
export { open } from "./agent.js";
export type { Agent, AgentName, AgentOptions, CustomAgentOptions, SessionOptions } from "./agent.js";
export { Session } from "./session.js";

// Plan (fluent prompt builder)
export { Plan, ThinkBuilder } from "./think-builder.js";
export type { VirtualSkillDefinition } from "./think-builder.js";

// Thought streaming
export { ThoughtStream } from "./thought-stream.js";
export type {
  ThoughtEvent,
  ToolContent,
  ContentBlock,
  PlanEntry,
  ToolKind,
} from "./thought-event.js";

// Schema helpers
export { schemaOf } from "./schema.js";

// Re-export useful types from @thinkwell/acp
export type { JsonSchema, SchemaProvider, JsonValue, JsonObject } from "@thinkwell/acp";
export type { Skill, VirtualSkill, StoredSkill, SkillTool } from "@thinkwell/acp";
