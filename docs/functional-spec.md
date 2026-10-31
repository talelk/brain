# Functional specification — user and admin workflows

Describes the functional behavior of Brain for end users and administrators, with
technical notes where the underlying contracts matter. Companion document:
[Screen descriptions](screen-descriptions.md) for the UI surface. Implementation
internals live in `docs/implementation/`; task-oriented guides in `docs/howto/`.

Sources: `contracts/v1/authorization-matrix.json`, `contracts/v1/state-machines.json`,
`contracts/v1/ui-screen-contracts.json`, `docs/howto/`, and the starter release under
`examples/v1/starter-release/`.

## 1. System context

Brain is a governed AI-work platform. One **Governor** process is the control plane
(auth, workspaces, catalog, runs, approvals, evidence, audit). **Runners** are separate
executables that execute agent and validator jobs; a **trusted launcher** sandboxes
effect execution in ephemeral containers. All agent capability is defined by immutable,
digest-pinned **releases**. The web UI and the CLI are both first-class clients of the
same command API.

The invariant that shapes every workflow: **a model output is never trusted by
itself.** Tasks succeed only with independently validated evidence; external effects
require an explicit human approval; configuration activates only after explicit
inspection.

## 2. Actors and authorization model

Roles come from `contracts/v1/authorization-matrix.json`: default deny, no role
inheritance, workspace reads require membership.

| Role | Grant scope | Key scopes |
|---|---|---|
| viewer | workspace | `workspace:read` |
| operator | workspace | read, dispatch/cancel workflows, steer/stop sessions, board writes, tool propose, approval request, job reconcile, decision write |
| workspace-lead | workspace | operator plus `workspace:admin`, export, `memory:publish`, `approval:revoke`, `members:read` |
| approver | workspace | `approval:decide`, `approval:revoke` |
| organization-admin | organization | `config:activate`, `runner:admin`, membership grant/revoke, `audit:read`, `platform:read`, workspace import |
| security-admin | organization | `runner:security`, `memory:admin`, `approval:revoke`, `audit:read`, membership revoke |
| tool-publisher | organization | `tool:publish` |

Special endpoint rules, enforced server-side rather than by the UI:

- `approval.decision` is human-only; agents and workflows are structurally rejected.
  The CLI refuses the command entirely because decisions require interactive review.
- `task.start` is original-actor-only: only the principal who prepared a task may
  start it; an agent proposal must be started by the human who confirmed it.
- `task.prepare` and `conversation.*` accept human, agent, or workflow actors, always
  workspace-scoped with current membership required.
- `diagnostics.export` is human-only and requires `config:activate` plus
  `runner:admin`.
- Client-submitted human ActorContext is rejected; the authenticated principal remains
  the authority (scenario E001). Agent calls to the approval endpoint or forged human
  notes accept no decision (E004).

## 3. Domain concepts

- **Release** — immutable manifest addressed by SHA-256 content digest, compiled from
  a directory of YAML documents (Agents, Workflows, Policies, Tools, Evaluators, runner
  groups, workspace declarations), markdown agent instructions, confined JSON schemas,
  and tool scripts. Documents reference each other by digest of exact bytes. Compile
  never activates; activation is a separate explicit act.
- **Agent** — named model role with pinned instructions, permitted engines, immutable
  tool allowlist, and limits (turns, tokens, cost `maxMicroUsd`, children, depth).
- **Workflow** — DAG of jobs. Job kinds: `dispatch` (agent execution) and `eval`
  (independent validation). Inputs bind from user input, literals, or other jobs'
  outputs via pinned JSON pointers.
- **Run / job / attempt** — a run is one workflow execution. Each job has attempts;
  retry always creates a new attempt; no terminal attempt returns to running.
- **Evidence** — immutable bundle assembled during the run and submitted to an
  independent evaluator; a run reaches `succeeded` only when evidence is verified.
- **Effect class** — every tool/job is `read`, `write`, or `privileged`.
  `write`/`privileged` require a Governor-issued effect permit, re-validated
  immediately before execution.
- **Governed tool broker** — the only path for agent tool calls. Native Pi/Claude
  host tools stay disabled; only release-pinned tools cross the broker.
- **Work items** — boards with cards, support tickets, incidents. Tasks start from
  them and runs stay linked back.
- **Audit + outbox** — every state transition writes audit and outbox entries
  atomically with the mutation, expected-version checked.

## 4. End-user workflows

### UF-01 First sign-in

Actor: any user; on fresh local installs, the generated administrator.

1. Open the URL printed by `rtk pnpm brain start`; sign in with email and password.
2. Fresh local installs use `admin@brain.local` / `admin-password` without a forced change;
   custom initial credentials can be supplied through the bootstrap environment.
3. On success the user lands in their default workspace ("My workspace" on fresh
   installs). Explicit temporary-password flows, when used, still require a change.

Exceptions: revoked or replaced sessions deny new operations and clear streams (E003).

Technical notes: native cookie sessions with CSRF/origin checks on mutations (E005).
Optional TOTP enrollment lives under Settings → Security; when 2FA is required
platform-wide, sign-in and approval step-ups demand a current TOTP code, and replaced
authenticators invalidate existing approval evidence.

### UF-02 Start a task from the catalog

Canonical path: **prepare → review → start**, two explicit confirmations.

Actor: operator or workspace-lead. Preconditions: active release with visible catalog,
workspace membership, runner placement for the workflow's group (otherwise the run
waits).

1. Select a task (starter tasks: *Investigate an operational issue*,
   *Draft a support response*).
2. The UI renders a schema-driven form from the workflow's `inputSchemaRef`; example
   presets may prefill it.
3. Select **Review task**. Inputs validate against the pinned schema before anything
   durable is created.
4. The review screen shows the exact complete input. Select **Start task** — the
   durable, explicit start confirmation.
5. The user lands on the run page.

Exceptions:

- Validation failure: fields are flagged, the form retains all input, nothing was
  created (a rejected dispatch changes no state).
- Lost response or unclear acceptance: selecting **Start task** again on the same
  review recovers the existing run via the idempotency key. Preparing a different task
  to retry a lost response is explicitly wrong.

Technical notes: `task.prepare` and `task.start` are separate commands; `task.start`
is original-actor-only. Idempotency: same key and payload after a timeout returns the
same resource and saved receipt; same key with changed payload, workspace or version
conflicts with no second mutation (E006–E008).

### UF-03 Ask Brain (conversational task proposal)

1. Describe a goal in conversation. Brain may ask clarifying questions and propose an
   existing catalog task with proposed inputs.
2. The proposal is inert: conversation alone never starts the task.
3. Select **Review proposed task**, edit inputs if needed, then **Start task** (same
   review→start flow as UF-02).

Privacy: conversations are workspace-scoped and original-actor-only
(`conversation.get`/`conversation.list`); other users cannot read your thread.
Fallback: if the conversational model is unavailable, choose a task directly (UF-02).

### UF-04 Start a task from a work item

Open a board card, support ticket, or incident detail page and select **Start a task
for this item**. The form opens with known item information prefilled; review and
start remain mandatory. The run records the originating item; the item page lists all
related runs with current state, each linking back.

Explicit non-goals: completing a task never moves a card to Done and never approves an
external action. Those remain human acts (UF-06, UF-07).

### UF-05 Monitor a run

Open a run from Today activity, the Activity list, an item page, or global search.

- **Summary**: structured step outputs, schema-validated.
- **Timeline**: engine events, including governed tool-call events (`tool.proposed`,
  permit checks, receipts).
- **Evidence**: the independent validation verdict and artifact links. A model
  response alone never means success.

Live sessions support steering and stopping (`session:steer`, `session:stop`).
**Cancel run** from the detail page (`workflow.cancel`); already-committed effects are
not undone and require reconciliation (UF-06).

Technical notes: the workflow machine allows `running → suspended` (for example while
waiting on approval) and back; job states cycle `queued → offered → running →
verifying → succeeded/failed/partial` with `outcome_unknown` as a first-class state.
Terminal states are terminal; every transition is expected-version checked with
atomic audit and outbox writes.

### UF-06 Approve or reject a proposed external action

Actor: a human with `approval:decide`; never the author of the effect.

1. The proposed effect (for example, restart a production service) creates an approval
   request visible under **Approvals**.
2. The reviewer opens the review page. The subject carries the exact effect:
   operation, target with precondition digest, tool and input digests, effect bounds,
   budget, expiry.
3. The decision is made on that page only; the CLI cannot decide.
4. With required 2FA, the decision needs a current native session plus TOTP.
5. Decision: approve or reject — exact, one-use.

Guards (`contracts/v1/state-machines.json`): `pending → approved` requires current
authenticated human (with step-up when configured), the exact displayed digest,
separation of duties, and an unexpired current version.

Exceptions:

- Unobserved decision (network loss): recover status from the review page
  (`approval.decision-status`, original-actor-only, current membership required).
- Changed mind after approval: `approval:revoke` (workspace-lead, security-admin);
  `approved → revoked` is legal.
- Pending approvals expire; approved grants can expire.
- Unknown outcome after execution: use the run page's reconcile action; reconcile the
  recorded target state before any retry. Unknown outcomes resolve only with
  target-specific reconciliation evidence plus an authorized decision — never a
  generic retry.

Technical notes: approval consumption is a separate immutable ledger entry, not a
state reset — an approved grant is spent once and the spend stays independently
auditable. Effect permits for `write`/`privileged` tools are re-validated immediately
before execution; a runner that lost its lease stops making effects and records its
attempt outcomes as `outcome_unknown`.

### UF-07 Work items: objectives, plans, board

Plans (UF-11) confirm into **work items** with dependencies, assignments, criteria
and a next action. Moves on the board are version-checked: moving with a stale
expected version conflicts, shows the current version, and never overwrites (E009).
Dependencies release Ready work only when every predecessor is Done; Done always
requires verified evidence covering every criterion plus human acceptance when
policy requires it — an agent conversation never closes work. All work mutations are
idempotency-keyed commands (`objective.create`, `plan.propose`, `plan.confirm`,
`workItem.transition`, `workItem.comment`) with optimistic concurrency.
`board:write` belongs to operators and leads; viewers read items.

### UF-08 Record a decision

Operators and leads (`decision:write`) record human decisions — for example "rollback
approved in war room" — as first-class auditable objects in the Decisions area,
separate from effect approvals.

### UF-09 Find things

Global search finds runs, approvals, agents, and workflows by id. Work areas (Today,
Support, Incidents, Delivery, Decisions, Knowledge, Tools) provide browsable lists;
every detail page cross-links run ↔ item ↔ approval ↔ evidence.

### UF-10 Account security

Password change; voluntary 2FA enrollment or disable when optional, mandatory
enrollment when required; recovery sign-in requires replacing the previous
authenticator before any approval evidence can be issued again. Push notification
controls are attention hints and never replace sign-in and exact review.

### UF-11 Turn an intention into reviewed work (Plans)

1. Describe the objective: title, intent, success criteria on **Plans**.
2. Brain dispatches the release's plan-guide agent through the same governed runner
   path as any agent work; an independent evaluator validates the proposal. The
   objective is durable from creation; **no work items exist and nothing runs** while
   the proposal is prepared (E101).
3. The proposal is reviewed and edited in place: task titles, criteria, dependencies.
   **Confirm this plan** materializes exactly one plan version into work items and
   dependencies in a transactional workspace write.
4. Replanning proposes a new plan version. Confirmation retains unchanged work with
   its history, replaces changed work and abandons removed unfinished work; past
   executions stay linked to the version that authorized them (E102).
5. Done requires verified evidence; dependencies release downstream work only after
   verified completion (E103).

Failure modes: no validated proposal leaves the objective untouched with a visible
reason; generation can be retried without side effects. Plan proposals from agents
are inert by construction — confirmation is human-only.

### UF-12 Schedule and automate work (Schedules)

One durable scheduler drives work-item scheduled starts and released-workflow
invocations from the same model.

1. Create an automation: target (workflow id or work item), trigger (recurring cron
   with an IANA timezone, one-off delayed, or manual), overlap policy
   (skip / queue-one) and misfire policy (skip / coalesce).
2. Next occurrences are computed server-side and previewed; the browser never
   computes schedules.
3. **Pause** stops fires; **Resume** applies the misfire policy to the missed window —
   coalesce fires once, skip records the missed occurrences as skipped history and
   continues in the future. **Run now** creates an explicit occurrence at the current
   instant through the same dispatch path (E104).
4. Every planned instant materializes as an immutable occurrence keyed by
   (automation, revision, instant); the occurrence id is the workflow execution key,
   so a Governor restart, a replayed pass or a lost response cannot duplicate a run.
5. Revising an automation creates a new revision anchored at the revision instant;
   past occurrences and their run links are never rewritten.
6. A work-item target releases a waiting (Backlog) item to Ready exactly once; if the
   item already moved, the occurrence is skipped with the reason in history.

Authorization: `automation.upsert` and `automation.control` are human-only with the
`workflow:dispatch` scope (operators and leads).

## 5. Admin workflows

### AF-01 Install and bootstrap

1. `rtk pnpm install --frozen-lockfile` then `rtk pnpm brain start`.
2. Fresh initialization creates the admin account `admin@brain.local` with the default
   local password `admin-password`, My workspace with the two starter tasks, and the agents,
   governed context tool and independent validator those tasks need. It prints the URL
   and sign-in hint. `BRAIN_ADMIN_EMAIL` and `BRAIN_ADMIN_PASSWORD` override these
   credentials before initialization.
3. First sign-in does not force a password change (UF-01).

Technical notes: the unattended setup token is one-use and never printed by Governor.
State defaults to `~/.local/share/brain`; `BRAIN_INSTANCE_DIR` relocates it. Restart
preserves accounts, workspaces, model settings and runner identities. Existing data
directories with a different schema are refused, never migrated: use a fresh
directory, or stop and review the existing deployment.

### AF-02 Connect model and runners (Setup)

Actor: organization-admin; the Setup tab is admin-only.

1. Administration → Setup: enter the model API URL and exact model ID
   (self-hosted OpenAI-compatible endpoint for Pi; Claude needs its own endpoint and
   credential).
2. Select **Test connection and start runners** — preflight must actually reach the
   engine and model; failure is explicit.
3. Local task and validator runners pair automatically.
4. Run the installation test in the setup checklist to prove execution end to end;
   finding a model alone does not mark execution verified.

Technical notes: engine preflight fails clearly when the selected agent profile does
not permit the engine. Runners enroll with group, capabilities and engine; placement
matches at dispatch against `runsOn` constraints (group, capability expressions,
resources, `ephemeral-container` isolation minimum).

### AF-03 Manage access

Actor: organization-admin (grant, revoke), security-admin (revoke).

Administration → Members: grant a role to a principal with a recorded reason; revoke
to cut off new reads and writes immediately — open sessions stop working: new
operations denied, streams cleared (E003).

Technical notes: `member.grant`/`member.revoke` commands; membership is per-principal
per-scope (workspace or organization); the default-deny matrix is evaluated
server-side on every command; cross-tenant ID use returns 404 with no data or cache
leakage (E002).

### AF-04 Author and activate a release

The core admin competence: defining what agents may do.

1. Author a release directory starting from `examples/v1/starter-release/`:
   - `config/*.yaml` — Agents (instructions path, engines, tool allowlist by digest,
     limits), Workflows (job DAG, input/output schema refs, `runsOn`, `effectClass`,
     timeouts), Policies (for example `productionHumanApproval: required`,
     `defaultEffect: deny`, budget/runtime/isolation floors), Tools, Evaluators,
     runner groups, workspace declarations.
   - `agents/*.md` — instruction bytes.
   - `schemas/*.json` — confined schemas; network schema references are rejected.
   - `tools/<id>/<entrypoint>` — executable scripts, pinned and served over the
     authenticated runner protocol.
2. Compile: `config compile <dir>` collects all declared assets, rejects missing
   instructions, schemas and bad references, and stages an immutable manifest. Output:
   a release digest. Compile never activates.
3. Inspect: `config inspect <digest>` (or Administration → Releases in the UI) —
   review the complete contents of exactly what will activate.
4. Activate: `config activate <digest>` (or the UI action). Activation re-checks the
   observed active digest; a concurrent activation elsewhere fails and requires a
   fresh inspection.
5. Verify: `workflow list`, `doctor --workspace <id>` (nonzero exit when release,
   catalog or placement is broken), `workflow run agent-smoke` (the smoke check stays
   unverified until an independently accepted run exists).

Change discipline: documents reference each other by SHA-256 of exact bytes. Edit an
Agent and every workflow pinning it must reference the new digest; edit a Tool and the
Agent allowlist entry plus the entrypoint `sha256` must update. Stale digests fail
compile or dispatch — never silently accepted.

UI support: the Effective configuration view traces where any active value comes from
(`config.explain`).

Technical notes: compile stamps a source revision (bundle content digest by default,
or `--source-revision sha1:<git-commit>` / `sha256:<digest>`); activation/readiness
refuse a UI-foundation manifest digest mismatch.

### AF-05 Add a governed tool

1. Declare a Tool document: id, `effectClass: read|write|privileged`, confined
   input/output schemas, required capabilities, timeout, `maxOutputBytes`,
   `allowedEnvironments` (the first entry becomes the pinned execution target),
   entrypoint.
2. Stage the script at `tools/<tool-id>/<entrypoint>`; compile pins
   `sha256(script bytes)` next to the document digest.
3. Allowlist the tool by digest in an Agent; update every workflow pinning that Agent.
4. Activate via AF-04.

Broker enforcement at every call:

1. The engine sees the tool as `brain_<tool-id>` with the pinned input schema.
2. A model proposal emits `tool.proposed` with tool release, target and input digest.
3. The supervisor re-checks allowlist membership at the exact digest, target equality
   with the pinned target, and input validation against the pinned schema.
4. `write`/`privileged` additionally need a Governor-issued effect permit,
   re-validated immediately before execution; `read` never requests one.
5. Execution runs sandboxed through the trusted launcher; without a launcher,
   effect-class execution fails closed, never host bash.
6. Output uploads as an immutable artifact, lands in the evidence bundle's
   `toolReleases`, and returns with a receipt.

Bounds: invocation count by Agent `maxTurns`, output by `maxOutputBytes`, runtime by
step timeout. Any mismatch aborts that tool call loudly. `tool.propose`/`tool.publish`
(the tool-publisher role) gate organizational availability.

### AF-06 Operate runners

Actor: organization-admin (`runner:admin`), security-admin (`runner:security`).

Runs → Runners lists enrollment, group, capabilities, engine and heartbeat. From the
runner detail page: drain (finish current, accept no new work) or quarantine (exclude
entirely). A runner that loses its lease stops making effects on its own; its
in-flight attempt outcomes become `outcome_unknown` and flow into the reconcile path
(UF-06). Runner admin, connectivity, allocation and health are independent axes.
Enrollment tokens are one-use; replay or expiry is denied (E010).
`brain doctor --workspace <id>` checks release, catalog and placement in one shot.

### AF-07 Watch health, audit, diagnostics

Health tab: live service snapshot; a degraded banner shows pending outbox deliveries
with ages. Audit trail: append-only, workspace-scoped; every admin and user command
lands there (actor, action, resource, time, cursor). Diagnostics download: redacted
bundle, human-only, requires `config:activate` plus `runner:admin`.

### AF-08 Publish workspace knowledge

Actor: workspace-lead (`memory:publish`) or security-admin (`memory:admin`).

`memory.publish` makes vetted knowledge (runbooks, product facts) available to agents
in the workspace; `memory.revoke` withdraws it. The Knowledge area shows published
memory; an optional external Memory UI can be linked credential-free and opens with
`noopener noreferrer`; Brain forwards no credentials. An optional TencentDB-backed
memory service requires an explicit credential for any non-loopback URL and fails
closed without one.

### AF-09 Backup and restore

Backup (managed install): `rtk pnpm brain backup /path/to/new-backup` stops managed
processes, creates and verifies the archive, then restarts. Keep the backup outside
the instance's data, run and cli directories so reset preserves it.

Custom deployments: lower-level Governor maintenance commands
(`maintenance backup/verify/restore`) run on the Governor host; they contend for the
kernel-held SQLite ownership lock, so a live Governor yields `CONFLICT` rather than a
torn copy.

Captured: database via the SQLite backup API (committed WAL pages included), CAS
bytes, pinned releases, engine snapshots. Verification re-reads every file, checks
hashes, SQLite integrity and foreign keys; unsafe paths, duplicates, links and special
files are refused; output is staged privately and published by rename only on
success. Archive completeness is honestly `partial`: authorized memory exports and
consistent authority watermarks are separate requirements.

Restore: `brain restore <archive>` into a fresh data directory (never overwrites),
verifies first, then on first open revokes all old sessions, runner credentials,
tokens, grants, approvals and unused permits; quarantines runners; suspends workspace
execution; blocks queued jobs; marks active attempts outcome-unknown; parks pending
deliveries. Workspaces stay `restore_pending` until controlled reconciliation
completes. Nothing old silently reactivates.

### AF-10 Reset an instance

`rtk pnpm brain reset` requires terminal confirmation (`--yes` for explicitly
unattended use). Erases accounts, workspaces, releases, runs, artifacts,
conversations, model settings, credentials and logs. The next start creates a fresh
administrator and populated workspace. The checkout, sandbox images, backups and
unrelated files are preserved; external effects already applied are not undone.
Reset refuses linked paths, external managed directories, unresolved processes and
active Governor writers; it operates only on a registered local instance.

### AF-11 Deploy the reference topology

`deploy/reference/` describes the separate Governor/runner trust boundary:
`compose.core.yaml` (Governor, SQLite/CAS volumes, memory service),
`compose.runner.yaml` (runner and trusted launcher on a separate host/trust domain),
`deploy/sandbox.Dockerfile`. The runner never receives the launcher socket; the
launcher independently enforces cgroup, egress and mount profiles. No `latest` tags;
pin sandbox images by digest (`BRAIN_LAUNCHER_IMAGE_DIGESTS`) before production use.
The files fail interpolation when required settings are absent — intentional.
Plaintext HTTP and the launcher socket must never face an untrusted network.

### AF-12 Verify the installation

- `rtk pnpm verify:full` — typecheck, boundaries, unit/integration/security/chaos/
  certification/browser suites.
- `rtk bash scripts/verify-operational.sh` — live end-to-end proof: real socket,
  native setup, CLI compile/activate, selected engine, actual output uploads, trusted
  launcher with Docker, all four user/diagnostic starter workflows. Asserts durable run ids, author
  and independent evaluator runners claiming jobs, `succeeded` only with accepted
  evidence, evidence pinning the governed tool release for `operations-triage`, and a
  stable source fingerprint. Fails rather than skips on missing dependencies and
  preserves failure evidence.
- `rtk node --import tsx scripts/verify-local-setup.ts` — proves the guided journey:
  disposable install, default administrator sign-in, live model connect, runner pairing, smoke and
  both starter tasks with verified evidence, a conversation proposal staying inert
  until confirmation, an item-linked task, restart retaining identity/settings/
  enrollment, reset, fresh defaults, and backup/restore suspension behavior.

## 6. Cross-cutting functional rules

State machines (all transitions expected-version checked, audit and outbox written
atomically):

| Machine | States |
|---|---|
| workflow (run) | created → validated → ready → running → succeeded/partial/failed/cancelled; suspended and blocked interleave |
| job | queued → offered → running → verifying → succeeded/failed/partial/cancelled; blocked and outcome_unknown recoverable |
| attempt | offered → running → uploading → verifying → succeeded/failed/partial/cancelled/declined/expired; outcome_unknown only via reconciliation |
| approval | pending → approved/rejected/expired/revoked; approved → expired/revoked; consumption is an immutable ledger entry |
| evidence | assembling → submitted → verified/rejected/incomplete |

Hard guards:

- `job.running → queued` (retry): only a classified retryable failed attempt with no
  unresolved effect, bounded attempts and deadline, backoff and fresh admission.
- `job.outcome_unknown → terminal`: target-specific reconciliation evidence plus an
  accepted verifier or authorized resolution; no generic retry.
- `approval.pending → approved`: current authenticated human with step-up when
  configured, the exact displayed digest, separation of duties, unexpired version.
- `evidence.submitted → verified`: pinned independent evaluator, immutable bytes, all
  required criteria, external effects accepted.

Idempotency and concurrency: every command carries an idempotency key; same key and
payload returns the same resource and receipt; key reuse with changed payload
conflicts; keys are actor-namespaced. Item moves and similar mutations use optimistic
version checks and return the current version on conflict.

Security invariants: default deny; agents never decide approvals or forge human
context; tenant isolation returns 404 with no leakage; mutations are CSRF/origin
checked; revoked identity cuts sessions immediately; CLI sessions are separate
private state; credentials live in private files (mode 0600), never in code.

Honesty boundaries: structural validation does not establish semantic accuracy of
advice; starter tasks are draft/read-only demonstrations with a local context tool;
the shipped L1 evaluator proves independent checking, not separate physical hosts;
browser suites are not a WCAG audit; the operational proof is not production
connector readiness or third-party certification.

## 7. Acceptance mapping

Every workflow above is covered by an executable proof rather than documentation:
browser suites for UI flows (fixture engine), integration/security scenarios
(`contracts/v1/scenario-catalog.json`) for the edge cases cited, chaos tests for
backup/restore/recovery, and the two live proofs (`scripts/verify-operational.sh`,
`scripts/verify-local-setup.ts`) for the full admin and user journey. The guides in
`docs/howto/` map to the admin workflows AF-01 through AF-12.
