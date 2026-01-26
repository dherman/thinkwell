/**
 * @thinkwell/conductor - TypeScript conductor for ACP proxy chains
 *
 * The conductor orchestrates message routing between clients, proxies, and agents.
 * It sits between every component, managing process lifecycle and message flow.
 */

// Conductor
export { Conductor, fromCommands, fromConnectors, type ConductorConfig } from "./conductor.js";

// Types
export type {
  RoleId,
  SourceIndex,
  ConductorMessage,
  ComponentConnection,
  ComponentConnector,
  InitializeRequest,
  InstantiatedComponents,
  ComponentInstantiator,
} from "./types.js";

export { ROLE_COUNTERPART } from "./types.js";

// Message queue
export { MessageQueue } from "./message-queue.js";

// Connectors
export {
  StdioConnector,
  stdio,
  ChannelConnector,
  createChannelPair,
  inProcess,
  echoComponent,
  type StdioConnectorOptions,
  type ChannelPair,
  type ComponentHandler,
} from "./connectors/index.js";

// Re-export protocol types that are commonly used with the conductor
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcId,
  Dispatch,
  Responder,
  RequestDispatch,
  NotificationDispatch,
  ResponseDispatch,
} from "@thinkwell/protocol";

export {
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createResponder,
} from "@thinkwell/protocol";
