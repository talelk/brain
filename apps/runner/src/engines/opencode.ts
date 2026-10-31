import { AcpEngine } from "./acp";

export class OpenCodeEngine extends AcpEngine {
  constructor() {
    super({ id: "opencode", commandEnv: "BRAIN_OPENCODE_COMMAND", defaultCommand: "opencode acp" });
  }
}
