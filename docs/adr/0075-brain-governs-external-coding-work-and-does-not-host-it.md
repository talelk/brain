# 75. Brain governs external coding work and does not host it

Status: accepted, 2026-11-16.

Earlier documents promised Brain-managed git state: a mission branch only a merge controller writes, a branch per work item and per interactive session, a worktree per writer, checkpoint and restore of a working tree, and a review-to-merge path. None of it was built, and agent coding UX is a crowded segment that coding tools already serve well. Brain's differentiator is the path from intent to a verified outcome, under governance. The decision is to spend effort there.

## Decision
1. **Brain does not host coding.** Agents keep reaching the host only through operator-declared tools (ADR 0021, unchanged): no writable output directory, no worktrees.
2. **External coding tools and CI are governed and verified, not driven.** Their work and CI results enter Brain as subjects (an external record a mission is about) and as evidence from governed read tools. They are never code Brain edits.
3. **Ruled out:** mission, work-item and session branches as Brain-managed git state; per-session worktrees; git checkpoint and restore of a working tree (a checkpoint stays a saved conversation, ADR 0068); a Brain-side review-to-merge path and merge controller; a browser-testing tool for agents; inline code-review comments.
4. **Stays in scope:** pull requests opened through the approved `git.open-pr` effect, pull request records and their observed state (ADR 0044, #121), and CI and ticket events arriving as subject updates through webhooks (#138).

## Consequences
- GLOSSARY drops Mission branch, Work-item branch and Session branch, and the mission evidence bundle no longer lists branch heads.
- The worktree and merge-controller prose in `docs/implementation` is reworded to the governed pull request path. Amended by #161: the `merge` step kind and `merge` job class, and the `worktreeId` on sessions, engine specs, checkpoints, delegations and launcher create requests, were removed with no replacement; a release that uses `merge` no longer compiles.
- "Affected branch" in GLOSSARY means plan tasks, not git, and stays.
