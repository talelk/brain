# 64. A task may run as best-of-N candidates, and a person keeps one

Status: accepted, 2026-11-15. Spec #90, stories 71 and 72. Builds on ADR 0022 (Done needs observed evidence), ADR 0043 (parallel steps; the limits stay at the claim), ADR 0012 (a second look at a result) and ADR 0057 (the plan names structure).

Nothing fanned one task out to several agents. A person who wanted to compare two members, or two ways of working, on the same task had to plan two tasks and could not tell which one was "the" result.

## Decision
1. **Candidates are plan structure.** A plan task may carry `candidates`: two to four entries `{ id, memberId?, workflowId? }`, each naming a team member, a way of working, or both; no two alike. The plan editor, a coordinator (within the autonomy policy) and a standing team copy set them like any other plan field, and started work cannot change them (they are part of the task's content in a plan diff). A task with candidates cannot be a subtask or have subtasks. A candidate's member must be on the team and have the task's tools; its way of working must be in the active release and carry them.
2. **One start, N attempts, through the normal paths.** `workflow.dispatch` for a work item with candidates starts one run per candidate (execution key per candidate, so a replay starts none twice), each linked to the item with its candidate id and the round of the fan-out. Runs, jobs, placement and claim are unchanged; a candidate's run acts as its own member (sessions, tools and usage attribution follow the link, not the task's assignment) and runs its own way of working. Auto-start and a person's Start use the same path. A candidate that cannot start withdraws the others.
3. **Budget counts all before any starts.** Admission checks money, tokens, time and the workspace caps for every candidate together (each counts the larger of the mission's attempt reserve and the task's own cost ceiling) and refuses the whole fan-out, saying how much was needed, when they do not fit. The member cap stays at the claim (ADR 0043): candidates beyond it show `waiting: member cap`. The task's token allowance is per candidate unless a person set one for the task.
4. **Each candidate is judged on its own.** Its run has its own evaluator step, evidence bundle and verdict. When it succeeds and has observed what the task needs (ADR 0022, for its own run only) it records its own version of the task's output; a candidate that observed nothing is a failed candidate.
5. **The task waits for all candidates, and tolerates failures.** It stays in progress until every candidate of the round has ended, then moves to review if at least one produced a result. A failed candidate does not fail the task. Only when no candidate produced a result is it a failed attempt of the task, with the remedies of any failed attempt (a retry is a new round of all candidates).
6. **A person keeps one.** `workItem.candidate.keep` (human only, never a session) names a succeeded candidate of the latest round for a task in review; a person may change their mind until Done. Nothing is kept by itself, and the auto-start completion never completes a task with candidates. When exactly one succeeded candidate has a verified verdict and the mission's autonomy is not supervised, it is proposed (marked as suggested); when several are verified, nothing is proposed. A proposal is a read of the verdicts, never a decision.
7. **Done is the kept candidate's evidence.** Done needs a kept candidate and evidence produced by that candidate's own run, with its own observed tool calls; another candidate's bundle, verified or not, is refused. Only the kept version is verified and may feed other work. The other versions stay as unverified, compared outputs and are never deleted.
8. **Shown side by side.** The task shows each candidate with who ran it, its state, its verdict, cost (usage ledger by run) and time; the output compare view opens two candidates' versions with their provenance.

## Rejected
- **A candidate per work item.** The board would show N cards for one task and dependents would need to know which one counts; the task stays one item with several runs.
- **Auto-keeping the single verified candidate.** A verified verdict is evidence, not a choice between outputs a person may care about differently; the brief asked for a proposal.
- **Counting only one attempt's reserve at admission.** A budget that fits one attempt would start half a best-of-N and pause the mission mid-way.

## Limits
- A candidate that is still running holds the task in progress; a person who does not want to wait stops its run.
- A candidate names a member or a way of working, not a model: the model is the way of working's agent.
