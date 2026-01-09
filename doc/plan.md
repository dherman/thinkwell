# Implementation Plan: Agent-Centric API

RFD: [doc/rfd/agent-api.md](rfd/agent-api.md)

## Tasks

- [x] Add `Agent` class with `connect()` static method
- [x] Implement conductor auto-discovery (PATH lookup, env var)
- [x] Move `think()` method from `Patchwork` to `Agent`
- [x] Add `Session` class with `think()` method for multi-turn
- [x] Implement `agent.createSession()` returning `Session`
- [x] Update `ThinkBuilder` to work with both `Agent` and `Session`
- [x] Deprecate `Patchwork` class and `connect()` function
- [x] Update examples to use new API
- [x] Update package exports
