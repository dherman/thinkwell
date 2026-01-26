/**
 * Conductor - orchestrates ACP proxy chains
 *
 * The conductor sits between a client and an agent, managing message routing
 * through a chain of proxy components. It:
 *
 * 1. Manages the message event loop
 * 2. Routes messages left-to-right (client → proxies → agent)
 * 3. Routes messages right-to-left (agent → proxies → client)
 * 4. Correlates requests with responses via a pending request map
 */

import type {
  JsonRpcMessage,
  JsonRpcId,
  Dispatch,
  Responder,
} from "@thinkwell/protocol";
import {
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  createSuccessResponse,
  createErrorResponse,
  createRequest,
  createNotification,
  createResponder,
} from "@thinkwell/protocol";

import type {
  ComponentConnection,
  ComponentConnector,
  ComponentInstantiator,
  ConductorMessage,
  SourceIndex,
  InitializeRequest,
} from "./types.js";
import { MessageQueue } from "./message-queue.js";

/**
 * Configuration for the Conductor
 */
export interface ConductorConfig {
  /** Optional name for this conductor (for debugging) */
  name?: string;
  /** The instantiator that creates components when initialization arrives */
  instantiator: ComponentInstantiator;
  /** MCP bridge mode (disabled by default for Phase 2) */
  mcpBridgeMode?: "http" | "disabled";
}

/**
 * State of the conductor
 */
type ConductorState =
  | { type: "uninitialized" }
  | { type: "initializing" }
  | { type: "running" }
  | { type: "shutdown" };

/**
 * Pending request entry - tracks requests waiting for responses
 */
interface PendingRequest {
  originalId: JsonRpcId;
  responder: Responder;
}

/**
 * The Conductor orchestrates ACP proxy chains.
 *
 * It sits between a client and an agent, routing all messages through
 * a central event loop to preserve message ordering.
 */
export class Conductor {
  private readonly config: ConductorConfig;
  private readonly messageQueue = new MessageQueue();
  private state: ConductorState = { type: "uninitialized" };

  // Component connections (populated after initialization)
  private clientConnection: ComponentConnection | null = null;
  private proxies: ComponentConnection[] = [];
  private agentConnection: ComponentConnection | null = null;

  // Request/response correlation
  // Maps outgoing request IDs to pending request info
  private pendingRequests = new Map<string, PendingRequest>();
  private nextRequestId = 1;

  constructor(config: ConductorConfig) {
    this.config = config;
  }

  /**
   * Connect to a client and run the conductor's message loop.
   *
   * This method blocks until the conductor shuts down.
   */
  async connect(clientConnector: ComponentConnector): Promise<void> {
    if (this.state.type !== "uninitialized") {
      throw new Error(`Conductor is already ${this.state.type}`);
    }

    this.clientConnection = await clientConnector.connect();

    // Pump client messages into the queue
    this.pumpClientMessages(this.clientConnection);

    // Run the main event loop
    await this.runEventLoop();
  }

  /**
   * Shut down the conductor
   */
  async shutdown(): Promise<void> {
    if (this.state.type === "shutdown") {
      return;
    }

    this.state = { type: "shutdown" };
    this.messageQueue.close();

    // Close all connections
    const closePromises: Promise<void>[] = [];

    if (this.clientConnection) {
      closePromises.push(this.clientConnection.close());
    }

    for (const proxy of this.proxies) {
      closePromises.push(proxy.close());
    }

    if (this.agentConnection) {
      closePromises.push(this.agentConnection.close());
    }

    await Promise.all(closePromises);
  }

  /**
   * Pump messages from the client into the message queue
   */
  private pumpClientMessages(client: ComponentConnection): void {
    (async () => {
      try {
        for await (const message of client.messages) {
          const dispatch = this.messageToDispatch(message, "client");
          if (dispatch) {
            this.messageQueue.push({
              type: "left-to-right",
              targetIndex: 0, // First component (proxy[0] or agent if no proxies)
              dispatch,
            });
          }
        }
      } catch (error) {
        console.error("Error reading from client:", error);
      } finally {
        // Client disconnected - shut down
        this.shutdown();
      }
    })();
  }

  /**
   * Pump messages from a component (proxy or agent) into the message queue
   */
  private pumpComponentMessages(
    connection: ComponentConnection,
    sourceIndex: SourceIndex
  ): void {
    (async () => {
      try {
        for await (const message of connection.messages) {
          const dispatch = this.messageToDispatch(message, "component");
          if (dispatch) {
            this.messageQueue.push({
              type: "right-to-left",
              sourceIndex,
              dispatch,
            });
          }
        }
      } catch (error) {
        console.error("Error reading from component:", error);
      } finally {
        // Component disconnected - shut down the whole chain
        this.shutdown();
      }
    })();
  }

  /**
   * Convert a JSON-RPC message to a Dispatch
   */
  private messageToDispatch(
    message: JsonRpcMessage,
    source: "client" | "component"
  ): Dispatch | null {
    if (isJsonRpcRequest(message)) {
      // For requests, we need to create a responder that routes back
      const responder = this.createResponderForSource(source, message.id);
      return {
        type: "request",
        id: message.id,
        method: message.method,
        params: message.params,
        responder,
      };
    }

    if (isJsonRpcNotification(message)) {
      return {
        type: "notification",
        method: message.method,
        params: message.params,
      };
    }

    if (isJsonRpcResponse(message)) {
      return {
        type: "response",
        id: message.id,
        result: "result" in message ? message.result : undefined,
        error: "error" in message ? message.error : undefined,
      };
    }

    return null;
  }

  /**
   * Create a responder that routes the response back to the appropriate destination
   */
  private createResponderForSource(
    source: "client" | "component",
    requestId: JsonRpcId
  ): Responder {
    if (source === "client") {
      // Response goes back to client
      return createResponder(
        (result) => {
          this.clientConnection?.send(createSuccessResponse(requestId, result));
        },
        (error) => {
          this.clientConnection?.send(createErrorResponse(requestId, error));
        }
      );
    } else {
      // Response goes back to the component that sent the request
      // For now in pass-through mode, this goes to the agent
      return createResponder(
        (result) => {
          this.agentConnection?.send(createSuccessResponse(requestId, result));
        },
        (error) => {
          this.agentConnection?.send(createErrorResponse(requestId, error));
        }
      );
    }
  }

  /**
   * Run the main event loop, processing messages from the queue
   */
  private async runEventLoop(): Promise<void> {
    for await (const message of this.messageQueue) {
      await this.handleMessage(message);
    }
  }

  /**
   * Handle a message from the queue
   */
  private async handleMessage(message: ConductorMessage): Promise<void> {
    switch (message.type) {
      case "left-to-right":
        await this.handleLeftToRight(message.targetIndex, message.dispatch);
        break;

      case "right-to-left":
        await this.handleRightToLeft(message.sourceIndex, message.dispatch);
        break;

      case "shutdown":
        // Already handled by message queue closing
        break;

      // MCP bridge messages will be handled in Phase 5
      case "mcp-connection-received":
      case "mcp-connection-established":
      case "mcp-client-to-server":
      case "mcp-connection-disconnected":
        // Not implemented yet
        break;
    }
  }

  /**
   * Handle a left-to-right message (client → agent direction)
   */
  private async handleLeftToRight(
    targetIndex: number,
    dispatch: Dispatch
  ): Promise<void> {
    // Check if this is an initialize request and we need to set up components
    if (
      dispatch.type === "request" &&
      (dispatch.method === "initialize" || dispatch.method === "acp/initialize")
    ) {
      await this.handleInitialize(dispatch);
      return;
    }

    // For pass-through mode (no proxies), forward directly to agent
    if (this.proxies.length === 0 && this.agentConnection) {
      this.forwardToConnection(this.agentConnection, dispatch);
      return;
    }

    // With proxies, forward to the target proxy or agent
    const target = this.getTargetConnection(targetIndex);
    if (target) {
      this.forwardToConnection(target, dispatch);
    }
  }

  /**
   * Handle a right-to-left message (agent → client direction)
   */
  private async handleRightToLeft(
    sourceIndex: SourceIndex,
    dispatch: Dispatch
  ): Promise<void> {
    // Responses need special handling - route via pending request map
    if (dispatch.type === "response") {
      this.handleResponse(dispatch);
      return;
    }

    // Notifications and requests from the agent go to the client
    // (In Phase 3, proxies will intercept and potentially modify)
    if (this.clientConnection) {
      this.forwardToConnection(this.clientConnection, dispatch);
    }
  }

  /**
   * Handle the initialize request - instantiate components and forward
   */
  private async handleInitialize(dispatch: Dispatch & { type: "request" }): Promise<void> {
    if (this.state.type !== "uninitialized") {
      dispatch.responder.respondWithError({
        code: -32600,
        message: "Conductor already initialized",
      });
      return;
    }

    this.state = { type: "initializing" };

    try {
      // Build the initialize request structure
      const initRequest: InitializeRequest = {
        method: dispatch.method as "initialize" | "acp/initialize",
        params: dispatch.params as InitializeRequest["params"],
      };

      // Instantiate components
      const { proxies, agent } = await this.config.instantiator.instantiate(initRequest);

      // Connect to proxies
      for (const proxyConnector of proxies) {
        const proxyConnection = await proxyConnector.connect();
        this.proxies.push(proxyConnection);
        // Start pumping messages from this proxy
        this.pumpComponentMessages(proxyConnection, {
          type: "proxy",
          index: this.proxies.length - 1,
        });
      }

      // Connect to agent
      this.agentConnection = await agent.connect();
      this.pumpComponentMessages(this.agentConnection, { type: "successor" });

      this.state = { type: "running" };

      // Forward the initialize request to the agent
      // Track it so we can route the response back
      const outgoingId = this.generateRequestId();
      this.pendingRequests.set(String(outgoingId), {
        originalId: dispatch.id,
        responder: dispatch.responder,
      });

      this.agentConnection.send(
        createRequest(outgoingId, dispatch.method, dispatch.params)
      );
    } catch (error) {
      this.state = { type: "uninitialized" };
      dispatch.responder.respondWithError({
        code: -32603,
        message: `Failed to initialize: ${error}`,
      });
    }
  }

  /**
   * Handle a response by routing it back to the original requester
   */
  private handleResponse(dispatch: Dispatch & { type: "response" }): void {
    const pending = this.pendingRequests.get(String(dispatch.id));
    if (!pending) {
      // No pending request for this ID - might be a duplicate or error
      console.error(`No pending request for response ID: ${dispatch.id}`);
      return;
    }

    this.pendingRequests.delete(String(dispatch.id));

    if (dispatch.error) {
      pending.responder.respondWithError(dispatch.error);
    } else {
      pending.responder.respond(dispatch.result);
    }
  }

  /**
   * Forward a dispatch to a connection, handling request ID rewriting
   */
  private forwardToConnection(
    connection: ComponentConnection,
    dispatch: Dispatch
  ): void {
    switch (dispatch.type) {
      case "request": {
        // Rewrite request ID and track for response routing
        const outgoingId = this.generateRequestId();
        this.pendingRequests.set(String(outgoingId), {
          originalId: dispatch.id,
          responder: dispatch.responder,
        });
        connection.send(createRequest(outgoingId, dispatch.method, dispatch.params));
        break;
      }

      case "notification":
        connection.send(createNotification(dispatch.method, dispatch.params));
        break;

      case "response":
        // Responses are handled via handleResponse, not forwarded directly
        if (dispatch.error) {
          connection.send(createErrorResponse(dispatch.id, dispatch.error));
        } else {
          connection.send(createSuccessResponse(dispatch.id, dispatch.result));
        }
        break;
    }
  }

  /**
   * Get the target connection for a given index
   * Index 0..n-1 are proxies, index n is the agent
   */
  private getTargetConnection(targetIndex: number): ComponentConnection | null {
    if (targetIndex < this.proxies.length) {
      return this.proxies[targetIndex];
    }
    if (targetIndex === this.proxies.length) {
      return this.agentConnection;
    }
    return null;
  }

  /**
   * Generate a unique request ID for outgoing requests
   */
  private generateRequestId(): number {
    return this.nextRequestId++;
  }
}

/**
 * Create a component instantiator from a list of commands
 *
 * The last command is treated as the agent, all others as proxies.
 */
export function fromCommands(commands: string[]): ComponentInstantiator {
  // Import StdioConnector dynamically to avoid circular dependency
  return {
    async instantiate(): Promise<{ proxies: ComponentConnector[]; agent: ComponentConnector }> {
      const { StdioConnector } = await import("./connectors/stdio.js");

      if (commands.length === 0) {
        throw new Error("At least one command (the agent) is required");
      }

      const connectors = commands.map((cmd) => new StdioConnector(cmd));

      return {
        proxies: connectors.slice(0, -1),
        agent: connectors[connectors.length - 1],
      };
    },
  };
}

/**
 * Create a component instantiator from explicit connectors
 */
export function fromConnectors(
  agent: ComponentConnector,
  proxies: ComponentConnector[] = []
): ComponentInstantiator {
  return {
    async instantiate() {
      return { proxies, agent };
    },
  };
}
