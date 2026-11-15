# Keyrus Brain

Brain is a governed execution workspace for persistent teams of agents: humans set
missions, agent teams carry them out over many bounded sessions, and independent
verification decides whether the work actually happened. Nothing an agent claims about
its own output counts as evidence.

## Language

### Work

**Mission**:
A persistent workspace intention — a title, an intent and success criteria — that
outlives any single run or session and may last minutes or weeks. It owns its plan
versions, mission team, work items and outputs.
_Avoid_: objective, goal, target, epic, project

**Command palette**:
The Control/Command-K dialog. It searches the Missions and Work items (by title) of the workspaces the
person can read, plus runs, sessions, approvals, outputs and release documents, and lists actions the
keyboard can run (new mission, open approvals, open Live, open Board, go to a mission view).
A hit opens its own place; a Work item opens inside its mission (`?item=`).
_Avoid_: quick switcher, global search (the query is `search.global`)

**Success criterion**:
One outcome a mission must reach, with a stable id (`c1`, `c2`: by position at creation,
never renumbered or reused) that plan versions and brief versions keep. Covered when at
least one confirmed plan task serves it and every serving task is done; a criterion no
task serves is shown as such, not as unfinished. Not a plan task's own acceptance
criteria, which say when that task is done. A check covers it only by naming its id; one
no check names is "not linked to a check" on the sign-off view, however many checks passed.
_Avoid_: goal, objective, acceptance test

**Mission state**:
A mission's stored position: active, paused, verifying or closed. Working, waiting and
needing attention are conditions derived from its work, never stored states.
_Avoid_: mission status, draft

**Mission condition**:
Where an open mission stands, derived and never stored, counted once in the first that holds:
needs attention (a blocking attention item names it, an approval its task proposed included),
working (a task of it is running), else waiting. Closed missions have none.
_Avoid_: mission status, health

**Agent status**:
What an agent definition or a mission's team member is doing now, derived from its sessions and never stored, the first that holds: working (a session is starting, running or stopping), waiting (one waits for a person or an answer), failing (its latest ended session failed), else idle.
_Avoid_: agent health

**Verified rate**:
Of the results an agent's attempts submitted in the last 30 days that an independent check judged, the share whose latest verdict is verified. Counted on verdicts; no judged result means no number.

**Mission outcome**:
How a closed mission ended, set by a human: achieved (only after a verified verdict),
ended (stopped without claiming success) or cancelled (in-flight work cancelled).
_Avoid_: result, resolution, done

**Attention item**:
Something in a mission that a human must act on (a blocking item: an approval, a plan
proposal, a parked work item, a paused mission, a **sign-off item** or a **question**) or wants to know (a
**result ready** item). Only attention items notify; progress events never do.
_Avoid_: alert, notification (the delivery, not the item), todo

**Sign-off item**:
The blocking attention item "ready for sign-off", derived while a verifying mission's
evidence bundle is submitted. It names the bundle, so a rejected and resubmitted mission
raises a new one. A person answers it on the mission's Outputs tab with the mission
verdict (independence L3); an agent never can.
_Avoid_: approval (that gates an effect), review request

**Question**:
A team member's session asks a person something it cannot decide, through the `mission.ask` Brain tool
(ADR 0050). It is a record written once, and the blocking attention item "question" is derived while no
answer exists. The person answers from the mission's composer: the answer is a Mission message to the
asking member, delivered like any, and clears the item. A session may ask 3 questions in all and have 2
waiting at once; the asker is never held, and an answer authorizes nothing.
_Avoid_: ticket, request for input, blocker

**Result ready**:
The one non-blocking attention item: a mission closed achieved or a task reached Done on
verified evidence. It sits below every blocking tier, never stops anything (closing
included), is derived from the mission and work records for 24 hours, and notifies like
any attention item under the per-mission throttle.
_Avoid_: success notification, completion alert, progress update

**Push device**:
A browser a person turned notifications on for; each attention item is pushed to every one
of their push devices. Turning it off, in Settings or on Needs you, removes that device only.
_Avoid_: subscription (the browser's record of it), channel

**Quality summary**:
The owner's deterministic read over a trailing window of existing records: share of tasks
verified without a human, stall rate, re-open rate, cost per verified task, median time
to first result and top failure reasons. Every figure ships with its definition; no model
computes or tunes anything.
_Avoid_: score, health score, KPI, AI report

**Eval case**:
A regression case Brain saves, unasked, when a task is sent back from review or a mission
sign-off is rejected (ADR 0010): the stored plan, the reviewer's findings and the
deliverable digests, never transcripts. The Quality area lists them with source, mission
and date. A person replays them by hand before a release; nothing replays them or changes
a prompt, workflow or release because of one.
_Avoid_: test case, benchmark, learned prompt

**Since-last-visit summary**:
A user's deterministic digest of a mission's notable events since they last saw it.
What counts as seen is per user and per mission, whatever the device.
_Avoid_: recap, briefing, catch-up, AI summary

**Mission timeline**:
One chronological list of what happened on a mission: plan versions, accepted decisions,
messages, runs, approvals, effects, checks and results, filterable by kind and team
member, each entry linking to its source record. The Governor composes it on every read
from existing records; nothing is stored. It lives under the mission's Timeline view and
is neither the plan's dependency Timeline (work items over time) nor the Since-last-visit
summary (a digest of what changed since you looked).
_Avoid_: activity feed, audit log, history (an audit entry is a different record)

**Tool calls tab**:
The run page's list of every tool call that run made, in order, with its outcome, the
approval it proposed (if any) and a plain-words diagnosis of a failure.
_Avoid_: tool log, call history

**Mission shape**:
Whether a mission is interactive or long-running, derived from whether it has a
coordinator or a confirmed plan version. A mission changes shape without changing state.
_Avoid_: mission mode, mission type

**Mission team**:
The team members assigned to one mission. It is part of each plan version, so plan and
team are confirmed together. The evaluator is never a member.
_Avoid_: team (unqualified), squad, crew

**Usage attribution**:
The team member, agent definition, engine and model each settled usage row names (ADR 0051). The
Governor supplies member and agent; the runner reports engine and model; unreported stays empty. The
advisory judge's spend is its own source.
_Avoid_: cost center, tagging

**Estimate basis**:
Where a plan estimate's figure for time or cost comes from (ADR 0063): the median of past completed runs
of the same Play task or workflow in the workspace (history; shown as "median of N runs", with the 25th to
75th percentile range from four runs), what the planner declared, or unknown. Plain arithmetic over the
ledger; no model computes it, and it never changes a mission budget. A suggested budget is only an offer
a person may take.
_Avoid_: forecast, prediction, AI estimate

**Standing team**:
A named set of roles bound to agent definitions and engines, optionally naming a coordinator, kept in the Library. A plan or a Play start copies its members into the plan version as the mission team; editing or archiving it never changes a confirmed plan or a running mission (ADR 0056).
_Avoid_: shared team, team template

**Spend series**:
Settled spend per UTC day for the workspace, a mission or an agent, read from the usage ledger by the
day each attempt settled; days without spend are zero (ADR 0059). Cost per verified task by agent and
Play uses the Quality summary's definition.
_Avoid_: trend, forecast

**Team member**:
A mission-scoped role (such as backend engineer or reviewer) bound to an agent
definition and engine. A team member is served by many sessions over the mission's
life; it is neither a runner nor a session. It is eligible for a plan task only when its
definition's tools, engine and caps cover what the task requires; the role name is a label.
It keeps its agent definition and engine for the whole mission: a new plan version may add or
drop members, never rebind one.
_Avoid_: agent (an agent is a definition), worker, bot

**Mission brief**:
The versioned shared understanding of a mission — intent, constraints, accepted
decisions and progress — that every session of the mission starts from. Humans own intent
and constraints; progress is derived from the plan, never written. It is mission state,
not an output.
_Avoid_: mission memory, context dump, summary

**Accepted decision**:
An immutable entry in a mission brief recording a choice, where it came from and who
accepted it. It is superseded by a later entry, never edited.
_Avoid_: ADR, note, assumption (an assumption in a handoff is not yet accepted)

**Autonomy policy**:
The bounds within which a mission's coordinator may change unstarted work, assign tasks
and add or remove team members without confirmation: an explicit list of permitted plan
operations (presets: supervised, standard, autonomous). It never covers effects, intent,
constraints, budget, started work or declaring a mission achieved.
_Avoid_: autopilot, auto-approve (it never authorizes effects), autonomy level

**Autonomy suggestion**:
A deterministic offer, worked out on every read from a Play's, mission's or repeated plan's record since its last problem
(at least 5 completed tasks, every judged result verified, nothing parked, sent back or failed), to raise the autonomy
preset one step, never past the ceiling, or to confirm a repeated plan automatically (ADR 0067). A person accepts or
dismisses it; acceptance records who and the figures. It is not an attention item, never notifies, and never covers effects.
_Avoid_: recommendation, auto-upgrade, promotion

**Autonomy ceiling**:
The most autonomy any mission of a workspace may be given, one of the autonomy presets,
set by an organization administrator with a fresh step-up. A mission can be set lower,
never higher; it applies to missions created or changed after it is set.
_Avoid_: autonomy limit, cap

**Stop all sessions**:
A workspace administrator's emergency stop: every running attempt is fenced and ended, its
permits and session credentials revoked, and every active mission paused with the reason
(a stopped mission). Tasks return to ready; an effect already started is left for a person
to check. The workspace stays active. Not workspace suspend.
_Avoid_: kill switch, suspend, quarantine (that is a runner)

**Mission budget**:
The hard ceiling on a mission's spend, wall-clock time and concurrent team members.
Spend counts settled cost plus open reservations; wall-clock time excludes paused time;
the member cap counts concurrently running work sessions, not team size.
_Avoid_: quota, limit (unqualified)

**Play**:
A reusable mission template — a mission team, a plan shape and an input schema — that
can be started by hand, on a schedule or by a trigger.
_Avoid_: playbook, recipe, template, pack

**Coordinator**:
The team member whose role is planning and re-planning the mission within its autonomy
policy, only through Brain tools. It starts nothing and signs nothing off. Missions whose
dependencies are deterministic have none.
_Avoid_: lead, orchestrator, manager

**Plan version**:
An immutable, versioned decomposition of a mission into plan tasks and the mission team
assigned to them. Exactly one is
confirmed per mission at a time; editing a plan, including a task's assignment or the team,
always produces a new plan version, and started work is never changed in place.
_Avoid_: plan (unqualified — say plan version or plan proposal), plan revision

**Plan proposal**:
A plan version awaiting human confirmation. A session's plan version needs it only
when it goes beyond the mission's autonomy policy; anything else an agent proposes is
inert until a human confirms it.
_Avoid_: draft plan, suggested plan

**Plan task**:
One row of a plan version — a named unit of work with criteria and dependencies, which
becomes a work item when the plan is confirmed. It names the success criteria it serves.
_Avoid_: task (standalone), todo, subtask

**Work item**:
Confirmed work materialized from a confirmed plan version, carrying criteria,
dependencies, assignment, a next action and an evidence binding. The unit a mission's
Plan view shows; the primary UI labels it by its plan task name.
_Avoid_: card, ticket, issue, story

**Board**:
A view of work items in Ready, In progress, Review, Blocked and Done: a mission's Plan
tab opens on it, and the Missions place has one across the workspace's missions, filtered
by mission, team member, priority and tag. Review and Done are never reached by a drag.

**Parked work item**:
A work item stopped after repeated failed attempts, waiting for a human to retry,
reassign, edit or drop it. Independent work continues; only a human unparks it.
_Avoid_: stuck, failed (failure is an attempt's outcome), quarantined

**Priority**:
A work item's urgent, high, normal or low, written into the priority of every job its runs create. Inside
a workspace's fair share the higher priority is claimed first; it never lets a workspace jump another's
turn and never changes what Done needs (ADR 0041).
_Avoid_: rank, severity

**Tag**:
A lower-case label (up to 10) a person puts on a work item to slice the board.
_Avoid_: category, label

**Overdue**:
An open work item past its due date, flagged on its card and the board only. It is not an attention item
and never notifies.
_Avoid_: late alert, deadline breach

**Subtask**:
A work item that belongs to a parent work item, named by a plan version (`parentId` on its plan task), one level deep. The
parent shows how many subtasks are done and what they cost together, and is Done only when every live subtask is Done on its
own evidence and it has its own (ADR 0057). Not a delegated child session, which is a run of the mission.
_Avoid_: child task, sub-item, child run

**Affected branch**:
The plan tasks a new plan version changes, plus everything downstream of them. Every
other task must stay identical across the two versions.
_Avoid_: subtree, impacted area

**Subject**:
An external record a mission is about, such as a support ticket or an incident. A
subject is owned by its pack and can have several missions over time; it is neither a
mission nor a work item.
_Avoid_: case, intake item, work item (when meaning a ticket or incident)

**Subject trigger**:
A schedule that starts a Play for each new ticket or incident, one mission per subject. Its
plan waits for a person unless it repeats an earlier achieved mission under the ADR 0017
safety conditions.
_Avoid_: webhook, event rule, listener

**Execution link**:
The record that joins a mission, and a work item when there is one, to the runs, jobs,
attempts and sessions that served it. It is the boundary between the work side and the
execution side.
_Avoid_: execution (standalone — it names an area, not a thing), trace

**Mission trace id**:
The one 32-hex identifier of a mission, derived from its id, in every event payload and, when trace
export is on, the trace id of every span of that mission. Shown copyable on the mission and run
pages; never a metric label.
_Avoid_: correlation id, span id

### Execution

**Run**:
One execution of a released workflow, identified by its run id. It carries the release
it executes, its run state, creation time, a reference to its outputs, and the mission
and work item it serves when there are any.
_Avoid_: workflow run (a synonym), job (when meaning a run)

**Run state**:
A run's position in its lifecycle: created, validated, ready, running, suspended,
blocked, succeeded, partial, failed, cancelled. Suspended is reversible; the others
are terminal or transitional as declared.
_Avoid_: workflow state, workflow run state

**Step**:
A node declared in a workflow definition — dispatch, gate, evaluation, steer, merge or
subgraph. A step starts once every step it `needs` has succeeded, so steps with no need
of each other run together up to the mission's member cap (ADR 0043); a job executes it.
A step may declare a `when` condition (a pointer that exists or equals a value in an earlier
step's output): false, it is skipped, not failed, and so is every step that needs it, and
the run still succeeds (ADR 0046). A declared `retry` offers a failed attempt again as a new
attempt of the same job; `timeoutSeconds` ends an attempt that runs past it.
_Avoid_: job (when meaning a declared node), node, stage

**Job**:
The runtime execution unit for one step of one run. A job is offered to a runner and
executed by attempts.
_Avoid_: task, run (when meaning a job), workflow job

**Attempt**:
One try at a job by one runner. A retry always creates a new attempt; a terminal
attempt never returns to running. An attempt owns the lease, fence and permits that
coordinate it.
_Avoid_: try, execution, session (an attempt is not the conversation)

**Failure class**:
The one code stored for a failed attempt: missing tool, unmeetable criterion, model slip,
tool outage, quota, budget or unclassified. Each class has one remedy.
_Avoid_: error type

**Quota failure**:
The model provider refused with a 429 or quota or rate-limit text. A model route that refuses
is left out of every offer until the provider's retry-after (bounded) has passed and the
attempt moves to the next route at once; when no route is left the task waits that long,
without spending an attempt, then retries.
_Avoid_: rate-limit error, throttling

**Key reference**:
The short name (such as `acme-main`) by which a model route names its API key. The runner and
the Governor resolve it from their own environment (`BRAIN_MODEL_KEY_` and the name in
capitals); it never appears in a job, an event, an output or the interface.
_Avoid_: API key (the key itself), secret name

**Cost tier**:
A model route's price class (low, standard or premium). An agent that names a cost tier takes
routes of that tier or a cheaper one.
_Avoid_: price plan

**Way of working**:
The kind of worker and independent check a task runs with, chosen from the active
release (a workspace has a default); the engine calls it a workflow.
_Avoid_: recipe, template

**Choice reason**:
A small immutable record, a code plus the facts judged, written when the Governor chooses a
task's way of working, a team member or a model route; a later choice adds a record. The run's
Why tab words it in plain sentences from the record, never from today's state, and a choice
nobody made has none. No model writes it (ADR 0065).
_Avoid_: explanation log, audit note

**Model route**:
One entry of a workspace's ordered list of hosted models: provider, model, address, key
reference, cost tier and input and output token prices (micro-USD per million tokens). Routes
serve independent checks, second attempts and the advisory judge only. An attempt on one costs
its tokens times its prices, so mission and workspace dollar caps bind it; the self-hosted
model costs no dollars. A route names its API key by reference, never the key.
_Avoid_: hosted model, external model, cloud model

**Session**:
A governed agent conversation served by one team member and bound to a mission, a job
and an attempt. Steering and stopping act on a session. A session may end while its
mission continues.
_Avoid_: runner session, auth session, upload session (all different things that
happen to share the word), chat

**Paused session**:
One running session a person holds at its next turn boundary (`session.pause`) and lets go
on later (`session.continue`): the same session, with its fence, lease and runner slot
kept. The mission and the other members' sessions do not change. Held time is not working
time and does not run down the step's timeout; a session held longer than the hold limit
(30 minutes) is stopped. Only engines that can stop at a turn boundary offer it. Not a
paused mission (the whole mission, no new task starts) and not resume from checkpoint (a
new session started from a stopped session's saved conversation).
_Avoid_: suspend, freeze, resume (alone: ambiguous with resume from checkpoint)

**Work session**:
A session that serves a work item from a confirmed plan version. No work session runs
before its plan version is confirmed.
_Avoid_: task session, worker session

**Mission-level session**:
A session bound to a mission but to no work item — an interactive conversation, or a
coordinator planning.
_Avoid_: planning session, chat session, free session

**Mission message**:
A durable message from a human, or from a team member's session, to one team member or (from a
human only) to the mission, which means its coordinator. A person's answer to a **question** is one to
the member that asked. A team member names another member, never
itself, never interrupts, and has a few waiting at a time. It is steered into a live session when the
engine allows, otherwise delivered when the recipient's next session starts, labelled with its sender.
It never authorizes anything.
_Avoid_: chat, prompt, instruction (it is not a brief edit or an approval)

**Comment**:
A note on a work item, shown as its thread with corrections beside what they correct. A person's
comment is also sent as a Mission message to the team member serving the item (to the mission when
none does); a session's own comment is only in the thread. A comment never authorizes anything.
_Avoid_: note, annotation

**Checkpoint**:
Durable state an attempt leaves — progress, consumed and produced outputs, in-flight
effects and, for an engine that can resume, its saved conversation held on the runner that
took it. Resuming starts a new session in a new run on that runner and the session shows the
checkpoint it started from. A checkpoint is valid once the Governor has checked it; it is
never "verified", which belongs to evidence.
_Avoid_: snapshot, savepoint, resume point, verified checkpoint

**Runner**:
A separate outbound executable that executes agent and validator jobs, enrolled by
group with declared capabilities and engines. What it reports about itself (engine
version, adapter digest, when it observed a capability) is shown exactly as reported
and left out when not reported; Brain never fills it in.
_Avoid_: worker, agent (an agent is a definition, a runner executes it), worker pool

**Mission branch**:
A mission's integration branch in one repository, cut from the target base. Only the
merge controller writes to it.
_Avoid_: feature branch, team branch, integration branch (unqualified)

**Work-item branch**:
The branch one work item's attempts write to, cut from the mission branch. It has at
most one active writer at a time.
_Avoid_: attempt branch, task branch

**Session branch**:
The branch an interactive session writes to, cut from the mission branch and merged
into it only on a human's command.
_Avoid_: scratch branch, chat branch

**Launcher**:
The trusted component that sandboxes effect execution in ephemeral containers under
fixed profiles.
_Avoid_: sandbox, executor, container host

**Egress allowlist**:
The hosts an administrator lets a workspace's sandboxed tools reach (`host` or `host:port`).
The egress proxy gives each sandbox a grant of exactly those hosts; none means no network
(ADR 0037). Not the per-tool `allowedHosts` of the fetch broker.
_Avoid_: firewall, whitelist, network policy

**External MCP tool**:
A tool of a third-party MCP server, registered as a Tool document with `spec.mcp`: the admin declares its effect
class (read or write, never inferred) and pins the digest of the server's tool list. The pinned client runs it in
the sandbox with a grant for that one host; a changed tool list is refused until registered again (ADR 0064).
_Avoid_: MCP connector, plugin, MCP proxy

**Queue limit**:
How many of a workspace's jobs may wait for a runner (default 100, set by an administrator).
At the limit a person's new work is refused with the reason; work already admitted carries
on (ADR 0040). Not mission budget admission or the spend cap.
_Avoid_: rate limit, quota (quota is a model provider's limit)

**Chat identity**:
A chat user (Slack user id, Teams object id or the user of a Brain-signed request) that an
administrator linked to one member. Only a linked, active member can `start` a mission from
chat, with their own access; chat never approves or confirms a plan (ADR 0011, amendment).
_Avoid_: chat account, bot user

**Engine**:
A model-execution harness a runner adapts, pinned for the duration of an attempt.
_Avoid_: model (a model is what the engine drives), provider

**Broker tool**:
A release-pinned tool as an engine offers it to a model; every call goes through the
runner's broker, which validates it and runs it in a sandbox. An engine has no other
tool: its own native shell, edit and fetch are refused (ADR 0035).
_Avoid_: native tool (the engine's own, never allowed), plugin

**Engine isolation**:
The isolation an engine really provides on a runner, stated by the runner per engine
(`engine-isolation:<engine>:<mode>`); a step is placed on an engine only if it states
the step's isolation. ACP engines are `trusted-local` until engines run sandboxed.
_Avoid_: runner isolation (what the runner's tool sandboxes provide)

**Lease**:
Time-boxed ownership of a resource by an attempt, carrying a fence. Lease expiry proves
loss of Brain authority; it does not prove process death.
_Avoid_: lock, reservation (a lease is ownership, a reservation is capacity)

**Fence**:
A permanent, monotonically increasing counter on a lockable target. Deleting a lease
never resets it.
_Avoid_: lock version, epoch (runner epochs are a different counter)

**Reservation**:
Capacity or budget set aside for an attempt before admission, settled afterwards.
_Avoid_: lease, allocation

### Governance

**Approval**:
Human authorization of one exact proposed effect, bound to its digest, target and
precondition, and usable once.
_Avoid_: permission, consent, sign-off

**Approval consumption**:
The immutable ledger entry proving an approval was spent. It is recorded separately
from the approval's state and is never a state reset.
_Avoid_: approval update, approval use

**Effect permit**:
A Governor-issued authorization required immediately before a write or privileged
effect executes.
_Avoid_: approval (a permit is machine-validated, an approval is human), grant

**Approval origin**:
The run, work item and mission an approval was asked for, bound in its subject by the
Governor and never claimed by the caller. Titles, the diff and the rollback are read
beside it and are not part of the digest.
_Avoid_: context (that is the read-time part), owner

**Compensating action**:
What a Tool document declares undoes its effect, in plain words. Shown on the approval
as the rollback; Brain never runs it.
_Avoid_: undo, revert button

**Decision**:
A first-class auditable business judgement — go, no, not-now, need-more-data. It is not
an effect authorization.
_Avoid_: approval (when meaning a business judgement)

**Reconciliation**:
Resolving an unknown outcome using target-specific evidence and an authorized decision.
There is no universal retry for an unknown effect.
_Avoid_: retry, repair, recovery

**Command intent**:
The durable record that a command was accepted for execution: pending while its
effect runs, then applied or failed. A command receipt exists only for an applied
intent; a failed intent leaves its idempotency key free to retry.
_Avoid_: command log, pending command, queued command

**Idempotency key**:
The per-actor key a command carries so that the same key and payload return the same
resource, and key reuse with a changed payload conflicts.
_Avoid_: deduplication id, request id

**Step-up**:
A fresh authentication challenge required to exercise a high-consequence authority: an
approval decision, or an administrative command (the autonomy ceiling, stop all sessions),
bound to that exact change and spent once.
_Avoid_: 2FA (2FA is the enrollment; step-up is the challenge), MFA

### Verification

**Evidence**:
The immutable bundle assembled during a run and submitted to an independent evaluator.
A run reaches succeeded only when evidence is verified.
_Avoid_: proof, output, result

**Observed evidence**:
A successful recorded call of a tool the task declared it needs, decided by the Governor
from the call record, never by a model (ADR 0022).
_Avoid_: proof

**Output**:
A named thing a mission delivers, declared by a plan task and attributed to a team
member. It is identified by its mission and name, and each production is an output
version. It is what the mission delivers, not proof that the work happened.
_Avoid_: deliverable, result, artifact (when meaning the mission-attributed thing)

**Output version**:
One immutable production of an output, marked draft or final, with the attempt that
produced it. Only verified final versions may be consumed by other tasks or missions;
a follow-up mission's output may continue an earlier mission's output.
_Avoid_: output revision, copy, snapshot

**Handoff**:
An output a team member produces when finishing a plan task that other work depends on.
It pairs facts Brain derives from what merged (changes, outputs, criterion status) with
the member's own notes (what was done, decisions assumed, open questions, next action),
which stay claims. A dependent receives the handoffs of its direct dependencies only.
_Avoid_: summary, transcript, note

**Context pack**:
The ordered, budgeted text the Governor puts in front of an agent step that serves a task:
brief and constraints, accepted decisions, dependency handoff facts and notes, pinned inputs,
messages, checkpoint and the last failure. Only these declared sections enter. Over budget it
compacts deterministically (facts kept, prose cut or replaced by a reference to the full
text), never by a model summary.
_Avoid_: context dump, prompt stuffing

**Evidence bundle**:
The concrete, digest-addressed set of artifacts, checks, approvals and effect records
that an evaluator judges.
_Avoid_: log, report, audit trail

**Mission evidence bundle**:
The evidence bundle a mission's completion is judged on: its success criteria, mission
branch heads, final outputs and references to the verified evidence of its work items.
_Avoid_: mission report, completion report

**Verdict**:
An independent evaluator's judgement of an evidence bundle: verified, rejected or
incomplete, with the checks it ran and the independence level it held.
_Avoid_: validation verdict, score, outcome

**Advisory judge**:
The hosted model's opinion on each success criterion of a submitted mission evidence bundle,
written as an advisory check with its transcript as evidence. It never records a verdict,
changes a bundle or links a criterion, never blocks sign-off, writes nothing without a model
reply, and its calls are mission spend under the caps. Without a hosted model the view says
no judge ran.
_Avoid_: AI verdict, auto-verify

**Independent evaluator**:
A separate process, trust domain or human that judges evidence. An LLM judge cannot
establish success.
_Avoid_: validator (validators check inputs), critic

**Independence level**:
How separated the evaluator is from the work it judges: L1 separate process or attempt,
L2 separate runner trust domain, L3 independent human or external.
_Avoid_: autonomy, objectivity

### Memory

**Knowledge asset**:
A reusable, readable record extracted from verified past work (a closed achieved
mission), with provenance to the mission's evidence bundles and a lifecycle of
extracted, published or revoked. It needs observed evidence to be written up, and is a claim when reused: never evidence
for a criterion. Published assets, never revoked or expired ones, reach agents (knowledge search) and the planner (related
knowledge) labelled as claims with provenance; a knowledge search never counts as observation. On a single-owner install a verified mission's asset publishes itself
(self-reviewed, ADR 0007); a newer asset of the same goal supersedes the older.
_Avoid_: memory (unqualified), insight, learning

**Stale knowledge**:
A published knowledge asset whose source changed since it was written: a document it rests on has a newer version or was
removed, or an output it quotes has a newer verified version. The asset records fingerprints of its sources; a change marks it
stale (the contract's `stale` status) but it stays readable, searchable and reusable, labelled with what changed, and it is
never deleted. Search results and context packs flag it, and a pack lists what changed since the task's previous pack. Only
a person clears the mark: re-confirm (sources fingerprinted again) or revoke (ADR 0062).
_Avoid_: outdated, expired (expiry is time and use only)

**Memory publication**:
The governed promotion of vetted knowledge into a broader scope, requiring an approver
who is not the producer of the knowledge. A single owner with no other reviewer may
approve their own knowledge; it is then marked self-reviewed (ADR 0007). Approving
publishes in the same action, at the scope the approver chooses; it is the only mechanism, and republishing at another scope is refused.
_Avoid_: memory entry, promotion (there is no separate promotion step)

**Capability candidate**:
A proposed reusable tool or operation derived from repeated verified work, quarantined
until reviewed and gated by tests.
_Avoid_: tool proposal, suggestion

**Play proposal**:
A reviewable description of an achieved mission's confirmed plan, team and criteria, or
of a team's verified missions. Approving it opens a Studio draft; it is never a Play
until released (ADR 0015).

**Practice**:
The kind of work a team does (data, operations, support). It tags Plays and groups
Quality; it grants nothing.

**Challenge**:
An independent reviewer run over a finished result whose findings are stored as claims,
labelled as one model's opinion; it never changes a verdict (ADR 0012).

**Share link**:
A read-only, expiring, revocable bearer link to one verified result version (ADR 0013).

**Capitalization run**:
An autonomous pass that extracts knowledge assets and capability candidates from
verified history. It runs when a mission closes, or on demand, and never extracts from
member notes, messages or transcripts. A write-up may quote the worker's Result summary,
a bounded deliverable excerpt, per-criterion evidence and assumptions, each labelled the
worker's statement (not independent proof); there is no model call. A mission with too
little result (reuse spec threshold) is not written up.
_Avoid_: learning run, consolidation

**Memory scope**:
How widely a memory is readable: global-approved, team, workspace or private. Private is the author's alone; team is the
mission team of the mission it came from (its owner, watchers and sessions), keyed on the mission until standing teams
exist. Every read filters by it, a session never reads private memory, and a scope never widens without a review: the
author asks, a different person with the review scope decides, or a sole reviewer does and it is marked self-reviewed
(ADR 0061). Narrowing is immediate.
_Avoid_: namespace, visibility

### Configuration

**Release**:
An immutable manifest addressed by content digest, compiled from declared definitions.
Compiling never activates.
_Avoid_: version, build, bundle

**Config digest**:
The SHA-256 content digest addressing an exact configuration. Documents reference each
other by digest of exact bytes.
_Avoid_: hash, checksum, version

**Skill**:
A release document of instructions an agent pins by digest. When a task names one of its
trigger words the Governor loads its text into the agent's instructions for that job.
Text only: it never adds a tool, permission or effect class, and compiling rejects one
that tries, carries a secret or is too large.
_Avoid_: plugin, ability, native skill

**Draft**:
An editable, versioned bundle of configuration documents awaiting validation and
publication.
_Avoid_: WIP config, working config

**Draft revision**:
One immutable snapshot of a draft's documents and assets.
_Avoid_: version (a release also has versions), edit

**Compile**:
Collecting declared assets, rejecting missing or dangling references, and staging an
immutable manifest. It activates nothing.
_Avoid_: build, validate (validation checks a draft; compile stages a release)

**Publish**:
Producing an exact, committed artifact of a definition that is live only after
activation.
_Avoid_: deploy, release (publish creates it, activate makes it current)

**Activate**:
Making a published release the current one, re-checking the observed active digest so a
concurrent activation fails.
_Avoid_: publish, apply, promote

**Git provider**:
The hosting product a Git connection is declared to be (GitHub, GitHub Enterprise, GitLab or
Gitea), chosen when the connection is set up. It decides which API opens a pull request; it is
never inferred from the address, and any other provider is refused.
_Avoid_: Git host (the host is only the address), vendor

**Pull request record**:
The pull request an approved change opened, kept once on its work item and its approval: the
address, the Git provider, and the state it had when opened. Never edited; where the request
stands later is a new observation, read from the provider only when a person refreshes it.
_Avoid_: PR status (a record has a history of states, not one mutable status)

**Diagnostics bundle**:
The redacted file an administrator downloads from Health for support: versions, runner
inventory as the runners reported it, readiness, backup status and recent errors (as codes
and ids). Built field by field from an allowlist; it holds no credential, token or private
text, and no value nobody observed.
_Avoid_: support dump, debug export

**Stale backup**:
A backup whose recorded finish time is older than the limit (36 hours unless set), shown
in Health as degraded. Health only reads what the host's backup job recorded (ADR 0039);
a backup nobody recorded is a warning, never a pass. The **restore test** is the host's
monthly rehearsal restoring the newest backup into a scratch directory; Health shows its
last result.
_Avoid_: missed backup

### People and tenancy

**Organization**:
The tenant boundary. All authorization is scoped to it.
_Avoid_: account, company, tenant

**Workspace**:
A bounded area of work inside an organization, with its own data, plans and memory
scope.
_Avoid_: project, space, team

**Principal**:
An identity that can act, human or machine, resolved from server-verified credentials.
_Avoid_: user (a user is a kind of principal), actor (an actor is a principal plus the
session it acted through)

**Actor**:
The principal performing a command, together with the session and scope it acts through.
_Avoid_: caller

**Brain tool**:
An operator-declared, release-pinned tool through which an agent acts on Brain itself: comment on a
work item, message a team member, submit a handoff, propose a plan, delegate a sub-task (ADR 0042, 0051) or ask a person a question (ADR 0050). Each is one command run
as the session principal, so the authorization matrix and the principal's own-mission scope decide. A
plan proposal inside the autonomy policy is confirmed, outside it waits for a person; no Brain tool
records a verdict, closes a mission, approves an effect or confirms beyond the policy.
_Avoid_: agent API, MCP tool (that is another channel)

**MCP server**:
Brain's `/mcp` endpoint, a standard Model Context Protocol server over streamable HTTP. Every registered command and query is a tool (`command.<type>`, `query.<type>`) generated from the registry and `brain.schema.json`, called as the signed-in person or session principal with the same credentials, authorization matrix and idempotency as `/v1`. Approval decisions are not tools: they stay in the app.
_Avoid_: agent API, MCP channel

**Delegation**:
A session handing one bounded sub-task to a child session of the same mission, at most three levels deep (ADR 0053). The child is a run of the mission, not of the task; its result returns to the task as a handoff that is the child's claim until a person who did not start the delegation accepts it.
_Avoid_: subtask run, spawn

**Session principal**:
The machine principal (kind agent) of one team member of a mission, bound to its workspace
and mission and recorded as acting for the mission owner (ADR 0032). A running attempt holds
a credential for it that ends with the attempt or when its fence moves. The credential runs
only the **session command allowlist**.
_Avoid_: bot, service account, agent user

**Owner transfer**:
`mission.owner.transfer`: the mission's owner or a workspace administrator hands an open mission to an active
member who holds what its sessions need (ADR 0054). Audited; attention and notifications follow; **session
principals** act for the new owner at once, running attempts keep their fence. Sessions never run it.
_Avoid_: reassign mission, change owner

**Session command allowlist**:
The commands a session credential may run: only those behind the Brain tools, not whatever its role's
scopes admit (ADR 0032). The rest are refused; a test requires every command to be classified.
_Avoid_: session scope, agent permissions

### Surfaces

**Fleet overview**:
The glance on Today that every workspace member sees: open missions by **mission condition**,
team members with a live session, the runners' slots in use of the total (shared by the
organization) and spend today (trailing 24 hours plus open reservations). It names no runner;
only a holder of runner administration also gets the runner list and the way into **Runners**.
_Avoid_: dashboard, fleet page, health score

Four places, named by where you look, never by what something is: **Today**, **Missions**,
**Library** and **Administration** (ADR 0029). **Live**, **Outputs** and **Schedules** are views of
missions; **Logs** and **Runners** sit under Administration. Inside a mission the **Team**,
**Plan** and **Brief** views are places, not the mission team, a plan version or the brief. The
**Library** holds what Brain can reuse (documents, knowledge, Plays, tools, the Review inbox;
ADR 0014). Screens use five words: **Mission**, **Plan**, **Task**, **Result** and **Check**; run, session, attempt and
release appear under Details.

**Route inventory** (`contracts/v1/api-routes.json`) is the one hand-kept list of Brain's public HTTP
routes; the OpenAPI document (`contracts/v1/openapi.json`, served at `GET /v1/openapi.json` to any signed-in
credential) is generated from it plus the schema, registry and authorization matrix. The `brain` CLI is a client
of that HTTP API only: its `mission`, `session` and `approval` commands run the same commands and the same
step-up as the app (an approval is decided only with fresh step-up evidence).

**Build-process vocabulary is not domain vocabulary.** Task cards (`T01`–`T50`), gates
(`G01`–`G08`), the implementation ledger and checkpoint and pack verifiers describe how
Brain is built, not what Brain is, and have no place here. (A domain **checkpoint** is the
attempt state above; `VerificationRun` is a build gate record, not a domain concept.)
