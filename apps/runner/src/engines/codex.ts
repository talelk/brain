import type { EngineToolBinding } from "@brain/contracts";
import { AcpEngine } from "./acp";

/**
 * Codex over ACP. The command is BRAIN_CODEX_COMMAND, by default `codex acp`; both are the ticket's assumption, not something this repository
 * documents or has run.
 *
 * Unlike OpenCode, no setting that turns Codex's own tools off is passed to the agent: nothing in this repository or its dependencies
 * documents Codex's configuration format, and a guessed one would be a claim about behaviour nobody verified. The enforcement is the one every
 * ACP engine has (ADR 0035): the client declares no capabilities, refuses every permission request that is not a broker tool of the job, and
 * stops the agent and fails the session when it runs a native tool. A Codex that runs its own tools without ever asking is only caught by
 * what it reports about itself. This is why the engine is `trusted-local` unless it runs in an engine sandbox (ADR 0073), where the container contains it, and why qualifying the real Codex needs the owner's explicit
 * permission and has not been done.
 */
export class CodexEngine extends AcpEngine {
  constructor(toolBindings: readonly EngineToolBinding[] = []) {
    super({ id: "codex", commandEnv: "BRAIN_CODEX_COMMAND", defaultCommand: "codex acp", toolBindings });
  }
}
