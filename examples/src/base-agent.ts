import { connect, Patchwork } from "@dherman/patchwork";

/**
 * Parse a shell-style command string into an array of arguments.
 * Handles single quotes, double quotes, and escaped characters.
 */
function parseCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

// Default conductor command using Claude Code ACP
const DEFAULT_CONDUCTOR_CMD =
  'sacp-conductor agent "npx -y @zed-industries/claude-code-acp"';

export default function baseAgent(): Promise<Patchwork> {
    // Parse conductor command from environment or use default
    const cmdString = process.env.CONDUCTOR_CMD ?? DEFAULT_CONDUCTOR_CMD;
    const conductorCmd = parseCommand(cmdString);    
    return connect(conductorCmd);
}
