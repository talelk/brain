# 36. A skill is text an agent pins and a task loads

Status: accepted, 2026-11-15. Spec #90, stories 83 and 84.

Engines turn native skills off on purpose (Pi `noSkills`, Claude `settingSources` empty): a native skill can carry `allowed-tools` and so widen what an agent may do. Brain still wants reusable instructions, so a **Skill** is a release document the Governor and runner use as plain text.

## Decision
1. **A Skill is a release document** (`kind: Skill`): `description`, `triggers` (words, 1 to 16) and `text`, pinned by the digest of its bytes like every document. Nothing else is allowed in `spec`.
2. **An agent pins the skills it may load** in `spec.skills` (id and digest, at most 8). A skill missing from the release, or at another digest, fails compilation.
3. **Compilation scans each skill**: text over 16 KiB, an agent's skills over 48 KiB together, a secret (the knowledge store's detector), a widening key in `spec` or in Markdown front matter (`tools`, `allowed-tools`, `permissions`, `effectClass` and the like), and text that tells the agent to bypass an approval, allowlist, permission or sandbox, or to use tools it was not given. The prose check is a heuristic and fails closed (a skill that says "never skip approval" passes; one that says "skip approval" does not). It is the second line: the first is that no tool is ever read from a skill.
4. **A skill loads on demand, chosen by the Governor.** At the first offer of an agent job, each pinned skill whose trigger appears (case-insensitive substring) in the task text is copied with its digest into the job payload, and so into the digest-pinned execution artifact; a repeat claim sees the same bytes. A task naming no trigger loads nothing. The runner checks each loaded skill against the agent's pinned list, appends it to the instructions under `## Skill: <id>` and reports the ids, digests and the digest of the instructions it really sent (`progress`, phase `skills-loaded`).
5. **The prompt budget counts them.** The loaded text is taken from the context pack's budget before the pack is sized, so skills never squeeze the reply.

## Limits
- There is no `load_skill` tool: it would be a tool. The model cannot ask for a skill mid-session; the task text decides. A skill whose trigger the task never names is never seen.
- Trigger matching is substring, not semantic.
- Skill text sits in a YAML document, so the restricted YAML rule against explicit tags applies to it: text containing ` !word` is refused at parse.
- Authoring is by Git or the CLI; there is no Skill screen in the Studio.
