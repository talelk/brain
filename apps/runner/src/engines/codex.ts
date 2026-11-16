import { AcpEngine } from "./acp";

/**
 * Codex over ACP. The Codex CLI has no ACP mode of its own, so the command is an ACP adapter for it: BRAIN_CODEX_COMMAND, by default
 * `codex-acp`. The gateway and the attempt's token are passed as the OpenAI address and key. No setting that turns Codex's own tools
 * on or off by level is passed, because none has been verified: the level is enforced as for every ACP engine, on the kind Codex
 * reports for each tool call (acp.ts), and by the sandbox the engine runs in.
 */
export class CodexEngine extends AcpEngine {
  constructor() {
    super({ id: "codex", commandEnv: "BRAIN_CODEX_COMMAND", defaultCommand: "codex-acp", env: (spec) => ({ OPENAI_BASE_URL: spec.model.baseUrl, OPENAI_API_KEY: spec.model.token, CODEX_HOME: `${spec.stateDir}/codex`, HOME: spec.stateDir }) });
  }
}
