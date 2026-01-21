/**
 * Types for MCP-over-ACP protocol messages
 */

import type { JsonValue } from "./json.js";

/**
 * JSON Schema type for tool input/output validation.
 *
 * This is a structural subset of JSON Schema, designed to be compatible
 * with schemas produced by third-party libraries without requiring them
 * as dependencies.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: JsonValue[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

/**
 * Interface for types that can provide a JSON Schema representation.
 *
 * This enables integration with various schema technologies:
 * - Schema-first libraries (Zod, TypeBox)
 * - Build-time type-to-schema generators (TypeSpec, ts-json-schema-transformer)
 * - Hand-written schemas with type associations
 *
 * @typeParam T - The TypeScript type that this schema describes
 */
export interface SchemaProvider<T> {
  /**
   * Returns the JSON Schema that describes type T.
   */
  toJsonSchema(): JsonSchema;
}

/**
 * MCP server configuration for session requests
 */
export interface McpServerConfig {
  type: "http";
  name: string;
  url: string;
}

/**
 * Context provided to tool handlers
 */
export interface McpContext {
  /** The connection ID for this MCP session */
  connectionId: string;
  /** The session ID for the ACP session */
  sessionId: string;
}

/**
 * MCP connect request from conductor
 */
export interface McpConnectRequest {
  method: "_mcp/connect";
  params: {
    connectionId: string;
    url: string;
  };
}

/**
 * MCP connect response
 */
export interface McpConnectResponse {
  connectionId: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    tools?: Record<string, unknown>;
  };
  /** Optional tool definitions - the bridge may use these to pre-populate tool info */
  tools?: McpToolDefinition[];
}

/**
 * MCP message request (tool call, etc.)
 */
export interface McpMessageRequest {
  method: "_mcp/message";
  params: {
    connectionId: string;
    method: string;
    id?: string | number;
    params?: unknown;
  };
}

/**
 * MCP message response
 */
export interface McpMessageResponse {
  connectionId: string;
  content?: McpContent[];
  result?: unknown;
  error?: McpError;
}

/**
 * MCP content block
 */
export interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * MCP error
 */
export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * MCP disconnect notification
 */
export interface McpDisconnectNotification {
  method: "_mcp/disconnect";
  params: {
    connectionId: string;
  };
}

/**
 * MCP tools/list response
 */
export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

/**
 * MCP tool definition
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * MCP tools/call request params
 */
export interface McpToolsCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * MCP tools/call response
 */
export interface McpToolsCallResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Session message types
 */
export type SessionMessage =
  | { type: "text"; content: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "stop"; reason: StopReason };

/**
 * Reason for stopping
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

/**
 * Tool handler function type
 */
export type ToolHandler<I = unknown, O = unknown> = (
  input: I,
  context: McpContext
) => Promise<O>;

/**
 * Registered tool with metadata
 */
export interface RegisteredTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  handler: ToolHandler<I, O>;
}
