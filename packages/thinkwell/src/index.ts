// New API
export { Agent } from "./agent.js";
export type { ConnectOptions, SessionOptions } from "./agent.js";
export { Session } from "./session.js";

// Think builder
export { ThinkBuilder } from "./think-builder.js";

// Schema helpers
export { schemaOf } from "./schema.js";

// Re-export useful types from sacp
export type { JsonSchema, SchemaProvider, JsonValue, JsonObject } from "@thinkwell/acp";

// Deprecated API - will be removed in next major version
/** @deprecated Use Agent instead */
export { Patchwork } from "./patchwork.js";
/** @deprecated Use Agent.connect() instead */
export { connect } from "./patchwork.js";
