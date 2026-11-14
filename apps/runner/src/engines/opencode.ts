import type { EngineToolBinding } from "@brain/contracts";
import { AcpEngine } from "./acp";

/** OpenCode's own tools. Each is denied outright, so the model is not offered it and a call to it is refused. */
const NATIVE_TOOLS = ["shell", "edit", "write", "patch", "read", "glob", "grep", "webfetch", "websearch", "external_directory", "subagent", "lsp"] as const;

/**
 * The settings OpenCode starts with (ADR 0035). Rules are ordered, later ones overriding earlier ones: everything is asked first (so the
 * adapter decides, and refuses all but a broker tool), then every native tool is denied. The OpenCode default is to allow everything
 * without asking, so without these rules the adapter would never hear of a shell command or an edit.
 */
function openCodeEnv(): Record<string, string> {
  const rules = [
    { action: "*", resource: "*", effect: "ask" },
    ...NATIVE_TOOLS.map((action) => ({ action, resource: "*", effect: "deny" })),
  ];
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: "https://opencode.ai/config.json", permissions: rules }),
    // A folder's own opencode.json (the runner may start inside a repository that has one) and Claude Code's settings must not re-allow anything.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}

export class OpenCodeEngine extends AcpEngine {
  constructor(toolBindings: readonly EngineToolBinding[] = []) {
    super({ id: "opencode", commandEnv: "BRAIN_OPENCODE_COMMAND", defaultCommand: "opencode acp", toolBindings, env: openCodeEnv() });
  }
}
