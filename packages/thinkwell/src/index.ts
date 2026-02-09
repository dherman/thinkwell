// New API
export { Agent } from "./agent.js";
export type { ConnectOptions, SessionOptions } from "./agent.js";
export { Session } from "./session.js";

// Think builder
export { ThinkBuilder } from "./think-builder.js";

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

// Re-export connectors for convenient single-package import
export * from "./connectors/index.js";
