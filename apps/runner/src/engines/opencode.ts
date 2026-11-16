import type { NativeLevel } from "@brain/contracts";
import { AcpEngine } from "./acp";
import type { EngineSessionSpec } from "./port";

/** OpenCode's own tools by what they do. One the level does not include is denied outright, so the model is not offered it. */
const READ_TOOLS = ["read", "glob", "grep", "list"] as const;
const WRITE_TOOLS = ["edit", "write", "patch", "shell"] as const;
const NEVER = ["webfetch", "websearch", "external_directory", "subagent", "lsp", "question"] as const;

function allowed(native: NativeLevel): readonly string[] {
  return native === "all" ? [...READ_TOOLS, ...WRITE_TOOLS] : native === "read" ? READ_TOOLS : [];
}

/**
 * The settings OpenCode starts a session with. The model is the Governor's gateway, as an OpenAI-compatible provider with the attempt's
 * token. Permission rules are ordered, later ones overriding earlier ones: everything is asked first (so the adapter decides), then each
 * of OpenCode's own tools is allowed or denied by the agent's native level. OpenCode's default is to allow everything without asking.
 *
 * Seen with OpenCode 2.2.5 and a scripted gateway: the model is offered edit, glob, grep, read, shell and write at `all`; glob, grep and
 * read at `read`; none of them at `none`. At every level it is also offered `skill` (no rule removes it; an empty home holds no skill)
 * and `execute`, OpenCode's Code Mode: JavaScript that calls MCP tools, which is the only way OpenCode's model reaches workspace tools
 * (`tools.brain.<tool>(input)`), and that can also `fetch`. That is why OpenCode runs only in an engine sandbox (select.ts): the egress
 * proxy is what bounds `fetch`.
 */
function openCodeEnv(spec: EngineSessionSpec): Record<string, string> {
  const on = new Set(allowed(spec.native));
  const rules = [
    { action: "*", resource: "*", effect: "ask" },
    ...[...READ_TOOLS, ...WRITE_TOOLS, ...NEVER].map((action) => ({ action, resource: "*", effect: on.has(action) ? "allow" : "deny" })),
  ];
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: { brain: { npm: "@ai-sdk/openai-compatible", name: "Brain model gateway", options: { baseURL: spec.model.baseUrl, apiKey: spec.model.token }, models: { [spec.model.name]: { name: spec.model.name, tool_call: true } } } },
    model: `brain/${spec.model.name}`,
    permissions: rules,
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    // A folder's own opencode.json (a working copy may hold one) and Claude Code's settings must not re-allow anything.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    // Its own home: the operator's OpenCode settings, accounts and skills are not this attempt's.
    HOME: spec.stateDir,
  };
}

export class OpenCodeEngine extends AcpEngine {
  constructor() { super({ id: "opencode", commandEnv: "BRAIN_OPENCODE_COMMAND", defaultCommand: "opencode acp", env: openCodeEnv, carriers: ["execute"] }); }
}
