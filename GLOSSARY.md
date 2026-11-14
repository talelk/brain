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

**Success criterion**:
One outcome a mission must reach, with a stable id (`c1`, `c2`: by position at creation,
never renumbered or reused) that plan versions and brief versions keep. Covered when at
least one confirmed plan task serves it and every serving task is done; a criterion no
task serves is shown as such, not as unfinished. Not a plan task's own acceptance
criteria, which say when that task is done.
_Avoid_: goal, objective, acceptance test

**Mission state**:
A mission's stored position: active, paused, verifying or closed. Working, waiting and
needing attention are conditions derived from its work, never stored states.
_Avoid_: mission status, draft

**Mission outcome**:
How a closed mission ended, set by a human: achieved (only after a verified verdict),
ended (stopped without claiming success) or cancelled (in-flight work cancelled).
_Avoid_: result, resolution, done

**Attention item**:
Something in a mission that a human must act on (a blocking item: an approval, a plan
proposal, a parked work item or a paused mission) or wants to know (a **result ready**
item). Only attention items notify; progress events never do.
_Avoid_: alert, notification (the delivery, not the item), todo

**Result ready**:
The one non-blocking attention item: a mission closed achieved or a task reached Done on
verified evidence. It sits below every blocking tier, never stops anything (closing
included), is derived from the mission and work records for 24 hours, and notifies like
any attention item under the per-mission throttle.
_Avoid_: success notification, completion alert, progress update

**Quality summary**:
The owner's deterministic read over a trailing window of existing records: share of tasks
verified without a human, stall rate, re-open rate, cost per verified task, median time
to first result and top failure reasons. Every figure ships with its definition; no model
computes or tunes anything.
_Avoid_: score, health score, KPI, AI report

**Since-last-visit summary**:
A user's deterministic digest of a mission's notable events since they last saw it.
What counts as seen is per user and per mission, whatever the device.
_Avoid_: recap, briefing, catch-up, AI summary

**Mission shape**:
Whether a mission is interactive or long-running, derived from whether it has a
coordinator or a confirmed plan version. A mission changes shape without changing state.
_Avoid_: mission mode, mission type

**Mission team**:
The team members assigned to one mission. It is part of each plan version, so plan and
team are confirmed together. The evaluator is never a member.
_Avoid_: team (unqualified), squad, crew

**Team member**:
A mission-scoped role (such as backend engineer or reviewer) bound to an agent
definition and engine. A team member is served by many sessions over the mission's
life; it is neither a runner nor a session. It is eligible for a plan task only when its
definition's tools, engine and caps cover what the task requires; the role name is a label.
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
and request team members without confirmation: an explicit list of permitted plan
operations (presets: supervised, standard, autonomous). It never covers effects, intent,
constraints, budget, started work or declaring a mission achieved.
_Avoid_: autopilot, auto-approve (it never authorizes effects), autonomy level

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
The team member whose role is planning and coordinating the rest of the mission team.
Missions whose dependencies are deterministic have none.
_Avoid_: lead, orchestrator, manager

**Plan version**:
An immutable, versioned decomposition of a mission into plan tasks and the mission team
assigned to them. Exactly one is
confirmed per mission at a time; editing a plan always produces a new plan version.
_Avoid_: plan (unqualified — say plan version or plan proposal), plan revision

**Plan proposal**:
A plan version awaiting human confirmation. A coordinator's plan version needs it only
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

**Parked work item**:
A work item stopped after repeated failed attempts, waiting for a human to retry,
reassign, edit or drop it. Independent work continues; only a human unparks it.
_Avoid_: stuck, failed (failure is an attempt's outcome), quarantined

**Affected branch**:
The plan tasks a new plan version changes, plus everything downstream of them. Every
other task must stay identical across the two versions.
_Avoid_: subtree, impacted area

**Subject**:
An external record a mission is about, such as a support ticket or an incident. A
subject is owned by its pack and can have several missions over time; it is neither a
mission nor a work item.
_Avoid_: case, intake item, work item (when meaning a ticket or incident)

**Execution link**:
The record that joins a mission, and a work item when there is one, to the runs, jobs,
attempts and sessions that served it. It is the boundary between the work side and the
execution side.
_Avoid_: execution (standalone — it names an area, not a thing), trace

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
subgraph. When a run reaches it, a job executes it.
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
tool outage, budget or unclassified. Each class has one remedy.
_Avoid_: error type

**Way of working**:
The kind of worker and independent check a task runs with, chosen from the active
release (a workspace has a default); the engine calls it a workflow.
_Avoid_: recipe, template

**Hosted model**:
A workspace's optional vendor model for independent checks and second attempts only. It is
always priced: input and output token prices (micro-USD per million tokens) travel with the
route, and an attempt on it costs its tokens times those prices, so mission and workspace
dollar caps bind it. The self-hosted model costs no dollars.
_Avoid_: external model, cloud model

**Session**:
A governed agent conversation served by one team member and bound to a mission, a job
and an attempt. Steering and stopping act on a session. A session may end while its
mission continues.
_Avoid_: runner session, auth session, upload session (all different things that
happen to share the word), chat

**Work session**:
A session that serves a work item from a confirmed plan version. No work session runs
before its plan version is confirmed.
_Avoid_: task session, worker session

**Mission-level session**:
A session bound to a mission but to no work item — an interactive conversation, or a
coordinator planning and coordinating. A coordinator's mission-level sessions act only
through Brain commands.
_Avoid_: planning session, chat session, free session

**Mission message**:
A durable message from a human to one team member or to the mission (which means its
coordinator). It is steered into a live session when the engine allows, otherwise
delivered when the recipient's next session starts. It never authorizes anything.
_Avoid_: chat, prompt, instruction (it is not a brief edit or an approval)

**Checkpoint**:
Durable state recorded by an attempt — a checkpoint commit on its branch, progress,
consumed and produced outputs, and in-flight effects — from which a later attempt can
resume. Resuming always creates a new attempt. A checkpoint is valid once the Governor
has checked it; it is never "verified", which belongs to evidence.
_Avoid_: snapshot, savepoint, resume point, verified checkpoint

**Runner**:
A separate outbound executable that executes agent and validator jobs, enrolled by
group with declared capabilities and engines.
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
A fresh authentication challenge required to exercise a high-consequence authority.
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
for a criterion. On a single-owner install a verified mission's asset publishes itself
(self-reviewed, ADR 0007); a newer asset of the same goal supersedes the older.
_Avoid_: memory (unqualified), insight, learning

**Memory publication**:
The governed promotion of vetted knowledge into a broader scope, requiring an approver
who is not the producer of the knowledge. A single owner with no other reviewer may
approve their own knowledge; it is then marked self-reviewed (ADR 0007). Approving
publishes in the same action; it is the only mechanism.
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
How widely a memory is readable: global-approved, team, workspace or private.
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

### Surfaces

Four places, named by where you look, never by what something is: **Today**, **Missions**,
**Library** and **Administration** (ADR 0029). **Live**, **Outputs** and **Schedules** are views of
missions; **Logs** and **Runners** sit under Administration. Inside a mission the **Team**,
**Plan** and **Brief** views are places, not the mission team, a plan version or the brief. The
**Library** holds what Brain can reuse (documents, knowledge, Plays, tools, the Review inbox;
ADR 0014). Screens use five words: **Mission**, **Plan**, **Task**, **Result** and **Check**; run, session, attempt and
release appear under Details.

**Build-process vocabulary is not domain vocabulary.** Task cards (`T01`–`T50`), gates
(`G01`–`G08`), the implementation ledger and checkpoint and pack verifiers describe how
Brain is built, not what Brain is, and have no place here. (A domain **checkpoint** is the
attempt state above; `VerificationRun` is a build gate record, not a domain concept.)
