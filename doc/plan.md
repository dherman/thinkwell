# Implementation Plan: @thinkwell/conductor

This plan tracks the implementation of the TypeScript conductor. See [doc/rfd/conductor.md](rfd/conductor.md) for the full design.

## Phase 1: Foundation

- [ ] Create `@thinkwell/protocol` package with shared types
  - [ ] Extract MCP-over-ACP types from `@thinkwell/acp`
  - [ ] Add JSON-RPC base types
  - [ ] Add `Dispatch` and `Responder` types
- [ ] Create `@thinkwell/conductor` package skeleton
  - [ ] Package.json, tsconfig, basic structure
- [ ] Implement `MessageQueue` with async iteration
- [ ] Implement `StdioConnector` for subprocess spawning
- [ ] Implement `ChannelConnector` for in-memory connections

## Phase 2: Basic Routing

- [ ] Implement basic `Conductor` class
  - [ ] Message loop consuming from queue
  - [ ] Left-to-right forwarding (client → agent)
  - [ ] Right-to-left forwarding (agent → client)
- [ ] Request/response correlation
  - [ ] Pending request map
  - [ ] Responder routing
- [ ] Simple pass-through mode (no proxies, just agent)

## Phase 3: Proxy Support

- [ ] `_proxy/successor/*` message wrapping/unwrapping
- [ ] `_proxy/initialize` vs `initialize` differentiation
- [ ] Multi-proxy chain routing
- [ ] Proxy capability handshake

## Phase 4: Initialization Protocol

- [ ] `ComponentInstantiator` abstraction
- [ ] Lazy instantiation on first `initialize` request
- [ ] Static instantiation (list of commands)
- [ ] Dynamic instantiation (factory function)

## Phase 5: MCP Bridge

- [ ] HTTP listener for `acp:` URLs
- [ ] URL transformation in `session/new`
- [ ] `_mcp/connect`, `_mcp/message`, `_mcp/disconnect` routing
- [ ] Connection lifecycle management

## Phase 6: Integration

- [ ] Update `@thinkwell/acp` to use `@thinkwell/protocol`
- [ ] Add in-process conductor option to `SacpConnection`
- [ ] Integration tests with real agent
- [ ] Comparison tests vs Rust conductor behavior

## Phase 7: Polish

- [ ] Error handling refinement
- [ ] Logging/debugging support
- [ ] Optional NDJSON tracing output
- [ ] Documentation
