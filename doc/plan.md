# Implementation Plan: @thinkwell/conductor

This plan tracks the implementation of the TypeScript conductor. See [doc/rfd/conductor.md](rfd/conductor.md) for the full design.

## Phase 1: Foundation

- [x] Create `@thinkwell/protocol` package with shared types
  - [x] Extract MCP-over-ACP types from `@thinkwell/acp`
  - [x] Add JSON-RPC base types
  - [x] Add `Dispatch` and `Responder` types
- [x] Create `@thinkwell/conductor` package skeleton
  - [x] Package.json, tsconfig, basic structure
- [x] Implement `MessageQueue` with async iteration
- [x] Implement `StdioConnector` for subprocess spawning
- [x] Implement `ChannelConnector` for in-memory connections

## Phase 2: Basic Routing

- [x] Implement basic `Conductor` class
  - [x] Message loop consuming from queue
  - [x] Left-to-right forwarding (client → agent)
  - [x] Right-to-left forwarding (agent → client)
- [x] Request/response correlation
  - [x] Pending request map
  - [x] Responder routing
- [x] Simple pass-through mode (no proxies, just agent)

## Phase 3: Proxy Support

- [x] `_proxy/successor/*` message wrapping/unwrapping
- [x] `_proxy/initialize` vs `initialize` differentiation
- [x] Multi-proxy chain routing
- [x] Proxy capability handshake

## Phase 4: Initialization Protocol

- [x] `ComponentInstantiator` abstraction
- [x] Lazy instantiation on first `initialize` request
- [x] Static instantiation (list of commands)
- [x] Dynamic instantiation (factory function)

## Phase 5: MCP Bridge

- [ ] HTTP listener for `acp:` URLs
- [ ] URL transformation in `session/new`
- [ ] `_mcp/connect`, `_mcp/message`, `_mcp/disconnect` routing
- [ ] Connection lifecycle management

## Phase 6: Integration

- [x] Update `@thinkwell/acp` to use `@thinkwell/protocol`
- [ ] Add in-process conductor option to `SacpConnection`
- [ ] Integration tests with real agent
- [ ] Comparison tests vs Rust conductor behavior

## Phase 7: Polish

- [ ] Error handling refinement
- [ ] Logging/debugging support
- [ ] Optional NDJSON tracing output
- [ ] Documentation
