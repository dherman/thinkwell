import { Agent } from "@dherman/patchwork";

const DEFAULT_AGENT_CMD = "npx -y @zed-industries/claude-code-acp";

export type ConnectorOptions = {
  debug?: boolean;
  command?: string;
};

export default class Connector {
  private _command: string;

  constructor(options?: ConnectorOptions) {
    this._command = options?.command
      ?? process.env.PATCHWORK_AGENT_CMD
      ?? DEFAULT_AGENT_CMD;
  }

  connect(): Promise<Agent> {
    return Agent.connect(this._command);
  }
}
