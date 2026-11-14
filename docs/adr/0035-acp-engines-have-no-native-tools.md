# 35. ACP engines have no native tools

Status: accepted, 2026-11-14. Closes the hole ADR 0021 leaves open for ACP agents.

ADR 0021 says an agent reaches the host only through operator-declared tools. The ACP engine (OpenCode, any `acp` agent) did not keep that: the client answered no permission requests, and OpenCode's default is to allow its own shell, edit and fetch without asking, so an OpenCode session could act on the runner host while the runner reported `ephemeral-container` isolation.

## Decision
1. **No client capabilities.** The adapter declares none (`fs` and `terminal` false). Any request from the agent other than a permission request is answered `-32601`. Requests are told from responses by `method`, never by `id`: the agent's request ids are its own.
2. **Permission requests are refused unless they name a broker tool.** Allowed: `toolCall.name` is exactly the name of a tool in the session's `allowedTools` (matched by id and digest), the agent does not call it a command, edit or fetch, and the agent offers `allow_once`. Then `allow_once` is chosen, never `allow_always`. Anything else gets the agent's `reject_once`, or `cancelled` if it offers none. Title and input decide nothing.
3. **OpenCode starts with its native tools denied** (`OPENCODE_CONFIG_CONTENT`: ask everything, then deny shell, edit, write, patch, read, glob, grep, webfetch, websearch, external_directory, subagent, lsp), with project config and Claude Code compatibility off, so a repository's `opencode.json` cannot allow them again. Without these rules OpenCode never asks, and (2) is never reached.
4. **A native tool that runs ends the session.** A tool call that reaches `in_progress` or `completed` and is not an allowed broker tool stops the agent and fails the session (`POLICY_DENIED`). A call that was only attempted and refused is not a violation.
5. **Isolation is stated per engine.** The runner states `engine-isolation:<engine>:<mode>` for each engine it probed (hello and every heartbeat; an operator cannot configure it). Fixture, Pi and Claude run in the runner process with no native tools: `ephemeral-container`. ACP engines, and any engine not listed, are `trusted-local`: the agent is a separate process of the runner's user that nothing outside it contains. Placement uses an engine only if it states the step's isolation; no statement means no. The runner picks the same way, so a runner with both kinds of engine never runs a step on the one that cannot meet it. Placement still compares isolation by equality; ordering and the policy floor belong to the policy ticket.

## Limits (be honest)
- (3) is unverified against a running OpenCode: nobody has run it with these settings. (2) and (4) go by what the agent says about itself; a lying agent is not stopped. This is why ACP engines are `trusted-local` and a step that requires `ephemeral-container` is never placed on one, until the per-attempt sandbox for engines (spec #90, story 106) exists.
- Brain broker tools do not reach an ACP agent yet: `session/new` sends no MCP servers, so the allow rule has nothing to allow. An MCP bridge is separate work.
- The operator's own OpenCode configuration (providers, plugins, MCP servers) is still loaded: it supplies the model.
