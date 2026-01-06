# MCP Bridge Forwarding Issue

## Status: RESOLVED ✅

**Fixed on 2026-01-05.** MCP tools now work correctly with Claude Code through the conductor's HTTP bridge.

## Root Cause

The issue was in our `_mcp/message` response format. We were wrapping responses incorrectly.

### What We Were Doing (Wrong)

```json
{"connectionId": "...", "result": {"protocolVersion": "...", "serverInfo": {...}, ...}}
```

### What The Conductor Expects (Correct)

```json
{"protocolVersion": "...", "serverInfo": {...}, "capabilities": {...}, ...}
```

The `_mcp/message` ACP extension wraps requests with `connectionId` (via `#[serde(flatten)]` in Rust), but the **response** should be the raw MCP result without any wrapper.

When we returned the wrapped format, the conductor forwarded it to Claude Code, which received a malformed MCP response. Since it didn't match the expected `InitializeResult` schema, Claude Code's MCP client stopped the handshake—no `notifications/initialized`, no `tools/list`.

## The Fix

Three changes were made:

### 1. Return Raw MCP Results (Critical Fix)

In `packages/sacp/src/mcp-over-acp-handler.ts`, `handleMessage()` now returns the raw MCP response directly instead of wrapping it:

```typescript
// Before (wrong)
return { connectionId, result };

// After (correct)
return await connection.server.handleMethod(method, mcpParams, context);
```

### 2. Update Protocol Version

In `packages/sacp/src/mcp-server.ts`, updated from `2024-11-05` to `2025-03-26` to match rmcp (the Rust MCP library used by patchwork-rs).

### 3. Always Include Instructions

The `initialize` response now always includes `instructions` to help the agent understand available tools:

```typescript
const instructions = this._instructions ?? "You have access to tools. Call return_result when done.";
```

## Verification

After the fix, the MCP handshake completes correctly:

| Time | Event |
|------|-------|
| +621ms | `_mcp/connect` response |
| +1911ms | `initialize` response (raw, not wrapped) |
| +2151ms | **`tools/list` request arrives** ✅ |
| +4658ms | `session/prompt` sent |
| +8883ms | **`tools/call` with `return_result`** ✅ |
| +8886ms | Tool call succeeds |

## Investigation Journey

### Initial Hypothesis (Incorrect)

We initially suspected Claude Code had a bug because it wasn't calling `tools/list`. The JSON extraction fallback was working, so we assumed the issue was on Claude Code's side.

### Key Insight

Running patchwork-rs (the Rust implementation) with tracing (`RUST_LOG=sacp=trace`) showed that Claude Code **does** call `tools/list`—within ~200ms of the `initialize` response. This proved the issue was in our TypeScript implementation, not Claude Code.

### Discovery Process

1. Compared Rust patchwork trace logs with our TypeScript logs
2. Found Claude Code sends `tools/list` in Rust stack but not in ours
3. Examined the `_mcp/message` response format in both implementations
4. Discovered Rust uses `#[serde(flatten)]` for requests but raw responses
5. Our wrapper `{connectionId, result}` was causing the handshake to fail

## Previous Issues (Also Fixed)

### Issue 1: Field Name Mismatch

The `_mcp/connect` response required `connection_id` (snake_case) but we were returning `connectionId` (camelCase). Fixed by returning both for compatibility.

### Issue 2: Notification Handling

Added handling for `notifications/initialized` notification which Claude Code sends after `initialize`. While not strictly required (notifications don't need responses), handling it cleanly removes spurious error messages.

## Files Changed

- `packages/sacp/src/mcp-over-acp-handler.ts` - Return raw MCP results
- `packages/sacp/src/mcp-server.ts` - Update protocol version, add instructions
- `packages/sacp/src/mcp-over-acp-handler.test.ts` - Update test expectations
