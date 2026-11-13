# 21. Agents reach the host only through operator-declared tools

Status: accepted, 2026-11-12.

An agent that looks after a server needs to read its files and run commands on it. A sandboxed tool has no network, a read-only root and only operator-declared mounts (`docs/howto/add-governed-tool.md`). We keep that and add narrow operator-owned openings, not a general one.

## Decision
1. **Read the host filesystem: `host.read`, a read tool.** The operator declares a mount on the launcher (`BRAIN_LAUNCHER_DATA_MOUNTS=srv=/srv`, always read-only) and says which tool receives it on the runner (`BRAIN_TOOL_DATA_MOUNTS=host.read=srv`). The mount is per tool, so no other tool sees `/srv`. The pinned script adds what a mount alone cannot: no path outside the mount (symlinks resolved), no secret-bearing files (`.env*`, keys, `.git`), no databases or archives, no `backups` folders, text only, bounded output, and secret-looking `key=value` lines redacted.
2. **Run commands on the host: `host.exec`, a read tool for named diagnostics.** The operator owns a file of named commands on the launcher host (`BRAIN_LAUNCHER_HOST_COMMANDS`, `scripts/demo/host-commands.json`). Each entry fixes the argv and declares an `effect` (`read` or `privileged`) and, for each argument, an anchored pattern; a value may not start with `-`. The agent supplies a command name and named arguments only. The runner asks the launcher over its authenticated socket; the launcher runs the argv without a shell, with a time limit, bounded output and a minimal environment. A command declared `privileged` is refused to a read caller and a read command to a privileged caller. The sandbox stays `network: none`; the container runtime socket is never mounted into it.
3. **Changing the host (restart, reload) is not part of this decision.** It is done by privileged-effect tools that need an approval and a permit per call: ADR 0024. A writable output directory is not built.

## Why
- The release can only narrow what the operator declared: a Tool document cannot add a mount or a command, and a workflow cannot name a host path.
- Secrets never reach the model: the file rules, the redaction, and the fact that the allowlist contains no command that prints environment or secret files.

## Limits (be honest)
- Redaction is pattern based; a secret printed in an unusual shape can pass. Keep secret files out of `/srv` or out of reach (they are denied by name).
- Tools are organization-wide: any workflow whose agent lists `host.read` or `host.exec` can use them on a runner that has the mount. Only the `sre-operator` agent lists them, and `sre-task` is a hidden (system) workflow. Host tools now run only on a dedicated runner group bound to the workspace (ADR 0024).
- `/srv` is a read-only view of production demos, so what an agent reads there leaves the host in model prompts, including through the external evaluator proxy. The `sre-demos` workspace documents say so.
