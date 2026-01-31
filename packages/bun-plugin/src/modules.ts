/**
 * Maps thinkwell:* URI scheme to npm package names.
 *
 * These mappings allow users to write `import { Agent } from "thinkwell:agent"`
 * instead of `import { Agent } from "@thinkwell/thinkwell"`.
 *
 * In the future CLI, these will resolve to bundled modules. For now,
 * they resolve to the npm packages which must be installed.
 */
export const THINKWELL_MODULES: Record<string, string> = {
  agent: "@thinkwell/thinkwell",
  acp: "@thinkwell/acp",
  protocol: "@thinkwell/protocol",
  connectors: "@thinkwell/thinkwell/connectors",
};
