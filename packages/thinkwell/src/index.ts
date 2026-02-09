// New API
export { open } from "./agent.js";
export type { Agent, AgentName, AgentOptions, CustomAgentOptions, SessionOptions } from "./agent.js";
export { Session } from "./session.js";

// Think builder
export { ThinkBuilder } from "./think-builder.js";

// Schema helpers
export { schemaOf } from "./schema.js";

// Re-export useful types from @thinkwell/acp
export type { JsonSchema, SchemaProvider, JsonValue, JsonObject } from "@thinkwell/acp";
