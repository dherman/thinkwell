/**
 * Maps thinkwell:* URI scheme to npm package names.
 *
 * These mappings allow users to write `import { Agent } from "thinkwell:agent"`
 * instead of `import { Agent } from "thinkwell"`.
 *
 * Note: Both "agent" and "connectors" map to the main "thinkwell" package,
 * which re-exports connectors. This works around Bun's NODE_PATH not
 * supporting subpath exports like "thinkwell/connectors".
 */
export const THINKWELL_MODULES: Record<string, string> = {
  agent: "thinkwell",
  acp: "@thinkwell/acp",
  protocol: "@thinkwell/protocol",
  connectors: "thinkwell",
};
