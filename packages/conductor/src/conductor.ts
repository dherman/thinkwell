/**
 * Conductor - orchestrates ACP proxy chains
 *
 * The conductor sits between a client and an agent, managing message routing
 * through a chain of proxy components. It:
 *
 * 1. Manages the message event loop
 * 2. Routes messages left-to-right (client → proxies → agent)
 * 3. Routes messages right-to-left (agent → proxies → client)
 * 4. Handles `_proxy/successor/*` message wrapping/unwrapping
 * 5. Manages proxy capability handshake during initialization
 * 6. Correlates requests with responses via a pending request map
 * 7. Bridges MCP-over-ACP for agents without native ACP transport support
 */

import type {
  JsonRpcMessage,
  JsonRpcId,
  JsonRpcError,
  Dispatch,
  Responder,
  ProxySuccessorRequestParams,
  ProxySuccessorNotificationParams,
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
  PROXY_SUCCESSOR_REQUEST,
  PROXY_SUCCESSOR_NOTIFICATION,
  unwrapProxySuccessorRequest,
  unwrapProxySuccessorNotification,
  wrapAsProxySuccessorRequest,
  wrapAsProxySuccessorNotification,
} from "@thinkwell/protocol";

import type {
  ComponentConnection,
  ComponentConnector,
  ComponentInstantiator,
  ConductorMessage,
  SourceIndex,
  InitializeRequest,
  InitializeResponse,
} from "./types.js";
import { MessageQueue } from "./message-queue.js";
import { McpBridge, type McpServerSpec } from "./mcp-bridge/index.js";

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
 *
 * We track the source so we know how to route the response back:
 * - "client" → send response directly to client
 * - proxyIndex → wrap response and send as `_proxy/successor/request` response to that proxy
 */
interface PendingRequest {
  originalId: JsonRpcId;
  responder: Responder;
  /** Source of the request - "client" or proxy index */
  source: "client" | number;
}

/**
 * The Conductor orchestrates ACP proxy chains.
 *
 * It sits between a client and an agent, routing all messages through
 * a central event loop to preserve message ordering.
 *
 * ## Message Flow with Proxies
 *
 * ### Left-to-Right (client → agent):
 * 1. Client sends request to conductor
 * 2. Conductor forwards to proxy[0] (normal ACP)
 * 3. Proxy[0] sends `_proxy/successor/request` to conductor
 * 4. Conductor unwraps and forwards to proxy[1] (normal ACP)
 * 5. ... until agent receives normal ACP
 *
 * ### Right-to-Left (agent → client):
 * 1. Agent sends notification/request to conductor
 * 2. Conductor wraps in `_proxy/successor/request` and sends to proxy[n-1]
 * 3. Proxy[n-1] processes and forwards to conductor
 * 4. ... until client receives normal ACP
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

  // MCP Bridge for agents without native MCP-over-ACP support
  private mcpBridge: McpBridge | null = null;

  // Track whether agent supports mcp_acp_transport capability
  private agentSupportsMcpAcpTransport = false;

  // Pending session/new requests waiting for response (for MCP URL transformation)
  private pendingSessionRequests = new Map<
    string,
    { sessionKey: string; originalParams: unknown }
  >();

  // Maps MCP connection IDs to their responders for _mcp/connect
  private mcpConnectResponders = new Map<string, Responder>();

  constructor(config: ConductorConfig) {
    this.config = config;
    // Initialize MCP bridge if enabled
    if (config.mcpBridgeMode !== "disabled") {
      this.mcpBridge = new McpBridge({ messageQueue: this.messageQueue });
    }
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

    // Close MCP bridge
    if (this.mcpBridge) {
      closePromises.push(this.mcpBridge.close());
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
          // Responses from the client (to agent requests) need special handling
          if (isJsonRpcResponse(message)) {
            const dispatch = this.messageToDispatch(message, { type: "client" });
            if (dispatch && dispatch.type === "response") {
              // Route the response back via pendingRequests
              this.handleResponse(dispatch);
            }
            continue;
          }

          const dispatch = this.messageToDispatch(message, { type: "client" });
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
   * Pump messages from a proxy into the message queue
   */
  private pumpProxyMessages(
    connection: ComponentConnection,
    proxyIndex: number
  ): void {
    (async () => {
      try {
        for await (const message of connection.messages) {
          // Check for `_proxy/successor/*` messages
          if (isJsonRpcRequest(message)) {
            if (message.method === PROXY_SUCCESSOR_REQUEST) {
              // Proxy is forwarding a request to its successor
              this.handleProxySuccessorRequest(proxyIndex, message);
              continue;
            }
          }
          if (isJsonRpcNotification(message)) {
            if (message.method === PROXY_SUCCESSOR_NOTIFICATION) {
              // Proxy is forwarding a notification to its successor
              this.handleProxySuccessorNotification(proxyIndex, message);
              continue;
            }
          }

          // Non-successor messages go right-to-left (toward client)
          const dispatch = this.messageToDispatch(message, {
            type: "proxy",
            index: proxyIndex,
          });
          if (dispatch) {
            this.messageQueue.push({
              type: "right-to-left",
              sourceIndex: { type: "proxy", index: proxyIndex },
              dispatch,
            });
          }
        }
      } catch (error) {
        console.error(`Error reading from proxy[${proxyIndex}]:`, error);
      } finally {
        // Component disconnected - shut down the whole chain
        this.shutdown();
      }
    })();
  }

  /**
   * Pump messages from the agent into the message queue
   */
  private pumpAgentMessages(connection: ComponentConnection): void {
    (async () => {
      try {
        for await (const message of connection.messages) {
          const dispatch = this.messageToDispatch(message, {
            type: "successor",
          });
          if (dispatch) {
            this.messageQueue.push({
              type: "right-to-left",
              sourceIndex: { type: "successor" },
              dispatch,
            });
          }
        }
      } catch (error) {
        console.error("Error reading from agent:", error);
      } finally {
        // Component disconnected - shut down the whole chain
        this.shutdown();
      }
    })();
  }

  /**
   * Handle a `_proxy/successor/request` from a proxy
   *
   * The proxy is forwarding a request to its successor (next proxy or agent).
   * We unwrap the inner request and forward it.
   */
  private handleProxySuccessorRequest(
    proxyIndex: number,
    message: JsonRpcMessage & { id: JsonRpcId; method: string; params?: unknown }
  ): void {
    const params = message.params as ProxySuccessorRequestParams;
    const inner = unwrapProxySuccessorRequest(params);

    // Create a responder that wraps the response back to the proxy
    const responder = createResponder(
      (result) => {
        // Send success response back to the proxy for the _proxy/successor/request
        this.proxies[proxyIndex]?.send(createSuccessResponse(message.id, result));
      },
      (error) => {
        // Send error response back to the proxy
        this.proxies[proxyIndex]?.send(createErrorResponse(message.id, error));
      }
    );

    const dispatch: Dispatch = {
      type: "request",
      id: message.id,
      method: inner.method,
      params: inner.params,
      responder,
    };

    // Forward to the next component (proxy[proxyIndex+1] or agent)
    const targetIndex = proxyIndex + 1;
    this.messageQueue.push({
      type: "left-to-right",
      targetIndex,
      dispatch,
    });
  }

  /**
   * Handle a `_proxy/successor/notification` from a proxy
   *
   * The proxy is forwarding a notification to its successor.
   */
  private handleProxySuccessorNotification(
    proxyIndex: number,
    message: JsonRpcMessage & { method: string; params?: unknown }
  ): void {
    const params = message.params as ProxySuccessorNotificationParams;
    const inner = unwrapProxySuccessorNotification(params);

    const dispatch: Dispatch = {
      type: "notification",
      method: inner.method,
      params: inner.params,
    };

    // Forward to the next component
    const targetIndex = proxyIndex + 1;
    this.messageQueue.push({
      type: "left-to-right",
      targetIndex,
      dispatch,
    });
  }

  /**
   * Convert a JSON-RPC message to a Dispatch
   */
  private messageToDispatch(
    message: JsonRpcMessage,
    source: { type: "client" } | { type: "proxy"; index: number } | { type: "successor" }
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
    source: { type: "client" } | { type: "proxy"; index: number } | { type: "successor" },
    requestId: JsonRpcId
  ): Responder {
    if (source.type === "client") {
      // Response goes back to client
      return createResponder(
        (result) => {
          this.clientConnection?.send(createSuccessResponse(requestId, result));
        },
        (error) => {
          this.clientConnection?.send(createErrorResponse(requestId, error));
        }
      );
    } else if (source.type === "proxy") {
      // Response goes back to the proxy (as response to a normal ACP request)
      const proxyIndex = source.index;
      return createResponder(
        (result) => {
          this.proxies[proxyIndex]?.send(createSuccessResponse(requestId, result));
        },
        (error) => {
          this.proxies[proxyIndex]?.send(createErrorResponse(requestId, error));
        }
      );
    } else {
      // Response goes back to the agent
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

      // MCP bridge messages
      case "mcp-connection-received":
        await this.handleMcpConnectionReceived(message.acpUrl, message.connectionId);
        break;

      case "mcp-connection-established":
        // Connection established successfully - nothing more to do
        break;

      case "mcp-client-to-server":
        await this.handleMcpClientToServer(message.connectionId, message.dispatch);
        break;

      case "mcp-connection-disconnected":
        await this.handleMcpConnectionDisconnected(message.connectionId);
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
    // Check if this is an initialize request from the client and we need to set up components
    if (
      targetIndex === 0 &&
      dispatch.type === "request" &&
      (dispatch.method === "initialize" || dispatch.method === "acp/initialize")
    ) {
      await this.handleInitialize(dispatch);
      return;
    }

    // Check if this is a session/new request that needs MCP URL transformation
    if (
      dispatch.type === "request" &&
      dispatch.method === "session/new" &&
      this.mcpBridge &&
      !this.agentSupportsMcpAcpTransport
    ) {
      await this.handleSessionNew(targetIndex, dispatch);
      return;
    }

    // Determine target connection
    const target = this.getTargetConnection(targetIndex);
    if (!target) {
      if (dispatch.type === "request") {
        dispatch.responder.respondWithError({
          code: -32603,
          message: `No target connection for index ${targetIndex}`,
        });
      }
      return;
    }

    // Forward to the target
    this.forwardToConnection(target, dispatch);
  }

  /**
   * Handle a right-to-left message (agent/proxy → client direction)
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

    // Determine where to send this message
    // - If from successor (agent) and we have proxies, wrap and send to last proxy
    // - If from proxy[n], send to proxy[n-1] or client if n==0
    // - If no proxies, send directly to client

    if (this.proxies.length === 0) {
      // No proxies - send directly to client
      if (this.clientConnection) {
        this.forwardToConnection(this.clientConnection, dispatch);
      }
      return;
    }

    if (sourceIndex.type === "successor") {
      // Message from agent - wrap and send to last proxy
      const lastProxyIndex = this.proxies.length - 1;
      this.forwardWrappedToProxy(lastProxyIndex, dispatch);
    } else if (sourceIndex.type === "proxy") {
      const proxyIndex = sourceIndex.index;
      if (proxyIndex === 0) {
        // First proxy - send to client (unwrapped)
        if (this.clientConnection) {
          this.forwardToConnection(this.clientConnection, dispatch);
        }
      } else {
        // Send to previous proxy (wrapped)
        this.forwardWrappedToProxy(proxyIndex - 1, dispatch);
      }
    }
  }

  /**
   * Forward a dispatch to a proxy, wrapped in `_proxy/successor/*`
   *
   * This is used when routing messages FROM a successor (agent or later proxy)
   * TO an earlier proxy in the chain.
   */
  private forwardWrappedToProxy(proxyIndex: number, dispatch: Dispatch): void {
    const proxy = this.proxies[proxyIndex];
    if (!proxy) return;

    switch (dispatch.type) {
      case "request": {
        // Wrap as `_proxy/successor/request`
        const wrappedParams = wrapAsProxySuccessorRequest(
          dispatch.method,
          dispatch.params
        );
        const outgoingId = this.generateRequestId();
        this.pendingRequests.set(String(outgoingId), {
          originalId: dispatch.id,
          responder: dispatch.responder,
          source: proxyIndex,
        });
        proxy.send(
          createRequest(outgoingId, PROXY_SUCCESSOR_REQUEST, wrappedParams)
        );
        break;
      }

      case "notification": {
        // Wrap as `_proxy/successor/notification`
        const wrappedParams = wrapAsProxySuccessorNotification(
          dispatch.method,
          dispatch.params
        );
        proxy.send(createNotification(PROXY_SUCCESSOR_NOTIFICATION, wrappedParams));
        break;
      }

      case "response":
        // Responses are handled via handleResponse, not here
        break;
    }
  }

  /**
   * Handle the initialize request - instantiate components and perform initialization sequence
   *
   * The initialization follows this sequence:
   * 1. Instantiate all components (connect to proxies and agent)
   * 2. Send `initialize` with `_meta.proxy: true` to proxy[0]
   * 3. Proxy[0] will use `_proxy/successor/request` to forward to proxy[1], etc.
   * 4. Agent receives `initialize` without proxy capability
   * 5. Responses flow back up the chain
   * 6. Conductor verifies each proxy accepted the proxy capability
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
        this.pumpProxyMessages(proxyConnection, this.proxies.length - 1);
      }

      // Connect to agent
      this.agentConnection = await agent.connect();
      this.pumpAgentMessages(this.agentConnection);

      this.state = { type: "running" };

      if (this.proxies.length === 0) {
        // No proxies - forward initialize directly to agent
        const outgoingId = this.generateRequestId();
        this.pendingRequests.set(String(outgoingId), {
          originalId: dispatch.id,
          responder: this.createAgentInitializeResponder(dispatch.responder),
          source: "client",
        });

        this.agentConnection.send(
          createRequest(outgoingId, dispatch.method, dispatch.params)
        );
      } else {
        // With proxies - send initialize with proxy capability to first proxy
        const paramsWithProxy = this.addProxyCapability(dispatch.params);

        const outgoingId = this.generateRequestId();
        this.pendingRequests.set(String(outgoingId), {
          originalId: dispatch.id,
          responder: this.createProxyInitializeResponder(
            this.createAgentInitializeResponder(dispatch.responder)
          ),
          source: "client",
        });

        this.proxies[0].send(
          createRequest(outgoingId, dispatch.method, paramsWithProxy)
        );
      }
    } catch (error) {
      this.state = { type: "uninitialized" };
      dispatch.responder.respondWithError({
        code: -32603,
        message: `Failed to initialize: ${error}`,
      });
    }
  }

  /**
   * Add proxy capability to initialize params
   */
  private addProxyCapability(params: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    const meta = (p._meta ?? {}) as Record<string, unknown>;
    return {
      ...p,
      _meta: {
        ...meta,
        proxy: true,
      },
    };
  }

  /**
   * Remove proxy capability from initialize params (for forwarding to agent)
   */
  private removeProxyCapability(params: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    const meta = (p._meta ?? {}) as Record<string, unknown>;
    const { proxy: _, ...restMeta } = meta;
    return {
      ...p,
      _meta: restMeta,
    };
  }

  /**
   * Create a responder that verifies the proxy accepted the capability
   */
  private createProxyInitializeResponder(originalResponder: Responder): Responder {
    return createResponder(
      (result) => {
        // Verify the proxy accepted the proxy capability
        const response = result as InitializeResponse;
        if (!response?._meta?.proxy) {
          originalResponder.respondWithError({
            code: -32600,
            message: "Proxy component did not accept proxy capability",
          });
          return;
        }
        originalResponder.respond(result);
      },
      (error) => {
        originalResponder.respondWithError(error);
      }
    );
  }

  /**
   * Create a responder that captures the agent's mcp_acp_transport capability
   */
  private createAgentInitializeResponder(originalResponder: Responder): Responder {
    return createResponder(
      (result) => {
        // Capture the mcp_acp_transport capability
        const response = result as InitializeResponse;
        if (response?.capabilities?.mcp_acp_transport) {
          this.agentSupportsMcpAcpTransport = true;
        }
        originalResponder.respond(result);
      },
      (error) => {
        originalResponder.respondWithError(error);
      }
    );
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
          source: "client", // Default - actual source tracking is in PendingRequest
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
   * Handle a session/new request - transform acp: URLs to http: URLs
   *
   * If the request contains MCP servers with acp: URLs and the agent doesn't
   * support mcp_acp_transport, we:
   * 1. Spawn HTTP listeners for each acp: URL
   * 2. Transform the URLs to http://localhost:$PORT
   * 3. Forward the modified request to the agent
   * 4. When the response comes back with session_id, deliver it to the listeners
   */
  private async handleSessionNew(
    targetIndex: number,
    dispatch: Dispatch & { type: "request" }
  ): Promise<void> {
    const params = dispatch.params as {
      mcpServers?: McpServerSpec[];
      [key: string]: unknown;
    } | undefined;

    const servers = params?.mcpServers;

    // Generate a session key to correlate the request with the response
    const sessionKey = `session-${this.generateRequestId()}`;

    // Transform MCP servers if needed
    const { transformedServers, hasAcpServers } = await this.mcpBridge!.transformMcpServers(
      servers,
      sessionKey
    );

    if (!hasAcpServers) {
      // No acp: servers - forward unchanged
      const target = this.getTargetConnection(targetIndex);
      if (target) {
        this.forwardToConnection(target, dispatch);
      }
      return;
    }

    // Build the modified params with transformed servers
    const modifiedParams = {
      ...params,
      mcpServers: transformedServers,
    };

    // Create a responder that captures the session_id and delivers it to listeners
    const originalResponder = dispatch.responder;
    const wrappedResponder = createResponder(
      (result) => {
        // Extract session_id from the response
        const response = result as { sessionId?: string; [key: string]: unknown };
        if (response?.sessionId) {
          this.mcpBridge!.completeSession(sessionKey, response.sessionId);
        }
        originalResponder.respond(result);
      },
      async (error) => {
        // Cancel the pending session on error
        await this.mcpBridge!.cancelSession(sessionKey);
        originalResponder.respondWithError(error);
      }
    );

    // Forward the modified request
    const target = this.getTargetConnection(targetIndex);
    if (!target) {
      dispatch.responder.respondWithError({
        code: -32603,
        message: `No target connection for index ${targetIndex}`,
      });
      return;
    }

    const modifiedDispatch: Dispatch = {
      type: "request",
      id: dispatch.id,
      method: dispatch.method,
      params: modifiedParams,
      responder: wrappedResponder,
    };

    this.forwardToConnection(target, modifiedDispatch);
  }

  /**
   * Handle an MCP connection received from the HTTP bridge
   *
   * When an agent connects to our HTTP listener, we need to:
   * 1. Send _mcp/connect to the proxy that owns this acp: URL
   * 2. Wait for the connection_id in the response
   */
  private async handleMcpConnectionReceived(
    acpUrl: string,
    connectionId: string
  ): Promise<void> {
    // The connection needs to be routed to the proxy that provides this MCP server
    // For now, we route to the first proxy (or client if no proxies)
    // In a more complete implementation, we'd track which proxy registered which URL

    const mcpConnectParams = {
      connectionId,
      url: acpUrl,
    };

    // Create a responder for the _mcp/connect request
    const responder = createResponder(
      (result) => {
        // Connection established - notify via message queue
        const response = result as {
          connectionId: string;
          serverInfo?: { name: string; version: string };
        };
        this.messageQueue.push({
          type: "mcp-connection-established",
          connectionId: response.connectionId ?? connectionId,
          serverInfo: response.serverInfo ?? { name: "unknown", version: "0.0.0" },
        });
      },
      (error) => {
        console.error("MCP connect failed:", error);
      }
    );

    this.mcpConnectResponders.set(connectionId, responder);

    // Route _mcp/connect request toward the client (right-to-left)
    const dispatch: Dispatch = {
      type: "request",
      id: this.generateRequestId(),
      method: "_mcp/connect",
      params: mcpConnectParams,
      responder,
    };

    // Send to client (or first proxy in the backward direction)
    if (this.proxies.length === 0) {
      // No proxies - send directly to client
      if (this.clientConnection) {
        this.forwardToConnection(this.clientConnection, dispatch);
      }
    } else {
      // With proxies - wrap and send to last proxy (backward direction)
      this.forwardWrappedToProxy(this.proxies.length - 1, dispatch);
    }
  }

  /**
   * Handle an MCP message from a client (through the HTTP bridge)
   *
   * This routes MCP tool calls and other messages through the ACP chain.
   */
  private async handleMcpClientToServer(
    connectionId: string,
    dispatch: Dispatch
  ): Promise<void> {
    // Wrap the MCP message in _mcp/message format
    const mcpMessageParams = {
      connectionId,
      method: dispatch.type === "request" || dispatch.type === "notification"
        ? (dispatch as { method: string }).method
        : undefined,
      params: dispatch.type === "request" || dispatch.type === "notification"
        ? (dispatch as { params?: unknown }).params
        : undefined,
      id: dispatch.type === "request" ? (dispatch as { id: JsonRpcId }).id : undefined,
    };

    if (dispatch.type === "request") {
      // Create _mcp/message request
      const mcpDispatch: Dispatch = {
        type: "request",
        id: this.generateRequestId(),
        method: "_mcp/message",
        params: mcpMessageParams,
        responder: (dispatch as { responder: Responder }).responder,
      };

      // Route toward client (right-to-left direction)
      if (this.proxies.length === 0) {
        if (this.clientConnection) {
          this.forwardToConnection(this.clientConnection, mcpDispatch);
        }
      } else {
        this.forwardWrappedToProxy(this.proxies.length - 1, mcpDispatch);
      }
    } else if (dispatch.type === "notification") {
      // Create _mcp/message notification
      const mcpDispatch: Dispatch = {
        type: "notification",
        method: "_mcp/message",
        params: mcpMessageParams,
      };

      // Route toward client
      if (this.proxies.length === 0) {
        if (this.clientConnection) {
          this.forwardToConnection(this.clientConnection, mcpDispatch);
        }
      } else {
        this.forwardWrappedToProxy(this.proxies.length - 1, mcpDispatch);
      }
    }
  }

  /**
   * Handle an MCP connection being disconnected
   */
  private async handleMcpConnectionDisconnected(connectionId: string): Promise<void> {
    // Clean up the connect responder if still pending
    this.mcpConnectResponders.delete(connectionId);

    // Send _mcp/disconnect notification toward client
    const dispatch: Dispatch = {
      type: "notification",
      method: "_mcp/disconnect",
      params: { connectionId },
    };

    // Route toward client
    if (this.proxies.length === 0) {
      if (this.clientConnection) {
        this.forwardToConnection(this.clientConnection, dispatch);
      }
    } else {
      this.forwardWrappedToProxy(this.proxies.length - 1, dispatch);
    }
  }

  /**
   * Generate a unique request ID for outgoing requests
   */
  private generateRequestId(): number {
    return this.nextRequestId++;
  }
}

// Re-export instantiator helpers for convenience
export { fromCommands, fromConnectors, dynamic, staticInstantiator } from "./instantiators.js";
export type { CommandSpec, CommandOptions, StaticInstantiatorConfig, DynamicInstantiatorFactory } from "./instantiators.js";
