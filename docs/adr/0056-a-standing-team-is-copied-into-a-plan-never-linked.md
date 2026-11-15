# 56. A standing team is copied into a plan, never linked

Date: 2026-11-15
Status: Accepted (spec #90, #130)

A named, reusable team lives in the Library (a place inside it, ADR 0014/0029, not a fifth place) so the same roles, agents and engines
are not rebuilt in every plan. A mission team stays part of each plan version (ADR 0032), so reuse must not make a confirmed plan depend
on something a person can edit afterwards.

**Decision.** A standing team is a named set of members (role, agent definition, engine; at most 12) that may name one coordinator among
them. Create, update (expected version) and archive are human-only commands (`mission:write`); a session cannot manage or reference one.

- **Copy at reference.** `plan.propose` and `mission.create` (with a Play) accept `standingTeamId`. The Governor copies the members into the
  plan version's team before the digest is computed and then applies the existing checks: published agent on an engine it accepts,
  per-task eligibility, and members never rebound (ADR 0032). Editing or archiving the standing team never touches a plan version or a
  mission; only later references see the change. An archived team is refused for a new reference.
- **A plan that already has members.** The standing team's members are added to the team the proposal names. The same member id with the
  same agent and engine is one member; the same id bound differently is refused with both bindings named. The plan editor copies on
  pick and says so before anything is confirmed.
- **A Play start.** The standing team's members replace the Play's own team. A Play task assigned to a member the standing team lacks is
  left unassigned, so any eligible member may take it. A Play that runs a coordinator takes the standing team's coordinator, else its own
  coordinator when the standing team has that member, and is refused when neither exists.
- **Eligibility is rechecked** at reference time against the release in force then, and again at confirmation as for any plan.

Rejected: a live link from plan to team (a later edit would change confirmed plans and break "plan and team are confirmed together");
a team that rebinds members (breaks ADR 0032).
