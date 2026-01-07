import {
  connect as sacpConnect,
  SacpConnection,
  SessionBuilder,
  type SchemaProvider,
} from "@dherman/sacp";
import { ThinkBuilder } from "./think-builder.js";

/**
 * Main entry point for creating patchwork instances.
 *
 * Patchwork provides a fluent API for blending deterministic code
 * with LLM-powered reasoning.
 */
export class Patchwork {
  private readonly _connection: SacpConnection;

  constructor(connection: SacpConnection) {
    this._connection = connection;
  }

  /**
   * Create a new think builder for constructing a prompt with tools.
   *
   * @param schema - A SchemaProvider that defines the expected output structure
   *
   * @example
   * ```typescript
   * import { schemaOf } from "@dherman/patchwork";
   *
   * interface Summary {
   *   title: string;
   *   points: string[];
   * }
   *
   * const result = await patchwork
   *   .think(schemaOf<Summary>({
   *     type: "object",
   *     properties: {
   *       title: { type: "string" },
   *       points: { type: "array", items: { type: "string" } }
   *     },
   *     required: ["title", "points"]
   *   }))
   *   .text("Summarize this document:")
   *   .display(documentContents)
   *   .run();
   * ```
   */
  think<Output>(schema: SchemaProvider<Output>): ThinkBuilder<Output>;

  /**
   * Create a new think builder without a schema.
   *
   * @deprecated Use `think(schemaOf<T>(schema))` instead to provide a typed schema.
   */
  think<Output>(): ThinkBuilder<Output>;

  think<Output>(schema?: SchemaProvider<Output>): ThinkBuilder<Output> {
    return new ThinkBuilder<Output>(this._connection, this._connection.mcpHandler, schema);
  }

  /**
   * Create a session builder for more control over session configuration
   */
  session(): SessionBuilder {
    return new SessionBuilder(this._connection, this._connection.mcpHandler);
  }

  /**
   * Close the connection to the conductor
   */
  close(): void {
    this._connection.close();
  }
}

/**
 * Connect to an agent via the conductor.
 *
 * @param conductorCommand - The command to spawn the conductor process
 * @returns A Patchwork instance connected to the conductor
 *
 * @example
 * ```typescript
 * const patchwork = await connect(["sacp-conductor", "--agent", "claude"]);
 * ```
 */
export async function connect(conductorCommand: string[]): Promise<Patchwork> {
  const connection = await sacpConnect(conductorCommand);
  return new Patchwork(connection);
}
