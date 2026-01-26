/**
 * Component instantiator helpers
 *
 * These functions create ComponentInstantiator objects that determine how
 * components are created when the conductor receives an initialize request.
 *
 * ## Instantiation Modes
 *
 * - **Static**: Components are determined at construction time (e.g., from a list of commands)
 * - **Dynamic**: Components are determined at runtime based on the initialize request
 *
 * ## Lazy Instantiation
 *
 * All instantiators are lazy - components are only spawned when the first
 * `initialize` request arrives. This allows the conductor to be constructed
 * before the component processes need to exist.
 */

import type { ComponentConnector, ComponentInstantiator, InitializeRequest, InstantiatedComponents } from "./types.js";
import type { StdioConnectorOptions } from "./connectors/stdio.js";

/**
 * Options for a component command
 */
export interface CommandOptions extends StdioConnectorOptions {
  // Currently the same as StdioConnectorOptions, but can be extended
}

/**
 * A command specification - either a string or full options
 */
export type CommandSpec = string | CommandOptions;

/**
 * Static configuration for component instantiation
 */
export interface StaticInstantiatorConfig {
  /** Proxy commands to spawn (in order) */
  proxies?: CommandSpec[];
  /** Agent command to spawn (required) */
  agent: CommandSpec;
}

/**
 * Create a component instantiator from static command specifications.
 *
 * This is the most common way to create an instantiator - provide the
 * commands for each component and they will be spawned when needed.
 *
 * @example
 * ```ts
 * // Simple string commands
 * const instantiator = staticInstantiator({
 *   proxies: ['sparkle-acp'],
 *   agent: 'claude-agent',
 * });
 *
 * // With options
 * const instantiator = staticInstantiator({
 *   agent: {
 *     command: 'my-agent',
 *     args: ['--mode', 'production'],
 *     env: { DEBUG: 'true' },
 *   },
 * });
 * ```
 */
export function staticInstantiator(config: StaticInstantiatorConfig): ComponentInstantiator {
  return {
    async instantiate(): Promise<InstantiatedComponents> {
      // Dynamic import to avoid circular dependency
      const { StdioConnector } = await import("./connectors/stdio.js");

      const proxyConnectors: ComponentConnector[] = (config.proxies ?? []).map(
        (spec) => new StdioConnector(normalizeCommandSpec(spec))
      );

      const agentConnector = new StdioConnector(normalizeCommandSpec(config.agent));

      return {
        proxies: proxyConnectors,
        agent: agentConnector,
      };
    },
  };
}

/**
 * Create a component instantiator from a simple list of commands.
 *
 * The last command is treated as the agent, all others as proxies.
 * This is a convenience wrapper around `staticInstantiator`.
 *
 * @example
 * ```ts
 * // Single agent (no proxies)
 * const instantiator = fromCommands(['claude-agent']);
 *
 * // Agent with proxies
 * const instantiator = fromCommands(['sparkle-acp', 'claude-agent']);
 * ```
 */
export function fromCommands(commands: CommandSpec[]): ComponentInstantiator {
  if (commands.length === 0) {
    throw new Error("At least one command (the agent) is required");
  }

  return staticInstantiator({
    proxies: commands.slice(0, -1),
    agent: commands[commands.length - 1],
  });
}

/**
 * Create a component instantiator from explicit connectors.
 *
 * This is useful when you have pre-configured connectors or want to use
 * in-memory connections for testing.
 *
 * @example
 * ```ts
 * const instantiator = fromConnectors(agentConnector, [proxyConnector]);
 * ```
 */
export function fromConnectors(
  agent: ComponentConnector,
  proxies: ComponentConnector[] = []
): ComponentInstantiator {
  return {
    async instantiate(): Promise<InstantiatedComponents> {
      return { proxies, agent };
    },
  };
}

/**
 * Factory function type for dynamic instantiation.
 *
 * The factory receives the initialize request and returns the components
 * to instantiate. This allows for runtime decisions about what to spawn.
 */
export type DynamicInstantiatorFactory = (
  initRequest: InitializeRequest
) => Promise<InstantiatedComponents>;

/**
 * Create a component instantiator with a dynamic factory function.
 *
 * The factory function is called when the first `initialize` request arrives,
 * allowing you to make decisions about what components to spawn based on
 * the request content.
 *
 * @example
 * ```ts
 * const instantiator = dynamic(async (initRequest) => {
 *   // Choose agent based on client capabilities
 *   const capabilities = initRequest.params?.capabilities ?? {};
 *   const agentCommand = capabilities.advanced ? 'advanced-agent' : 'basic-agent';
 *
 *   const { StdioConnector } = await import('./connectors/stdio.js');
 *   return {
 *     proxies: [],
 *     agent: new StdioConnector(agentCommand),
 *   };
 * });
 *
 * // Or use it to inspect MCP servers
 * const instantiator = dynamic(async (initRequest) => {
 *   const mcpServers = initRequest.params?.mcpServers ?? [];
 *   console.log('Client provided MCP servers:', mcpServers);
 *
 *   // ... create appropriate components
 * });
 * ```
 */
export function dynamic(factory: DynamicInstantiatorFactory): ComponentInstantiator {
  return {
    instantiate: factory,
  };
}

/**
 * Normalize a command specification to full options
 */
function normalizeCommandSpec(spec: CommandSpec): StdioConnectorOptions {
  if (typeof spec === "string") {
    // Parse command string into command and args
    const parts = parseCommand(spec);
    return {
      command: parts[0],
      args: parts.slice(1),
    };
  }
  return spec;
}

/**
 * Parse a command string into command and arguments.
 * Handles quoted strings.
 */
function parseCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
