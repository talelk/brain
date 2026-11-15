# 48. An approval binds where it was asked, and reads the rest beside it

Status: accepted, 2026-11-15. Builds on ADR 0024 (a permit per call) and ADR 0044.

An approval showed the effect as raw JSON and digests, with no mission, work item or run, no rendered change and no rollback. A person deciding from a phone could not tell which task the change belonged to or what it would write. Adding that must not weaken ADR 0024: an approval stays bound to its digest, target and precondition and is spent once.

## Decision
1. **The origin is bound.** `ActionSubject` gains an optional `origin` (`runId`, and `workItemId` and `missionId` when the run serves a task). The Governor sets it when it records the approval: from the run of the proposing task for an effect call, and from the run the gate waits in for a workflow gate (it overrides whatever the proposal said). It is part of the subject, so the digest covers it; a subject without one hashes exactly as before and `approvalSubjectDigest` is unchanged. The ids never change for a given call, so binding them adds nothing the approver could not see, and an approval for one task's change cannot be shown as another's.
2. **A caller cannot claim an origin.** `approval.request` refuses a subject whose origin the Governor's own records do not support (unknown run, or a task or mission the run's execution link does not name).
3. **Everything that can change is read, not bound.** `approvals.list` and `approval.get` return a `context` beside the subject: the mission and work item titles (looked up now), the change, and the rollback. The digest covers the subject only, so reading or rendering context can never move it, and a renamed mission cannot invalidate a pending approval.
4. **A file change is a diff.** A tool whose arguments are files to commit (`git.open-pr`) is rendered from the subject's own arguments (already bound by `inputDigest`) as a unified diff. Brain does not read the repository before the decision, so each file is shown as its whole new content (every line added) and a file already at that path is replaced; the page says so. A later change could read the base file and show a true diff.
5. **A rollback is declared by the Tool document.** `spec.compensatingAction` is a plain sentence. It is part of the Tool document, so the tool digest in the subject pins it. The approval shows "Rollback: ..." with the note that Brain does not run it, or "No rollback declared". Declaring one grants nothing and runs nothing.
6. **Permits are unchanged.** One approval, one permit, consumed by `effects/start`; the permit check compares the stored subject's digest, tool, arguments and held job exactly as before.

## Limits
- A gate whose subject is not a JSON object cannot carry an origin; it shows none.
- Titles are shown as they are when read, not as they were when asked.
