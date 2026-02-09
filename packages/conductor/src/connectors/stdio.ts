/**
 * StdioConnector - spawns a subprocess and communicates via stdin/stdout
 *
 * This connector starts a child process and establishes a bidirectional
 * JSON-RPC connection using newline-delimited JSON over stdio.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { JsonRpcMessage } from "@thinkwell/protocol";
import type { ComponentConnection, ComponentConnector } from "../types.js";

/**
 * Options for StdioConnector
 */
export interface StdioConnectorOptions {
  /** The command to execute (e.g., "claude-agent" or "/path/to/agent") */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables to set (merged with current env) */
  env?: Record<string, string>;
  /** Working directory for the subprocess */
  cwd?: string;
}

/**
 * A connection to a subprocess via stdin/stdout
 */
class StdioConnection implements ComponentConnection {
  private readonly process: ChildProcess;
  private readonly readline: ReadlineInterface;
  private closed = false;
  private closingGracefully = false;

  constructor(process: ChildProcess) {
    this.process = process;

    if (!process.stdout || !process.stdin) {
      throw new Error("Process must have stdio pipes");
    }

    // Set up readline for reading newline-delimited JSON
    this.readline = createInterface({
      input: process.stdout,
      crlfDelay: Infinity,
    });

    // Handle process exit
    process.on("exit", (code, signal) => {
      this.closed = true;
      // Don't log exit codes during graceful shutdown - we expect non-zero codes
      // when we send SIGTERM/SIGKILL to processes that don't handle stdin EOF.
      // This is a workaround for kiro-cli acp (v1.25.0) which doesn't exit on stdin close.
      if (code !== 0 && code !== null && !this.closingGracefully) {
        console.error(`Process exited with code ${code}`);
      }
      // Only log signal if it wasn't an expected graceful shutdown
      if (signal && !this.closingGracefully) {
        console.error(`Process killed by signal ${signal}`);
      }
    });

    process.on("error", (error) => {
      console.error("Process error:", error);
      this.closed = true;
    });
  }

  /**
   * Send a JSON-RPC message to the subprocess
   */
  send(message: JsonRpcMessage): void {
    if (this.closed || !this.process.stdin) {
      throw new Error("Connection is closed");
    }

    const json = JSON.stringify(message);
    this.process.stdin.write(json + "\n");
  }

  /**
   * Async iterable of messages received from the subprocess
   */
  get messages(): AsyncIterable<JsonRpcMessage> {
    const readline = this.readline;
    const isClosed = () => this.closed;

    return {
      async *[Symbol.asyncIterator]() {
        for await (const line of readline) {
          if (isClosed()) {
            return;
          }

          if (!line.trim()) {
            continue;
          }

          try {
            const message = JSON.parse(line) as JsonRpcMessage;
            yield message;
          } catch (error) {
            console.error("Failed to parse JSON-RPC message:", error);
            console.error("Line:", line);
          }
        }
      },
    };
  }

  /**
   * Close the connection and terminate the subprocess
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.closingGracefully = true;
    
    // Close the readline interface
    this.readline.close();
    
    // Close the stdout stream to release the pipe handle
    this.process.stdout?.destroy();

    // Close stdin to signal EOF to the subprocess
    this.process.stdin?.end();

    // Wait for the process to exit gracefully, with fallback to signals
    // Note: Some processes don't properly handle stdin EOF and need explicit signals.
    // For example, kiro-cli acp (as of v1.25.0) doesn't exit on stdin close.
    await new Promise<void>((resolve) => {
      let sigtermTimeout: NodeJS.Timeout | null = null;
      let sigkillTimeout: NodeJS.Timeout | null = null;
      
      const onExit = () => {
        if (sigtermTimeout) clearTimeout(sigtermTimeout);
        if (sigkillTimeout) clearTimeout(sigkillTimeout);
        resolve();
      };
      
      this.process.once("exit", onExit);

      // Wait 250ms for graceful exit, then send SIGTERM
      sigtermTimeout = setTimeout(() => {
        this.process.kill("SIGTERM");

        // Wait another 500ms, then force kill with SIGKILL
        sigkillTimeout = setTimeout(() => {
          this.process.kill("SIGKILL");
          resolve();
        }, 500);
      }, 250);
    });
  }
}

/**
 * Connector that spawns a subprocess and communicates via stdio
 */
export class StdioConnector implements ComponentConnector {
  private readonly options: StdioConnectorOptions;

  constructor(options: StdioConnectorOptions | string) {
    if (typeof options === "string") {
      // Parse command string (split on whitespace, respecting quotes)
      const parts = parseCommand(options);
      this.options = {
        command: parts[0],
        args: parts.slice(1),
      };
    } else {
      this.options = options;
    }
  }

  /**
   * Spawn the subprocess and return a connection to it
   */
  async connect(): Promise<ComponentConnection> {
    const { command, args = [], env, cwd } = this.options;

    const process = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"], // stdin, stdout piped; stderr inherited
      env: env ? { ...globalThis.process.env, ...env } : undefined,
      cwd,
    });

    // Wait for the process to spawn successfully
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        process.removeListener("spawn", onSpawn);
        process.removeListener("error", onError);
      };

      process.once("spawn", onSpawn);
      process.once("error", onError);
    });

    return new StdioConnection(process);
  }
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

/**
 * Create a StdioConnector from a command string or options
 */
export function stdio(options: StdioConnectorOptions | string): StdioConnector {
  return new StdioConnector(options);
}
