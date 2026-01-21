import { Agent } from "./agent.js";
import type { SchemaProvider } from "@thinkwell/acp";
import { ThinkBuilder } from "./think-builder.js";

/**
 * Main entry point for creating patchwork instances.
 *
 * @deprecated Use Agent instead. This class will be removed in the next major version.
 *
 * Patchwork provides a fluent API for blending deterministic code
 * with LLM-powered reasoning.
 */
export class Patchwork {
  private readonly _agent: Agent;

  /** @internal */
  constructor(agent: Agent) {
    this._agent = agent;
  }

  /**
   * Create a new think builder for constructing a prompt with tools.
   *
   * @param schema - A SchemaProvider that defines the expected output structure
   *
   * @deprecated Use Agent.think() instead.
   */
  think<Output>(schema: SchemaProvider<Output>): ThinkBuilder<Output>;

  /**
   * Create a new think builder without a schema.
   *
   * @deprecated Use `think(schemaOf<T>(schema))` instead to provide a typed schema.
   */
  think<Output>(): ThinkBuilder<Output>;

  think<Output>(schema?: SchemaProvider<Output>): ThinkBuilder<Output> {
    return this._agent.think(schema!);
  }

  /**
   * Close the connection to the conductor
   *
   * @deprecated Use Agent.close() instead.
   */
  close(): void {
    this._agent.close();
  }
}

/**
 * Connect to an agent via the conductor.
 *
 * @deprecated Use Agent.connect() instead. This function will be removed in the next major version.
 *
 * @param conductorCommand - The command to spawn the conductor process
 * @returns A Patchwork instance connected to the conductor
 *
 * @example
 * ```typescript
 * // Old API (deprecated):
 * const patchwork = await connect(["sacp-conductor", "agent", "npx ..."]);
 *
 * // New API:
 * const agent = await Agent.connect("npx ...");
 * ```
 */
export async function connect(conductorCommand: string[]): Promise<Patchwork> {
  // Extract the agent command from the conductor command
  // Old format: ["sacp-conductor", "agent", "npx -y @zed-industries/claude-code-acp"]
  // New format: just the agent command string
  const agentIndex = conductorCommand.indexOf("agent");
  let agentCommand: string;

  if (agentIndex !== -1 && conductorCommand.length > agentIndex + 1) {
    agentCommand = conductorCommand[agentIndex + 1];
  } else if (conductorCommand.length > 0) {
    // Fallback: join remaining args as the command
    agentCommand = conductorCommand.slice(1).join(" ");
  } else {
    throw new Error("Invalid conductor command format");
  }

  const agent = await Agent.connect(agentCommand);
  return new Patchwork(agent);
}
