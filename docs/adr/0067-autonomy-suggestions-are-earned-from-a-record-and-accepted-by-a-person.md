# 67. Autonomy suggestions are earned from a record and accepted by a person

Date: 2026-11-15
Status: Accepted

Extends the autonomy policy (#35), the workspace ceiling, ADR 0017 (a schedule confirms a repeated plan only
under safety conditions), ADR 0010 (eval cases never auto-tune) and ADR 0024 (every effect needs its own
approval). Nothing here weakens any of them.

- **A suggestion is worked out on every read and never stored** (`autonomy.suggestions`), from existing records
  only: tasks that reached Done, the verdicts an independent check gave their results, tasks parked, eval cases
  and re-opened missions, failed task runs and their classes. No model computes or tunes anything. A record that
  turns bad therefore withdraws the suggestion at once, without a job or a write.
- **Three kinds, one step each.** A *mission* (still open) from its own preset; a *Play* from the missions it
  started, against the preset its next mission would take; a *repeated plan* whose schedule asks each time, to
  switch on "Confirm the plan automatically each time". A step is supervised to standard, or standard to
  autonomous, and never beyond the workspace autonomy ceiling. A repeated plan is offered only when ADR 0017's
  static conditions already hold (source mission achieved with a verified bundle, standard or higher, and no
  step that gates, merges, steers or acts with effects); the schedule's gate still judges every occurrence.
- **The record is counted from the last problem.** The counted period starts at the latest of: 30 days ago, the
  last rejected verdict, failed run, parked task, eval case or re-opened mission, and the last time a person
  accepted or dismissed a suggestion for the subject. A suggestion needs, in that period, at least 5 completed
  tasks, at least 5 judged results all verified, no parked task, no eval case or re-open, no failed run. The
  response carries each figure, what it counts, what a suggestion needs, and the evidence to open (agent pages,
  eval cases, missions, failure classes).
- **A person decides.** `autonomy.suggestion.accept` and `.dismiss` are human-only, need `mission:write`, and are
  refused to a session. Both re-derive the suggestion inside the command: a stale button on a withdrawn
  suggestion, or one the ceiling no longer allows, is a CONFLICT and changes nothing. Accepting a mission applies
  the ordinary policy change (ceiling and version checks included) in the same transaction as the record; a Play's
  accepted preset is the default its next mission takes (clipped to the ceiling like any); a repeated plan's
  switch is revised like any schedule edit. No step-up: `mission.policy.set`, which these commands only apply
  within the ceiling, has none.
- **Accepting a repeated plan is a schedule edit**, so it also needs `workflow:dispatch`, the scope of
  `automation.upsert` (checked in the handler); it flips only the confirm-automatically switch. The next run
  still passes every condition of ADR 0017 before the schedule confirms its plan.
- **Decisions are immutable** (`autonomy_decisions`, triggers refuse edits and deletes): who, when, from and to,
  and the figures with their definitions at that moment. A dismissal restarts the counted period, so the
  suggestion returns only after 5 new completed tasks of clean record; an acceptance does the same for the next
  step.
- **It is not an attention item.** The glossary's one non-blocking item stays "result ready". A suggestion does
  not notify and is not in `attention.list`; it shows on the Play page, the mission page and the Quality page,
  and renders nothing when there is none.
- **Effects are never touched.** Presets are lists of plan operations; none is an effect, a budget change, a
  sign-off or an intent change. The suggestion states this beside its buttons, and a test compares approvals,
  permits and effect policy before and after an acceptance.

Rejected: a suggestion table written by a sweep (stale until the next run, and a regression would wait for it);
raising several steps at once; counting the whole window after a regression (one old failure would block a
suggestion for 30 days); a model summarising why.
