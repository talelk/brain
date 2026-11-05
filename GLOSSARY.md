# Keyrus Brain

Brain is a governed execution workspace: humans set intentions, agents do the work,
and independent verification decides whether the work actually happened. Nothing an
agent claims about its own output counts as evidence.

## Language

### Work

**Objective**:
A durable workspace intention — a title, an intent and success criteria. No work items
exist and nothing runs while a plan is being prepared against it.
_Avoid_: goal, target, epic

**Plan version**:
An immutable, versioned decomposition of an objective into plan tasks. Exactly one is
confirmed per objective at a time.
_Avoid_: plan (unqualified — say plan version or plan proposal)

**Plan proposal**:
A plan version awaiting human confirmation. Proposals from agents are inert by
construction; confirmation is human-only.
_Avoid_: draft plan, suggested plan

**Plan task**:
One row of a plan version — a named unit of work with criteria and dependencies, which
becomes a work item when the plan is confirmed.
_Avoid_: task (standalone), todo, subtask

**Work item**:
Confirmed work materialized from a confirmed plan version, carrying criteria,
dependencies, assignment, a next action and an evidence binding. The unit the board
shows.
_Avoid_: card, ticket, issue, story

**Execution link**:
The record that joins a work item to the runs, jobs, attempts and sessions that served
it. It is the boundary between the work side and the execution side.
_Avoid_: execution (standalone — it names an area, not a thing), trace

### Execution

**Run**:
One execution of a released workflow, identified by its run id.
_Avoid_: workflow run (as a distinct noun — it is a synonym), job (when meaning a run)

**Run state**:
A run's position in its lifecycle: created, validated, ready, running, suspended,
blocked, succeeded, partial, failed, cancelled. Suspended is reversible; the others
are terminal or transitional as declared.
_Avoid_: workflow state, workflow run state (two names for this one concept)

**Step**:
A node declared in a workflow definition — dispatch, gate, evaluation, steer, merge or
subgraph. When a run reaches it, a job executes it.
_Avoid_: job (when meaning a declared node), node, stage

**Job**:
The runtime execution unit for one step of one run. A job is offered to a runner and
executed by attempts.
_Avoid_: task, run (when meaning a job), workflow job (which names a step)

**Attempt**:
One try at a job by one runner. A retry always creates a new attempt; a terminal
attempt never returns to running. An attempt owns the lease, fence and permits that
coordinate it.
_Avoid_: try, execution, session (an attempt is not the conversation)

**Session**:
A governed agent conversation bound to a work item, job and attempt. Steering and
stopping act on a session.
_Avoid_: runner session, auth session, upload session (all different things that
happen to share the word), chat

**Runner**:
A separate outbound executable that executes agent and validator jobs, enrolled by
group with declared capabilities and engines.
_Avoid_: worker, agent (an agent is a definition, a runner executes it), worker pool

**Launcher**:
The trusted component that sandboxes effect execution in ephemeral containers under
fixed profiles.
_Avoid_: sandbox, executor, container host

**Engine**:
A model-execution harness a runner adapts, pinned for the duration of an attempt.
_Avoid_: model (a model is what the engine drives), provider

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

**Evidence bundle**:
The concrete, digest-addressed set of artifacts, checks, approvals and effect records
that an evaluator judges.
_Avoid_: log, report, audit trail

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
A reusable, signed fact extracted from verified past work, with provenance and a
lifecycle of extracted, reviewed, published or revoked.
_Avoid_: memory (unqualified), insight, learning

**Memory publication**:
The governed promotion of vetted knowledge into a broader scope, requiring a reviewer
who is not the publisher. It is the only mechanism for either act.
_Avoid_: memory entry, promotion (there is no separate promotion step)

**Capability candidate**:
A proposed reusable tool or operation derived from repeated verified work, quarantined
until reviewed and gated by tests.
_Avoid_: tool proposal, suggestion

**Capitalization run**:
An autonomous pass that extracts knowledge assets and capability candidates from
verified history.
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
_Avoid_: principal (an actor is a principal mid-command), caller

### Surfaces

Unqualified area names denote where you look, never what something is: **Today**,
**Live**, **Work**, **Approvals**, **Knowledge**, **Administration**, and within Work
the **execution** area.

**Build-process vocabulary is not domain vocabulary.** Task cards (`T01`–`T50`), gates
(`G01`–`G08`), the implementation ledger, checkpoints and pack verifiers describe how
Brain is built, not what Brain is. They deliberately have no place here, and a term
that exists in both registers — notably `VerificationRun`, which is a build gate record
— is not evidence that the two are the same concept.
