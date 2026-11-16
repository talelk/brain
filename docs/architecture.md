# Brain: architecture

How the model in [model.md](model.md) is built. This is the build contract: code follows
it, and it changes in the same commit as the code. Anything not needed by model.md does
not exist.

Rules for all code: no backward compatibility, no migration code, no feature flags for
old behaviour. A test exists only if it checks behaviour named in model.md or here.
The previous implementation is readable at `~/.cache/brain-old` (tag
`pre-simplification-2026-11-16`); copy a piece only when this document names what it is
for, and strip what the new model does not use.

## 1. Layout

```
packages/contracts/src/   shared types and zod schemas (the only shared package)
  files.ts      brain.toml, agent.toml, tool.toml, Play: zod schemas + parsed types
  api.ts        commands and queries: name, input schema, output type, minimum role
  protocol.ts   runner <-> governor wire types (JobOffer, events, receipts)
  audit-chain.ts hash.ts run-receipt.ts   kept, pure
apps/governor/src/
  main.ts  app.ts (HTTP)  db.ts (SQLite + schema.sql)  events.ts (append + audit chain)
  dispatch.ts  commands and queries: input, role, idempotency, one transaction
  auth/        sign-in (better-auth), members, roles
  workspace/   folders, TOML loading, validation, packs, git commits, snapshots
  tasks/       tasks, Plays to tasks, orchestrator, checks, notes
  attempts/    queue, claim, lease, completion, runner registry, placement
  trust/       approvals, standing approvals, usage ledger, audit service, artifacts (CAS), secrets
  tools/       Brain-run tools (task.*, memory.*, git.open-pr, message.send, ask)
  integrations/ git + pull requests, GitHub webhooks, Teams
  memory/      search index, proposals
  health/      runners, model reachability, backups
apps/runner/   kept; edited for the new protocol, native tools and working copies
apps/launcher/ kept; engine sandbox gains the working-copy mount
apps/web/src/  new app, about eight screens
apps/cli/      small: start, stop, backup, restore, audit verify
packs/         base, software-factory, sre, customer-operations
tests/         unit/ (pure), core/ (governor + fixture runner in-process), browser/
```

One Governor process serves the API and the built web app. State is one SQLite file,
`<data>/brain.db`, plus `<data>/cas/` (content-addressed bytes) and
`<data>/workspaces/<slug>/` (the workspace folders, each a git repository managed with
isomorphic-git), `<data>/instance.key` (encrypts secrets, keys the digests of tokens)
and `<data>/audit/` (the audit signing key). There is no organization level and no
per-workspace database.

## 2. Workspace folder to snapshot

- `workspace/load.ts` reads a folder at its HEAD commit: parses TOML (`smol-toml`),
  validates every file with the zod schemas in `files.ts`, resolves packs (a workspace
  file replaces a pack file of the same path), and checks references: every tool an
  agent names exists; every step's `agent`, `review_by`, `judge` exists; `after` names
  earlier steps and has no cycle; `review_by` and `judge` differ from the step's `agent`;
  an agent's `model` names a `[[model]]`; a standing approval names an existing tool;
  `secret:` references are well formed. A step that reads `steps.<id>.result` (in its
  goal, `when` or `for_each`) waits for that step through `after`.
- A pack is a folder `packs/<name>/` with `pack.toml` (`name`, `description`,
  `requires = [...]` naming other packs, which are pulled in with it) and the same
  `agents/`, `tools/`, `plays/`, `memory/` layout as a workspace. `packs/README.md`
  documents the conventions the shipped packs rely on.
- In a step, `goal` may contain `{{<input name>}}` and `{{steps.<id>.result}}` (or a
  field of a JSON result, `{{steps.<id>.result.<field>}}`); `when` is one comparison
  over such a value (`==`, `!=`, with a string, number or boolean); `for_each` names a
  list in an earlier step's JSON result (`steps.<id>.result.<field>`), and inside that
  step `{{item}}` (or `{{item.<field>}}`) is the current item.
- The result is a **snapshot**: one JSON manifest (models, limits, projects, agents with
  prompt text digest, tools with file digests, Plays, memory entry list, approvals
  settings) whose bytes go to the CAS. Its sha256 is the snapshot digest. Same folder
  content gives the same digest.
- Every task stores the snapshot digest it was created with; its sub-tasks and attempts
  use that digest. Editing the workspace never changes work already created.
- An invalid folder is never activated: `file.write` validates the would-be folder first
  and refuses with the path and message of each problem. The workspace keeps its last
  valid snapshot as `active`.
- A tool's inputs (`[inputs.<name>]` with `type`, `description`, `required`, `enum`,
  `items`) compile to a JSON Schema used to validate calls.
- A tool with `runs = "brain"` is implemented by the Governor (section 7) and has no
  `run.sh`. A tool with `host_command = "<name>"` runs a command the launcher's operator
  declared on the runner host, with the tool's inputs as named arguments; one that
  changes anything must be `effect = "privileged"`. Every other tool has `run.sh`.

## 3. Data (`apps/governor/src/schema.sql`)

Sign-in tables belong to better-auth (users, sessions, accounts, passkeys, two-factor).
Everything else:

| Table | Holds |
|---|---|
| `instance` | key/value: setup state, schema digest, audit key id |
| `workspaces` | id, slug, name, status, active snapshot digest |
| `members` | workspace, user, role (`viewer`, `member`, `admin`); `instance_admins` lists users who may create workspaces and manage runners |
| `snapshots` | digest, workspace, commit, created at |
| `secrets` | workspace, name, encrypted value |
| `tasks` | id, workspace, parent, root, title, goal, agent, state, snapshot digest, origin (Play + step id, `for_each` item), step settings (review_by, max_rounds, target_score, approve, when, candidates, judge), round, result, needs (why it needs a person), timestamps, version |
| `task_deps` | task, the task it waits for |
| `notes` | the shared board of a root task: author, text |
| `attempts` | id, task, kind (`work`, `plan`, `check`, `judge`, `act`), agent, state, round, candidate, runner, engine, fence, lease and offer expiry, retries, payload, result, failure, receipt, working-copy artifact, base commits |
| `attempt_events` | ordered events of an attempt (engine text, native tool calls, usage) |
| `tool_calls` | every workspace-tool and Brain-tool call: attempt, tool, effect, input, input digest, output, outcome, approval. A `task.ask` call keeps the person's answer in its output |
| `approvals` | task, attempt, tool, subject JSON and its digest, state, standing flag, expiry, who decided, reason, version |
| `standing_uses` | workspace, tool, day, count |
| `checks` | task, round, by (agent or person), the attempt whose result was checked, pass (after the target score), score, findings |
| `usage` | one row per attempt: reserved, metered (by the model gateway) and settled cost, tokens, model, agent, day |
| `artifacts`, `artifact_links` | CAS entries and what they belong to (task, attempt) with a name |
| `events` | the audit chain: sequence, type, subject, payload and its digest, actor, previous and chain digest |
| `audit_keys`, `audit_checkpoints` | signing keys and signed checkpoints |
| `runners`, `runner_tokens`, `runner_challenges` | enrolled runners, their key, capabilities, engines, slots, last seen |
| `triggers` | per workspace and Play: schedule state (next run) and webhook bindings |
| `webhook_deliveries` | received deliveries, de-duplicated |
| `pull_requests` | task, project, branch, address, number, state when opened |
| `memory_index` (FTS5), `memory_proposals` | search over `memory/`; proposed entries awaiting a person |
| `idempotency` | actor, key, command, request digest, stored response |

Every state change goes through `events.append(...)` in the same transaction as the
change; that function extends the hash chain (`audit-chain.ts`). There is one chain.

## 4. API (`packages/contracts/src/api.ts`)

`POST /v1/command {type, input, idempotencyKey}` and `POST /v1/query {type, input}`.
Each entry declares a zod input schema, an output type and the minimum role. The web app
imports the same definitions for types. `GET /v1/events` is server-sent events: one
`changed` frame per workspace when anything changed (the client refetches).
`GET /v1/artifacts/:digest` streams bytes to a member of the owning workspace.

Commands: `setup.create`, `workspace.create`, `workspace.archive`, `workspace.stopAll`,
`file.write`, `file.delete`, `secret.set`, `secret.delete`, `member.set`,
`member.remove`, `task.create` (a goal, optionally a Play and inputs), `task.confirm`
(accept a proposed plan), `task.edit` (change, add or remove sub-tasks not yet started),
`task.stop`, `task.retry`, `task.check` (a person's check or sign-off), `task.answer`,
`approval.decide`, `memory.decide`, `runner.token`, `runner.remove`.

Queries: `setup.status`, `me`, `packs.list`, `workspace.get`, `workspace.files`,
`file.read`, `today`, `tasks.list`, `task.get`, `task.events`, `approvals.list`,
`approval.get`, `usage.summary`, `memory.list`, `members.list`, `secrets.list` (names
only), `runners.list`, `health`, `audit.verify`.

Roles: `viewer` reads; `member` also creates and steers tasks, answers, checks and
decides approvals; `admin` also writes files, secrets and members. A person never
approves a call or checks a result of a task they are not a member for; the agent that
produced a result never checks it.

An answer is `{output}`, or `{error: {code, message, problems?}}` with the matching HTTP
status. Besides the three workspace roles an entry is `public` (`setup.status`,
`setup.create`, `me`) or needs an instance admin (`workspace.create`, `packs.list`,
`runner.token`, `runner.remove`, `runners.list`, `audit.verify`). Every other entry takes
`workspaceId`; a person who is not a member is told the workspace does not exist.
`file.write` and `file.delete` take several paths and make one commit. Accounts are made
by `setup.create` and by `member.set` (with a name and a first password for a person who
has none); signing up from outside is closed. The answer of `runner.token` is shown once: it is not kept for
idempotency, and the same key sent again is refused.

## 5. Tasks and orchestration (`tasks/`)

States: `waiting` (has unfinished prerequisites), `ready`, `running`, `needs_you`,
`done`, `failed`, `stopped`.

- `task.create` with a Play makes the root task (`running` while its steps do) and one sub-task per step. A `for_each`
  step is a task that groups its copies: they are made when the step it reads from is done, one per item, each waiting
  for what the step waits for; the group's result is the list of its copies' results. Without a Play it queues a `plan`
  attempt for the `planner` agent, whose result is a list of sub-tasks (`title`, `goal`, `agent`, `after`) and a summary
  (kept as the first shared note); the root then needs a person to confirm, unless `confirm_plans = "auto"`. A plan that
  cannot be read, or names an unknown agent, fails the root, which can be retried.
- A step's goal is filled in when its task becomes `ready` (inputs and items are already shown while it waits). A goal a
  person rewrote with `task.edit` is kept as they wrote it.
- The orchestrator runs after every change and on a timer. For each workspace it makes `ready` every `waiting` task
  whose prerequisites are `done` and whose `when` holds (a task whose `when` is false is `done` with result `skipped`),
  and queues a `work` attempt for each `ready` task while fewer than `running_tasks` tasks have work queued or running.
  A task is `running` from the moment a runner claims its work.
- A `work` attempt's result moves the task to checking: a `check` attempt for `review_by` (or the base pack's `checker`
  when the step names none) receives the goal, the result, the tool calls and the working-copy diff, and returns
  `{pass, score?, findings}`. Pass (and `score >= target_score` when set) continues; otherwise the task is queued again
  with the findings while `round < max_rounds` (default 2), and after that it is `needs_you`. When the checker would be
  the agent that produced the result, when the workspace has no such agent, or when the checker's answer cannot be read,
  a person checks. A person's pass is final; a person's "no" starts another round with their findings.
- `candidates = N` (or a list of agents) queues that many `work` attempts in separate working copies; a `judge` attempt,
  or a person when `judge = "person"`, keeps one. A judge answers `{"keep": <attempt id, or position from 1>, "findings"}`.
  The judgement is the check of the kept result, unless the step also names `review_by`.
- `approve = true` makes a passed task `needs_you` for a person's sign-off before `done`.
- A task that groups sub-tasks is `done` when all of them are `done`; its result is the result of its last sub-task that
  was not skipped. A `failed` or `stopped` sub-task makes its parent `needs_you` with retry, edit or stop.
- A sub-task an agent adds with the `task.create` tool belongs to the calling task, which waits for it: when the calling
  attempt ends, the task is `waiting` until its sub-tasks are done and is then run again with their results. A
  `task.ask` question makes the task `needs_you` when the attempt ends; the answer is in the context of the next attempt.
- `task.edit` adds, changes and removes sub-tasks of a task that groups them, as long as the sub-task has no attempt yet.
  `task.stop` stops a task and everything under it (attempts end, pending approvals expire); `task.retry` brings back a
  task that failed or was stopped, and with it its sub-tasks that did.
- Each task receives as context: its goal, the results of the tasks it waits for (the copies of a `for_each` step each
  on their own), the shared notes of its root, the answers to its questions, what happened to it before (findings of
  failed checks, the outcome of calls a person decided after an attempt ended), the names and descriptions of the
  workspace's agents, tools and Plays, and the workspace's memory through `memory.search`.
- An attempt that fails for an infrastructure reason (runner lost, lease expired, model refusal) is retried up to three
  times, after 5, 20 and 80 seconds, before the task fails. An `act` attempt is never retried on its own.
- The decisions are pure functions over plain data (`tasks/decide.ts`); `tasks/orchestrator.ts` reads the facts and
  writes what they decide.

## 6. Attempts and runners (`attempts/`, `protocol.ts`)

Runner routes under `/runner/v1`: `enroll`, `challenge`, `hello`, `heartbeat`, `claim`,
`attempts/:id/ack`, `renew`, `events`, `artifacts`, `tool-call` (ask to run a workspace
tool with an effect), `approvals/:id` (poll a pending approval), `brain-tool` (run a
Brain-run tool), `secret` (lease a named secret for a tool), `model-token`, `complete`,
and `blobs/:digest` (snapshot manifest, prompts and tool files).

- A request is JSON and is answered with the response type of `protocol.ts` as JSON; a refusal is `{error: {code,
  message}}` with its status. Everything after `hello` carries the session token as a bearer credential; an attempt
  route names the fence it was offered, and `LEASE_LOST` (409) says the attempt is no longer that runner's.
- Enrolment: a one-use token (15 minutes); the runner registers an ed25519 public key and proves it by signing a
  challenge. `hello` answers a session token (12 hours; only keyed digests of tokens are stored). `hello` and `heartbeat`
  (every 10 s; a runner silent for 45 s is not online) report capabilities (plain names the operator declares, such as
  `bash`, `python3`, `curl`, `docker`, plus `native-tools` when engines run sandboxed), engines, and free slots. A tool's
  `needs` are matched against them. There are no runner groups: any runner whose capabilities and engines fit may take
  an attempt (an agent with `native` other than `none` needs `native-tools`; an `act` attempt needs only what its tool
  needs). `heartbeat` answers the attempts the runner should stop.
- `claim` picks the oldest queued attempt this runner fits, fairest workspace first (fewest running), and leaves out a
  workspace with `running_tasks` attempts offered or running, or whose spend of the day plus what the attempt's agent
  may spend would pass the daily cap. It returns a **JobOffer** and reserves the agent's `spend_usd` in `usage`. An
  offer not acknowledged in 30 s is taken back; `ack` starts a 60 s lease that `renew` extends (`renew` answers `stop`
  for an attempt whose task was stopped); an expired lease requeues the attempt, and its next offer moves the fence.
- JobOffer: attempt id, fence, kind, task (id, title, goal, round, prior findings), context (prerequisite results, notes,
  answers, catalog, and for `check` and `judge` the results under review with their tool calls and patches), snapshot
  digest, agent (prompt digest, engine list, native level, limits, tool names), tools (per tool: effect, input schema,
  file digests, network hosts, secret names, `runs`, `host_command`), projects (name, repo, branch, access, setup,
  network, credential secret name, base commit), inherited patches and the task's own earlier patch (section 8), model
  (gateway URL, route name), and for `act` the approved call to run.
- `events` appends to `attempt_events`; a `tool.call` and its `tool.result` also record the call in `tool_calls`.
  `artifacts` stores bytes in the CAS, linked to the attempt and its task. `blobs/:digest` serves only what the
  snapshots of the attempts the runner holds name (manifest, prompts, tool files) and what their offers named.
  `secret` leases only a secret a tool of the attempt's agent declares, or the credential of a project.
- `complete` carries the result text, optional structured output, usage, the working-copy patch artifact, the base
  commits, and a receipt signed with the runner's key over the attempt id, fence, snapshot digest and result digest. The
  Governor checks the receipt against the enrolled key and records it in the audit chain. An `act` attempt ends
  `succeeded` with `output {tool, outcome, output}`.
- The model is always reached through the Governor's model gateway, with a token bound to the attempt and its fence
  (`model-token`; valid while the attempt runs): OpenAI-style at `/model/v1/chat/completions`, Anthropic-style at
  `/model/v1/messages`. The gateway forwards to the workspace's models of that kind in order (the agent's own first; the
  next one on 402, 429, a server error or no answer), holds the keys, and adds the token counts and the cost each answer
  reports (`usage.cost`, in dollars) to `usage`. It refuses a call once the attempt has used its agent's `spend_usd` or
  the workspace its daily cap. `brain.toml` holds no prices: where a model server reports no cost, the cost of an attempt
  is what its runner reports at `complete`, and the larger of the two figures is settled.

## 7. Tools

- **Native tools** are the engine's own. The runner enables them at the agent's `native`
  level and only when the engine runs in its sandbox (or is the fixture). Their calls
  are recorded as attempt events.
- **Workspace tools** with `run.sh`: the runner fetches the files by digest, validates
  the input against the schema, and runs the script in a tool sandbox with the task's
  working copy mounted read-only at `/work`, the declared hosts on the egress proxy and
  the declared secrets leased for that call. `effect = "read"` runs at once.
- **Effects** (`write`, `privileged`): the runner posts the call to `tool-call`. The
  Governor builds the approval subject (tool, digest of the tool's definition, input and its digest, task,
  snapshot digest, and for a pull request the patch digest). If a standing approval in
  the snapshot covers it (the call names at least one target among its string inputs and every
  string input is a listed target, under `per_day` for the UTC day, up to and including `until`)
  it is approved at once and counted. Otherwise an approval is pending and the task shows in
  `needs_you`; the runner waits up to ten minutes. Approved in time: the call runs and
  the attempt continues. Otherwise the agent is told the call is held, the attempt ends
  `held`, and when a person approves, an `act` attempt runs exactly that call and the
  task is queued again with the outcome. A rejection queues it again with the reason. A
  pending approval nobody decides in seven days, or whose attempt ended otherwise, expires:
  the call did not happen.
- An approval decision must carry the subject digest the approver was shown; a decision
  on a changed subject is refused. The requester of a task may approve; the deciding
  person must be a `member` or `admin` of the workspace.
- **Brain-run tools** (`runs = "brain"`), executed by the Governor as the attempt:
  `task.create` (add a sub-task), `task.note` (write the shared board), `task.ask`
  (question to a person: it returns `{"status": "waiting"}`, the attempt ends, the task is
  `needs_you`, and the answer is in the context of the next attempt), `memory.search`,
  `memory.propose`, `git.open-pr` (effect `write`), `message.send` (Teams; effect
  `write`). A Brain-run call with an effect answers `pending` until its approval is decided;
  the runner then sends the same call again.

## 8. Runner on disk and working copies

```
<runner state>/
  runner.key.pem  credential
  blobs/<digest>                       cached snapshot files
  repos/<workspace>/<project>.git      bare mirror, fetched with a leased credential
  attempts/<attempt>/work/<project>/   working copy at the project's branch head
  attempts/<attempt>/state/            engine state
  attempts/<attempt>/out/              files the agent wants kept as artifacts
```

- On `ack` the runner fetches each project mirror and creates the working copy at the
  recorded commit. It then applies, in order, the working-copy patches of the tasks this
  one waits for and the task's own patch from an earlier attempt, and runs the project's
  `setup` inside the sandbox. A patch that does not apply fails the attempt with the
  conflicting paths, and the task needs a person.
- Inside a sandbox the paths are `/work/<project>`, `/out` and `/state`.
- The engine sandbox mounts `work/` (read-write for `native = "all"`, read-only for
  `"read"`, absent for `"none"`), `state/` and `out/`. Its network is the egress proxy
  with the model gateway, the project `network` hosts, and nothing else.
- At the end the runner uploads `git diff` of each project (including new files) as the
  task's working-copy patch, and everything in `out/` as artifacts. The base commit of
  each project is recorded on the attempt.
- A task's patch holds only what that task changed, on top of the patches it started from. An offer names the patches
  of every task the task waits for, directly or through another, oldest first; every task of one goal works on the
  commit the goal's first attempt found (or the head of the pull request that started it).
- `git.open-pr`: the Governor stores the whole change as one patch (the inherited patches, then the working copy the
  runner uploaded before the call), which is what the approver is shown and what the approval is bound to. Once
  approved it clones the project at the base commit (isomorphic-git), applies the patch (`integrations/patch.ts`),
  commits, pushes branch `brain/<task id>` with the project's credential (the workspace's `[github]` credential when the
  project names none), opens the pull request through the GitHub API and records it. A task that opens its pull request
  again moves the branch; the pull request it already has follows. Nothing merges.

## 9. Triggers and integrations

- `[trigger] schedule = "<cron>"` starts the Play at each time, in the Governor's local time (five fields; lists,
  ranges and steps). Missed times are not replayed (a time more than five minutes past is missed); an occurrence is
  skipped while the previous one is still running.
- `[trigger] webhook = "github.<event>"` starts the Play for each matching delivery of a
  project's repository, with the delivery as the Play input named `delivery`.
  `POST /hooks/github/:workspace` (the workspace's address or id) verifies the signature with the workspace's
  `[github] webhook_secret`, and takes a delivery (`X-GitHub-Delivery`) once. `github.<event>` matches the event,
  `github.<event>.<action>` one action of it. A task started by a pull request delivery works on that
  pull request's head commit instead of the branch head.
- `[teams] webhook` receives a card when a task needs a person and when a root task is
  done or failed; `message.send` posts to it. Cards are sent from the audit log, from where the last one stopped, so a
  restart neither loses nor repeats one.
- Health: `GET /health/ready` answers when the process and its database do. The `health` query reports runners, whether
  each model's server answers (asked at most once a minute), the audit log's verification, and the time of the last
  backup: the modification time of `<data>/backup.marker`, which the backup command leaves.

## 10. Web app (`apps/web`)

SolidJS, Vite, the `@talelk/newui-*` design system, English, French and Arabic (RTL).
Screens: sign-in and first-run setup; **Today** (goal box, needs you, running, recent
results, spend); **Tasks** and one **Task** page (steps, result, check, evidence, cost,
approvals, notes, pull requests); **Workspace** (agents, tools, Plays, memory, projects,
settings: the files, with forms and a raw editor); **New workspace** (packs, repository,
first goal); **Health** (runners, model, audit, backups); **People and secrets**.

## 11. Tests

- `tests/unit`: file schemas and folder validation (valid and each kind of invalid),
  snapshot determinism, pack override, orchestration decisions as pure functions, the
  approval subject digest, the audit chain.
- `tests/core`: a Governor in a temp directory plus an in-process runner on the fixture
  engine. Each of the twelve patterns as a Play; done requires a check by another agent;
  effect approval (fast path, held path, rejection, standing approval and its limits,
  changed-subject refusal); daily cap; lease expiry and retry; roles; working copy and
  pull request against a local bare repository.
- `tests/e2e`: the real runner on its fixture engine against the Governor in one process: a pipeline to a checked
  result, a native edit that leaves as an approved pull request, a held call carried out later.
- `tests/browser`: first-time user from empty install to a checked result; approving a
  call; editing an agent; creating a workspace from a pack.

`pnpm verify` = lint, typecheck, unit, runner, core and e2e tests, and `scripts/complexity.mjs`,
which fails when tables, commands plus queries, glossary terms, step fields or screens exceed the
budget written in `docs/complexity.json`.
