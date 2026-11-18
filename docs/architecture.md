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
  auth/        sign-in (better-auth), members, roles, users, groups, invitations
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
apps/web/src/  new app, nine screens
scripts/       brain.ts (`pnpm brain`: start, stop, status, logs, runner, backup, restore, audit-verify), deploy-demo.sh
deploy/        the sandbox images; demo/ (the demo host's compose file, host commands and backup units)
packs/         base, software-factory, sre, customer-operations
tests/         unit/ (pure), core/ (governor + fixture runner in-process), browser/
```

One Governor process serves the API and the built web app. State is one SQLite file,
`<data>/brain.db`, plus `<data>/cas/` (content-addressed bytes) and
`<data>/workspaces/<slug>/` (the workspace folders, each a git repository managed with
isomorphic-git), `<data>/instance.key` (encrypts secrets, keys the digests of tokens)
and `<data>/audit/` (the audit signing key). There is no organization level and no
per-workspace database.

There is no separate command-line program. `pnpm brain start` runs one Brain on a machine: it builds the web
app when it is stale, starts the Governor on `~/.local/share/brain/data` and port 3100, the launcher when
Docker answers, and one runner, which enrols by itself (section 6). `BRAIN_PROFILE=fixture` runs every agent on
the fixture engine instead, with no Docker and no model. `scripts/brain.ts` lists the commands and the
environment; `Dockerfile` is the Governor alone, serving the built web app, for a host that runs it in a container.

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
- **Pins and releases.** An entry of `packs` is `<name>` (the shipped baseline in `packs/` of the repository) or `<name>@<n>` (release `n`,
  `n >= 1`; one pin per pack, and it must be released). A released pack is read from `<data>/released/<name>@<n>/`, written once by `pack.release`
  and never changed; its own `requires` and any pack the workspace does not pin are the baseline. The manifest keeps `packs` as names and
  adds `pins` (`{name: n}`, left out when empty), so the same folder and the same releases always give the same snapshot digest. `workspace.get`
  carries `updates` (`{pack, pinned, latest}` for each pack used whose newest release is above its pin, the baseline being 0) and `overview` a count;
  nothing changes a pin but a write of `brain.toml`.
  **Releasing** is the command `pack.release` (an admin of the admin workspace): it reads `packs/<name>/` of the admin workspace's folder, sets its
  `pack.toml` `version` to the last release plus one, checks that a workspace using that content is valid, writes `<data>/released/<name>@<n>/`, commits
  the version (`Release <name> n`) and tags the commit `<name>@<n>` (the audit event `pack.released`). At start `reconcile` rewrites a released
  directory that is missing from its tag. The commit that makes a workspace the admin workspace also writes `packs/<name>/` for every shipped pack.
- In a step, `goal` may contain `{{<input name>}}` and `{{steps.<id>.result}}` (or a
  field of a JSON result, `{{steps.<id>.result.<field>}}`); `when` is one comparison
  over such a value (`==`, `!=`, with a string, number or boolean); `for_each` names a
  list in an earlier step's JSON result (`steps.<id>.result.<field>`), and inside that
  step `{{item}}` (or `{{item.<field>}}`) is the current item.
- The result is a **snapshot**: one JSON manifest (time zone, models with their prices, limits, projects, agents with
  prompt text digest, tools with file digests, Plays, memory entry list, documents, approvals
  settings) whose bytes go to the CAS. Its sha256 is the snapshot digest. Same folder
  content gives the same digest.
- Every task stores the snapshot digest it was created with; its sub-tasks and attempts
  use that digest. Editing the workspace never changes work already created.
- An invalid folder is never activated: `file.write` validates the would-be folder first
  and refuses with the path and message of each problem. The workspace keeps its last
  valid snapshot as `active`.
- A **document** is any other file of the folder (`docs/handbook.md`, `docs/logo.png`). A path is refused when it is
  absolute, has a backslash or control character, a `..` or `.` segment, or a hidden segment other than the file
  `.gitkeep`; a path under `agents/`, `tools/`, `plays/` or `memory/` must still be one Brain reads (`memory/<name>.fr.md` and `.ar.md` are translations of an entry: kept in the manifest as `titles`, never indexed or offered), and
  `brain.toml` is the only file at the top that is not a document. The manifest lists the text and Markdown
  documents under `docs/` (`.md`, `.markdown`, `.txt`, `.rst`, `.csv`, `.json`, `.yaml`, `.yml`, valid UTF-8, at most 1 MB) with `path`,
  `title` (the first `# ` line, else the file name), `digest` and `bytes`, so a task keeps the documents of its own
  snapshot. Other documents are only in git.
- **Platform workspaces** (docs/model.md): `platform = "admin"` or `"read"` in `brain.toml` is carried by the manifest as `platform: "admin" | "read"`
  (left out when there is none, so no other workspace's digest changes). It is invalid with `visibility = "public"`, and a workspace that
  lists the pack `platform` without it is invalid. The guard is one check inside `commitFolder` (`workspace/platform.ts`), before
  anything is committed, so every way of writing the folder meets it (`file.write`, `file.delete`, a copy or a move, the
  settings form, `workspace.fix`, `workspace.create`): a change that adds, changes or removes `platform` is refused with FORBIDDEN unless
  `FolderChange.instanceAdmin` is true (a command's caller; `workspace.create` is itself instance-admin only; a fix is never),
  and a second `admin` workspace is refused with CONFLICT (any number are `read`). `access.ts` answers nothing for a person who is not an instance
  admin in a workspace whose active manifest has `platform`, member or not, which hides its tasks, results, files and approvals
  from everything that asks (dispatcher, `me`, `overview`, events, downloads). Pack management exists only in the `admin` workspace: only it is
  seeded with `packs/`, may `pack.release` or ask `pack.files` for `working`, and only its releases are read for a pin `base@N`. In a `read`
  workspace a `packs/...` file is an ordinary document: stored, never read as a pack source, a pin or a release.
- **The folder's remote**: `[git] remote` (an http or https address with no user or password) and an optional `credential` (the workspace's
  GitHub credential when absent) are carried by the manifest as `git` (left out when absent) and may not be changed by `workspace.fix`.
  `gov.onActivate` asks `workspace/push.ts` for a push of every activated snapshot of a workspace that has a remote; it runs after the
  transaction (`setImmediate`), one at a time per workspace, with isomorphic-git over `gov.fetch`, the branch the folder is on to the same branch
  of the remote, never forced (so the first push initialises an empty remote and one that has moved on is refused). Its result is the audit event
  `workspace.pushed` or `workspace.push_failed` (the remote without credentials in it, the commit, and the error with any secret removed): there is
  no table and no failure reaches the commit. `workspace.get` (`folderPush`) and `health` (`folderPush`) read the last of these events; Settings and Health show it.
- **The address of a workspace** is `slugify(name)` (accents dropped, anything that is not a letter or digit one dash; `packages/contracts/src/slug.ts`, imported by the web app too), or the given `slug` read the same way. `workspace.create` refuses, with CONFLICT on the path `name`, an address any workspace (archived too) already has; it never numbers. The wizard checks the same against what it already knows and, when the Governor refuses, takes the person back to the name.
  A first project's name comes from the last part of its address and its branch from the repository itself (`git.getRemoteInfo`, at most three seconds, with the typed token), else `main`.
- A tool's inputs (`[inputs.<name>]` with `type`, `description`, `required`, `enum`,
  `items`) compile to a JSON Schema used to validate calls.
- A tool with `runs = "brain"` is implemented by the Governor (section 7) and has no
  `run.sh`. A tool with `host_command = "<name>"` runs a command the launcher's operator
  declared on the runner host, with the tool's inputs as named arguments; one that
  changes anything must be `effect = "privileged"`. Every other tool has `run.sh`.

## 3. Data (`apps/governor/src/schema.sql`)

Sign-in tables belong to better-auth (users, sessions, accounts, verifications, rate limits).
Everything else:

| Table | Holds |
|---|---|
| `instance` | key/value: setup state, schema digest, audit key id |
| `workspaces` | id, slug, name, status, active snapshot digest |
| `members` | workspace, user, role (`viewer`, `member`, `admin`); `instance_admins` lists users who may create workspaces and manage runners |
| `groups`, `group_members`, `group_grants` | a named set of users and the role it gives on a workspace (`group_grants`); `access.ts` takes the highest of a person's own and their groups' roles |
| `invitations` | invitation and password-reset links: kind, email (a reset: the user), keyed digest of the one-use token, what it grants, state, creator, expiry |
| `deactivated_users` | users who cannot sign in; their rows and history stay |
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
| `memory_index` (FTS5), `memory_proposals` | search over `memory/` entries and the manifest's documents (a document's `name` is its path); proposed entries awaiting a person |
| `idempotency` | actor, key, command, request digest, stored response |

Every state change goes through `events.append(...)` in the same transaction as the
change; that function extends the hash chain (`audit-chain.ts`). There is one chain.

## 4. API (`packages/contracts/src/api.ts`)

`POST /v1/command {type, input, idempotencyKey}` and `POST /v1/query {type, input}`.
Each entry declares a zod input schema, an output type and the minimum role. The web app
imports the same definitions for types. `GET /v1/events` is server-sent events: one
`changed` frame per workspace when anything changed (the client refetches).
`GET /v1/artifacts/:digest` streams bytes to a member of the owning workspace.

Commands: `setup.create`, `workspace.create` (its input may carry `platform: "admin"` or `"read"`, a first project, and `folderRemote`, all kept in the first `brain.toml`; defaults are not written), `pack.release`, `workspace.archive`, `workspace.stopAll`,
`file.write`, `file.delete`, `secret.set`, `secret.delete`, `member.set`,
`member.remove`, `task.create` (a goal, optionally a Play and inputs), `task.confirm`
(accept a proposed plan), `task.edit` (change, add or remove sub-tasks not yet started),
`task.stop`, `task.steer` (a task's priority and pause), `task.retry`, `task.check` (a person's check or sign-off), `task.answer`,
`approval.decide`, `memory.decide`, `runner.token`, `runner.remove`; and for users (docs/model.md, Users, invitations and groups) `user.invite`, `invitation.revoke`, `invitation.accept` (public: it redeems an invitation or a reset link), `user.set` (instance role, active), `user.resetLink`, `session.revoke` (the caller's own, or any person's for an instance admin), `profile.set` (name, password), `group.set`, `group.delete`.

Queries: `setup.status`, `me`, `packs.list`, `workspace.get`, `workspace.files`,
`file.read`, `pack.files`, `today`, `overview`, `schedules.list`, `tasks.list`, `task.get`, `task.events`, `approvals.list`,
`approval.get`, `queue`, `insights`, `usage.summary`, `memory.list`, `members.list`, `secrets.list` (names
only), `runners.list`, `health`, `audit.verify`, `users.list` (instance admin: one page of people and pending invitations, searched and filtered on the server, with the counts, and the groups), `user.get` (oneself, or any person for an instance admin: sessions, sign-in log, access matrix). `overview` takes no workspace: for the active
workspaces the caller is a member of it answers per-workspace counts (needs you, running, done and
failed today), spend against the cap, projects, last activity and a dense 14-day series (UTC days, oldest
first) of goals done and spend; one list of up to 50 tasks waiting for a person (each with its workspace
and, for a call, the approval itself) and one of the 30 attempts running now; and, for an instance admin
only, runners online, models reachable and the audit chain. It is declared `public` like `me` and answers
UNAUTHENTICATED without a session; a person never sees a workspace they are not in. A client refetches it on
any `changed` frame, since the stream already carries every workspace of the caller.

`insights` (declared `public` like `queue`: UNAUTHENTICATED without a session, only workspaces the caller sees, or the one named) takes
`days` (7, 30 or 90) and `timeZone` (the caller's IANA time zone, so days and hours are theirs; the offset is taken at every instant of the window, so a daylight-saving change inside it is exact: `tasks/zone.ts`) and answers, in one pass of grouped SQL over `tasks`, `attempts`, `usage`, `tool_calls` and `approvals` (reached through
`tasks_workspace_updated` and `attempts_task`, so no new index): the calendar and weekday-by-hour counts, the per-day outcomes, the top
eight by time and by money for workspace, agent and Play with a per-day series, tools by calls and time, p50 and p90 (nearest rank, by window functions) of goal
duration per Play, attempt duration per agent and queue wait per day, the failed tasks bucketed by the reason of their last attempt (up to five of each
listed) and repeated work (same Play and inputs, or same words, started more than once). The result is kept in memory for the minute of the Governor's clock,
under the caller's visible workspaces, the window and the offset. The Timeline needs no query: `task.get` already carries every attempt, approval, call and check of the goal's tree.

`packs.list` also says, for each pack, the working `version` and whether the platform workspace's copy differs from its last release (`working`, when the platform
workspace holds a copy), its `released` versions and `usedBy` (workspace address, name and pin). `pack.files` (an admin of the workspace) answers the text of
the files of a pack at `shipped`, a released number or `working`: the admin workspace may ask for any pack and `working`; another workspace only for a
pack it uses, at the baseline or a release (which is how its admin reads the difference before an update).

`schedules.list` takes no workspace, like `overview`: for every active workspace the caller can see it answers each
Play with a trigger: the workspace and its time zone, the Play's title and steps (id and agent), the trigger (`schedule`
or `webhook`, `paused`), and for a schedule the next time the Governor will start it (the `triggers` row's
`next_run_at_ms`; none when paused) and the last start with the state of the task it made (`last_task_id`; a webhook's
last start is the latest goal of that Play a trigger made). A schedule whose previous task still runs says its next time will be
skipped. `workspace.files` is built from the folder's file list and the packs' files, not from a full load of the folder: it
gives each file's size, source and, for a workspace file, the last commit that changed it (one pass over the history,
kept per head commit). `file.read` and the download route read that one file.

Visibility: `brain.toml` `visibility` (`private`, the default, or `public`) is carried by the snapshot. One function
(`access.ts`) answers a person's role in a workspace and is used by the dispatcher, `me`, `overview`, the events stream, the
file download and artifact downloads: a member has their role; otherwise a person signed in has role `viewer` in an
active workspace whose active snapshot is `public`; otherwise the workspace does not exist for them. Every command needs
`member` or more, so a public viewer cannot write; `secrets.list` and `members.list` need `admin`. `activate` appends a
`workspace.visibility` event when a change flips it.

Roles: `viewer` reads; `member` also creates and steers tasks, answers, checks and
decides approvals; `admin` also writes files, secrets and members. A person never
approves a call or checks a result of a task they are not a member for; the agent that
produced a result never checks it.

An answer is `{output}`, or `{error: {code, message, problems?}}` with the matching HTTP
status. Besides the three workspace roles an entry is `public` (`setup.status`,
`setup.create`, `me`, `overview`) or needs an instance admin (`workspace.create`, `packs.list`,
`runner.token`, `runner.remove`, `runners.list`, `audit.verify`, and the user entries above except `invitation.accept`, `session.revoke`, `profile.set` and `user.get`, which are `public` and check the caller themselves). Every other entry takes
`workspaceId`; a person who is not a member is told the workspace does not exist.
`file.write` (up to 200 files, 500 removals) and `file.delete` (up to 500 paths) take several paths and make one commit; a copy or a move of files and folders in the Files tab is one such commit. A `file.write` file is text, or
`encoding: "base64"` for a document of any kind; a write may also name `remove` paths, so a rename is one commit.
A file is at most 5 MB and a write 20 MB (decoded), refused with INVALID_INPUT naming the file. `file.read` answers
`binary: true` and no content for a file that is not text, and adds the message and time of the last commit that
changed the file. `GET /v1/workspaces/:id/files/<path>` streams the bytes of a workspace file to a member of the
workspace (anyone else is told it does not exist); it is always an attachment, `nosniff` and `sandbox`, so a
document is never rendered as a page of Brain. Accounts are made
by `setup.create` and by `member.set` (with a name and a first password for a person who
has none); signing up from outside is closed. `setup.create` also makes the first workspace,
named Starter, from the `base` pack with the new person as its admin, so the first screen is
never empty; the pack's `hello` Play is the sample goal. A packs directory without `base`
gets no Starter. Users: `access.ts` gives a person the highest of their own role and their groups' roles; `members.list` also lists the groups with a role in the
workspace, with their people. Invitation and reset links carry a 32-byte token in the address fragment (`/#invite=` and `/#reset=`, so it never reaches a log), stored as a keyed digest,
valid 7 days (a reset 1 day), single use, answered by one refusal whatever is wrong with a token, and redeemed at most 10 times a minute per client address that fail. `auth.user()` answers
nobody for a deactivated user, `session.create` is refused for one, and a refused sign-in of a deactivated account is answered like a wrong password and audited, deactivating or a forced sign-out deletes the sessions and ends the user's
event streams, and every `/api/auth` route but the password sign-in is closed (there are no passkeys or second factor); sign-out is the audited `session.revoke`. An invitation is claimed before its account is made, so a revoke that comes later changes nothing and no account is left half made. The last admin of a workspace is counted through groups as well as `members`. Audit events keep a redacted address (`n***@example.com`), never the address. A person has no
API tokens: a session is the only credential of a person, and runners and attempts use their own. Outgoing mail (`BRAIN_SMTP_URL`, `BRAIN_SMTP_FROM`) is optional and best effort: the connection must be encrypted (`smtps://`, or STARTTLS) unless `BRAIN_SMTP_INSECURE=1`, messages carry Date and Message-ID, and the answer of `user.invite` says only that mail was handed over (`mail: "queued"`); the audit log records whether the server accepted it (`user.mail_accepted`, `user.mail_failed`), never that it arrived. Sign-ins
and failed sign-ins of existing accounts are audit events; refused sign-ins are one row per account in a minute, the rest counted into one more row. The answers of `user.invite`, `user.resetLink` are shown once, like `runner.token`. The answer of `runner.token` is shown once: it is not kept for
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
  and queues a `work` attempt for each `ready` task. `running_tasks`, the daily cap, pauses and priorities are not applied here but at `claim` (section 6), so every
  attempt that waits is a `queued` row and the queue is one list. A task is `running` from the moment a runner claims its work.
- A **priority** (`low`, `normal`, `high`) and a **pause** of a task are the audit event `task.steered` (`{priority, paused}`, the latest of the task wins; the schema has no column for them).
  A task's effective priority and pause are its own, else those of the nearest ancestor that has one. `tasks/queue.ts` reads them and holds the one function that orders the queue.
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
  Its list of changes is one edit: removals apply first, then changes and additions, and only the result is checked
  (every `after` names a sub-task of the same task, none waits for itself), so the order of the list does not matter.
  `task.stop` stops a task and everything under it (attempts end, pending approvals expire); `task.retry` brings back a
  task that failed or was stopped, and with it its sub-tasks that did.
- Each task receives as context: its goal, the results of the tasks it waits for (the copies of a `for_each` step each
  on their own), the shared notes of its root, the answers to its questions, what happened to it before (findings of
  failed checks, the outcome of calls a person decided after an attempt ended), the names and descriptions of the
  workspace's agents, tools and Plays, and the workspace's memory through `memory.search`.
- What the screens read is answered by the Governor, not worked out by the web app. A task summary carries
  `createdByName` (absent for a goal a trigger started), `goalTitle` (the goal it belongs to) and `waitingForYou` (the
  tasks of its tree, itself included, in `needs_you`); a goal with `waitingForYou` above zero is shown as needing a
  person, and `today.running` leaves such goals out. A sub-task of `task.get` also carries its `goal` and `waitsFor`.
  An approval carries `rootTaskId` and `goalTitle`; a note and a pull request carry the `taskId` they belong to.
  `tasks.list` takes `rootsOnly` and `search` (title or goal text, case-insensitive), both applied before `limit`, so a
  page holds the newest matches. A goal started from a Play is titled by the Play and the start of its first text input
  (`Fix an issue: The login page shows…`); a goal a person typed is titled by its first line.
- An attempt that fails for an infrastructure reason (runner lost, lease expired, model refusal) is retried up to three
  times, after 5, 20 and 80 seconds, before the task fails. An `act` attempt is never retried on its own.
- A task that fails (a work or plan attempt ended and no retry is left) is healed (`tasks/heal.ts`), in the transaction
  that failed it, when the active snapshot has a `workspace-healer` agent and `[healing] mode` is `auto`. The heal task is
  a goal with that agent whose `created_by` is `heal:<failed task id>`: that is its only link to the failed task, which is
  what makes "once per task" (no goal with that `created_by` yet), "never a heal task" (the root of the failed task is not
  one) and the daily cap (heal tasks created since 00:00 UTC against `per_day`) plain queries. A failure that every failed
  attempt of the task marks `infrastructure` is not healed and says so in a note of the failed task's goal. The goal text
  holds the evidence, each part cut to a size, and the files of the agents, tools, Play and `brain.toml` involved, read from
  the workspace folder or the pack. `task.get` carries `heal` (the heal task's id, state, result) on the failed task, and a
  task summary carries `heals` (id and title of the failed task) on a heal task, which is how the screens link the two.
- Closing a waiting goal that a newer identical one superseded (`tasks/superseded.ts`, docs/model.md) runs at the end of
  `settle`, so after every change and on its timer, which also visits workspaces whose only open tasks wait for a person.
  Candidates are `needs_you` tasks of kind `check`, `answer`, `approval`, `confirm-plan` or `failed-subtask` whose
  `updated_at_ms` is at least `[cleanup] superseded_after_hours` old. The newer match is a task created later, in
  another goal of the workspace, with the same Play and deep-equal inputs (or, without a Play, the same goal text), and
  for a sub-task the same `step_id`, `item_index`, agent and title (and goal when it has no step), in state `done` or
  `needs_you` with kind `check`. The goal is stopped with `stopTask` only when no task of its tree is `ready` or
  `running` and every `needs_you` task of it is superseded; each stopped task, and the heal goals of any of them, gets a
  `task.superseded` event (`by` the newer task, `byState`, `hours`) in the same transaction. `task.get` and the task
  summaries read the latest such event as `supersededBy`.
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
  challenge. A Governor started with `BRAIN_LOCAL_RUNNER_TOKEN_FILE` writes such a token to that file (owner-only) at
  each start while no runner is enrolled: the runner started beside it on the same machine enrols with no person involved. `hello` answers a session token (12 hours; only keyed digests of tokens are stored). `hello` and `heartbeat`
  (every 10 s; a runner silent for 45 s is not online) report capabilities (plain names the operator declares, such as
  `bash`, `python3`, `curl`, `docker`, plus `native-tools` when engines run sandboxed), engines, and free slots. A tool's
  `needs` are matched against them. There are no runner groups: any runner whose capabilities and engines fit may take
  an attempt (an agent with `native` other than `none` needs `native-tools`; an `act` attempt needs only what its tool
  needs). `heartbeat` answers the attempts the runner should stop.
- `claim` takes the first queued attempt this runner fits in the order of `dispatchOrder` (`tasks/queue.ts`, the same function the `queue` query uses, so the
  screen is the dispatcher's own order): priority (`high`, `normal`, `low`), then the attempt's turn within its workspace at that priority, where the turn counts the
  workspace's offered and running tasks first and then its queued attempts oldest first (this is the round-robin that stops one workspace starving the others), then age (for `high`, the
  task promoted last first). It leaves out a workspace that is paused (`limits.paused`, absent in an older snapshot means false), a paused task, an attempt in its retry
  backoff, a workspace with `running_tasks` (when not 0) distinct tasks offered or running (an attempt of a task that already holds a place is let through), and
  one whose spend of the day plus what the attempt's agent may spend would pass the daily cap. `fits` is `missing` (the engine or capability a runner lacks, or null). It returns a **JobOffer** and reserves the agent's `spend_usd` in `usage`. For an agent `turns`, `tokens` and `spend_usd` of 0 are no cap: the engine is given no turn or token ceiling. An
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
  `tool-call` and `brain-tool` carry the commits the attempt's working copy stands on (`baseCommits`); the Governor
  keeps them on the attempt from the first call, so it knows them before the attempt ends.
- `complete` carries the result text, optional structured output, usage, the working-copy patch artifact, the base
  commits, and a receipt signed with the runner's key over the attempt id, fence, snapshot digest and result digest. The
  Governor checks the receipt against the enrolled key and records it in the audit chain. An `act` attempt ends
  `succeeded` with `output {tool, outcome, output}`.
- The model is always reached through the Governor's model gateway, with a token bound to the attempt and its fence
  (`model-token`; valid while the attempt runs): OpenAI-style at `/model/v1/chat/completions`, Anthropic-style at
  `/model/v1/messages`. The offer names the gateway at the Governor's base address, or at `BRAIN_GATEWAY_URL` where
  sandboxes reach the Governor by another one (the host's address on Docker's bridge, which the egress proxy is told to allow). The gateway forwards to the workspace's models of that kind in order (the agent's own first; the
  next one on 402, 429, a server error or no answer), holds the keys, and adds the token counts and the cost of each
  answer to `usage`: the cost the answer reports (`usage.cost`, in dollars), or else its token counts at the model's
  `input_usd_per_mtok` and `output_usd_per_mtok`. A model with no prices whose server reports no cost records zero, and
  `task.get` marks such an attempt `priced: false`. The gateway refuses a call once the attempt has used its agent's
  `spend_usd` or the workspace its daily cap. At `complete` the larger of the gateway's figure and the runner's is settled.

## 7. Tools

- **Native tools** are the engine's own. The runner enables them at the agent's `native`
  level and only when the engine runs in its sandbox (or is the fixture). Their calls
  are recorded as attempt events. The fixture engine runs no model: it answers from `FIXTURE`
  lines in the texts it is given, or with a default. A runner may let it stand in for
  named engines (`BRAIN_RUNNER_FIXTURE_FOR`), which is how the fixture profile runs the
  packs' agents; such an attempt says its engine was `fixture`.
- **Workspace tools** with `run.sh`: the runner fetches the files by digest, validates
  the input against the schema, and runs the script in a tool sandbox with the task's
  working copy mounted read-only at `/work`, the declared hosts on the egress proxy and
  the declared secrets leased for that call. `effect = "read"` runs at once.
- **Effects** (`write`, `privileged`): the runner posts the call to `tool-call`. The
  Governor builds the approval subject (tool, digest of the tool's definition, input and its digest, task,
  snapshot digest, and for a pull request the patch digest and the commit it is made on). If a standing approval in
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
- `workspace.fix` takes `task`, `files` (`path`, `content`), `message` and `why`. Before it asks for approval the Governor
  checks the paths (`brain.toml`, `agents/`, `tools/`, `plays/`, `memory/`, `docs/`), that the folder would still be valid
  and that `approvals`, `github` and `teams` of `brain.toml` are unchanged, and stores the change as a unified diff whose
  digest is the approval's `patchDigest`; the subject's `baseCommit` is the workspace's commit. A standing approval never
  covers it, only an admin decides it, and it is refused when the workspace's commit is no longer `baseCommit`. When it is
  approved the Governor commits (as `file.write` does, the message ending with the failed task's id), activates the
  snapshot, moves the failed task and its sub-tasks to it and queues the task again (`reviveTask`), in one transaction with
  the call's outcome. A heal task makes one fix.
- **Brain-run tools** (`runs = "brain"`), executed by the Governor as the attempt:
  `task.create` (add a sub-task), `task.note` (write the shared board), `task.ask`
  (question to a person: it returns `{"status": "waiting"}`, the attempt ends, the task is
  `needs_you`, and the answer is in the context of the next attempt), `memory.search`,
  `memory.propose`, `git.open-pr` (effect `write`), `message.send` (Teams; effect
  `write`), `workspace.fix` (effect `write`, for the agent of a heal task and the task it heals, or, with `workspace`, for a task of the admin workspace), and the five `platform.*` tools. A
  Brain-run call with an effect answers `pending` until its approval is decided;
  the runner then sends the same call again.
- **`workspace.fix` in the platform workspace**: a task of the admin workspace that is not a heal task may call it with no failed task. It
  changes only files under `packs/` (any other path is refused), at most 10 proposals a task, each its own approval, decided by an admin of the
  platform workspace; the commit message ends with `Proposed by platform task <id>`. Nothing else differs from a heal's fix, and there is no input
  that names another workspace: no tool writes to a workspace but its own.
- **`platform.*`** (pack `platform`; effect `read`; run in the transaction that records the call): refused unless the calling task's
  workspace is a platform workspace (`admin` or `read`; `platform.tool-drift` only `admin`). Each call that reads another workspace appends a `platform.read` event (workspace = the target;
  payload: source and target addresses, tool, what was read) in that transaction. A value of the target's secrets that appears in
  a returned text is replaced by `[secret]`, no secret is ever read otherwise, and every text is cut to a size. Inputs and outputs are in
  `packs/README.md`. `platform.repeats` reads `tasks`, `attempts` and `tool_calls` of every workspace on `gov.clock`:
  a task counts when it is `done`, was created within the last `days` (30), has a `work` attempt, is not a heal task or a task of
  `workspace-healer`, `capitalizer` or `syncer`. Its job is the agent's name plus the ordered names of its calls that `succeeded`, leaving out
  the board and bookkeeping tools (`task.note`, `task.ask`, `task.create`, `memory.search`, `memory.propose`; a job with no call left is a
  native-tools job and counts too). A goal is normalized to its set of words: lower case, URLs and any word with a digit removed, only
  letters, at least 3 of them, without a short list of English and French stop words. Within one job, tasks are taken oldest first and
  each joins the first group whose first goal shares at least 0.6 of the words (Jaccard) or starts a group. A group of 4 or more is a
  candidate: agent, tools, count, workspaces with their counts, up to 3 goals and 8 task ids, first and last time.
  `platform.tool-drift` compares, for every workspace but the admin one, each tool with a `run.sh`, each agent and each Play whose files are
  the workspace's own (`source = "workspace"` in its snapshot) with the same file in `packs/<pack>/` of the platform workspace's folder:
  `differs` when a file's text is not the same, `new` when no pack has it. A tool with no `run.sh` (Brain-run, host command) is left out.
  Identical copies in several workspaces are one entry listing them; an entry says whether a tool has its `test.sh`, and at most 30 are returned.
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
  The image (`deploy/engine-sandbox.Dockerfile`) carries what a project's `setup` commonly
  needs: node, pnpm, bun, git, and a compiler, make and python3 for native Node modules.
  node-gyp reads the Node headers from the image (`npm_config_nodedir`), so a native build
  needs no host beyond the package registry in the project's `network`.
- Logs: the Governor writes one `key=value` line per event to stdout (`LOG_LEVEL`, default
  `info`): startup, 5xx and unhandled errors with a request id (also the `x-request-id`
  header), runner rejections, model gateway upstream failures, workspace reconciles. A line
  never holds a secret, a prompt or a result. A runner whose Governor is unreachable logs one
  line with the cause code and attempt id, backs off, and logs one line when it reconnects.
- At the end the runner uploads `git diff` of each project (including new files) as the
  task's working-copy patch, and everything in `out/` as artifacts. The base commit of
  each project is recorded on the attempt.
- A task's patch holds only what that task changed, on top of the patches it started from. An offer names the patches
  of every task the task waits for, directly or through another, oldest first; every task of one goal works on the
  commit the goal's first attempt found (or the head of the pull request that started it).
- `git.open-pr`: the Governor stores the whole change as one patch (the inherited patches, then the working copy the
  runner uploaded before the call), which with the base commit is what the approver is shown and what the approval is
  bound to. The base commit is the one the runner names with the call, so a goal's first attempt, which has reported
  none yet, opens its pull request on the commit it worked on and not on wherever the branch is by then. Once
  approved it clones the project at that commit (isomorphic-git), applies the patch (`integrations/patch.ts`),
  commits, pushes branch `brain/<task id>` with the project's credential (the workspace's `[github]` credential when the
  project names none), opens the pull request through the GitHub API and records it. A task that opens its pull request
  again moves the branch; the pull request it already has follows. Nothing merges.

## 9. Triggers and integrations

- `[trigger] schedule = "<cron>"` starts the Play at each time, on the wall clock of the workspace's `timezone` (UTC
  when `brain.toml` names none; five fields; lists, ranges and steps). A time the clock skips when it is set forward does
  not come, and one it shows twice comes twice. Missed times are not replayed (a time more than five minutes past is
  missed); an occurrence is skipped while the previous one is still running.
- `[trigger] paused = true` keeps a schedule in the file without firing it: its `triggers` row stays (so its last start is
  kept) with no next time, and one that is resumed gets its next time again. The cron fields are read by one parser in
  `packages/contracts/src/cron.ts`, used by the scheduler, by `PlayFile` validation (so a schedule that could never fire is
  refused when written) and by the web app's form (live check and the next three times). Only numbers, lists, ranges and
  steps are accepted; day and month names are not.
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
- Backup (`health/backup.ts`, run by `pnpm brain backup [file]`): one `.tar.gz`, readable by its owner only, with a
  consistent copy of `brain.db` taken through SQLite's backup API while the Governor runs, `cas/`, `workspaces/`,
  `instance.key` and `audit/`. `pnpm brain restore <file>` refuses while the Governor runs, checks the database of the
  archive, moves the data that is in place aside (it deletes nothing) and puts the archive's in its place; the Governor
  that starts on it takes up a workspace commit newer than the database copy, as after a crash.

## 10. Web app (`apps/web`)

SolidJS, Vite, the `@talelk/newui-*` design system, English, French and Arabic (RTL).
Text a pack or a workspace wrote for people (`[translations.<lang>]`, `memory/<name>.<lang>.md`; docs/model.md, Translations) is shown through `human()` of `src/i18n`: the page language's text when the file has it, the English otherwise, at every place that shows an agent, tool or Play description, a Play title or input description, a pack description or a memory title (the Schedules list, the Today Play chips, the Team graph and the New workspace packs included). The forms edit the English text and write the translations back untouched, dropping only a translated input the form removed.
The platform workspace is shown with a "Platform" badge in the sidebar and in the Overview table; the New workspace wizard offers the three kinds (ordinary, `read`, `admin`), and the Settings form the same choice, only to a platform administrator (`me.instanceAdmin`); the wizard then adds the `platform` pack. The admin workspace's Workspace screen has a Packs tab (`packs.list` and `pack.files`: each pack's working version, releases, the workspaces using each, the difference between two versions, and Release). Any workspace with `updates` shows an "Update available" badge (Settings, Overview) and, to its admin, the difference (`pack.files`) and "Update to vN", which writes the pin through `file.write`.
First paint: the Governor serves the built files compressed (Brotli or gzip) and caches `/assets` for a year; the page's own chunk downloads beside the questions of who is signed in; a reload paints from the tab's last `me` and asks again behind it; a page that waits shows grey blocks in the shape of its content. On a wide screen a Workspace list opens with its first item selected; a phone keeps the list first.
Frame: `AppShell` with a left sidebar (collapsible to icons, a drawer on phones): Overview, Schedules, then the
workspaces (grouped as My workspaces, Shared with me and Public workspaces, each with an orange count of what waits there; the open one expands to Today, Tasks and
Workspace) and New workspace, Health and People at the foot with the account (Profile, language, theme, sign out); a platform admin also sees a This Brain group with Users.
A **Limits** panel in Settings and in each agent's form lists the limits that apply with their use, their source (agent file, pack, workspace file or default) and a field to change them (`src/components/Limits.tsx` holds the list; the defaults and the retry count are `LIMIT_DEFAULTS` and `MAX_ATTEMPTS` of `contracts/src/limits.ts`, which the web app imports through `@brain/contracts/limits` so no hashing code reaches the browser). An attempt's failure may carry `limit` (`{name, value, used, agent?}`), set by the Governor when an engine reports `reason = "limit"`, when a retry count or the daily cap stopped it; the Task page shows it with **Raise the limit**, a link to the form.
The top bar has the live indicator and search (Cmd-K: pages, workspaces, goals). Screens (fifteen files in
`src/screens`): sign-in and first-run setup (`AuthLayout`); **Overview** (the home: headline numbers, needs
you across all workspaces with the decision in place, what is running, a table of workspaces with week
sparklines, spend and goals per day stacked by workspace, the instance's health); **Today** (goal box, Plays,
needs you, running, recent, spend); **Tasks** (filterable, sortable table with bulk stop) and one **Task**
page (the goal drawn as a graph of its sub-tasks, in columns by what each waits for, or as a **Timeline**, a Gantt of its attempts built by `lib/timeline.ts` (pure: time scale, row and lane packing, critical path) and drawn as SVG, and the record in two panes); **Workspace** (tabs for agents, a
Team graph, tools, Plays, memory, projects, settings, Files: list and form panes over the files, plus a raw editor; Files shows every file of the workspace (its folder and its packs' files, which are read only until a copy is edited) as a tree with sizes and last commits, a list or grid, multi-select with bulk download and delete, and browse, edit, rename, delete and upload to browse, edit, rename, delete and upload documents into, one commit per change; Team draws the agents and
the handoffs between them, read from the Plays' steps and the recent tasks the web app already lists, with no query of its own); **New workspace** (a wizard); **Users** (`/users`, instance admins: the people table with search and filters, Invite people with the copyable link, groups, and a detail drawer with the access matrix, sessions and sign-in log); **Profile** (`/profile`, from the account menu); **Health**;
**Queue** (`queue`, at `/queue` and `/w/<slug>/queue`: runners as lanes with their slots and the attempts in them, then the waiting list in dispatch order with rank, kind, age, the plain-words reason and an estimated start, with priority, Run next, pause and stop for a member; reorders animate with a short FLIP move that `prefers-reduced-motion` turns off; it is read again on every live change; Today and the Overview show a "3 running, 5 waiting" line that links to it, and the sidebar the count waiting); **Insights** (`insights`, at `/insights` and `/w/<slug>/insights`: a 7, 30 or 90 day range; hand-built SVG with the design tokens, no chart library: calendar and weekday-by-hour heatmaps, small multiples of outcomes per day, ranked bars with sparklines, percentiles, queue wait, failure reasons with links, repeated work; every chart has its table behind it and heatmap cells are reached with the arrow keys); **Live** (`/live` and `/w/<slug>/live`: a calm picture of the same data the Overview, the Queue and `tasks.list` already answer, with no query of its own. A flow across the top counts Queued, Running, Checking, Needs you, Done and Failed, the last two over the last hour, with thin ribbons whose width follows the count; the runners are lanes whose slots hold the attempts running now (agent, goal, workspace, elapsed time, a token sparkline the page samples between reads, a ring that fills over ten minutes) and a finished attempt leaves with its result colour; a feed of what just happened is worked out from the tasks' states and times, grouped so a hundred equal events read as one line with a count; spend today against the cap with a 14 day area; a tile per workspace with a health ring (finished against failed today) that opens into its week; a goal that finishes while the page is open rings once; what needs the person pulses slowly; **Ambient** fills the screen for a wall display. The pure shaping is `src/lib/live.ts`. Motion is CSS and one `requestAnimationFrame` counter, both paused while the tab is hidden and replaced by static drawings under `prefers-reduced-motion`; the sidebar leads to `/live`); **Schedules** (every scheduled or webhook Play of the visible workspaces with its next and last run, and a form to schedule, pause or remove one; also at `/w/<slug>/schedules` for one workspace); **People and secrets** (with Share: add people by email with a role, and the private or public switch). Health and People belong to a workspace, so the sidebar leads to the open one's.

## 11. Tests

- `tests/unit`: file schemas and folder validation (valid and each kind of invalid),
  snapshot determinism, pack override, orchestration decisions as pure functions, the
  approval subject digest, the audit chain.
- `tests/core/insights.test.ts`: the `insights` query on a seeded set (counts per day, p50 and p90, the 7-day range leaving an older run out, failure buckets with their tasks, a person seeing only their workspaces). `tests/unit/timeline.test.ts`: the Timeline's time scale (also mirrored), lane packing and critical path.
- `tests/core`: access rules (private hides, public is read only, the roles of a shared workspace), schedules' next and last run, the files listing with pack files; a Governor in a temp directory plus an in-process runner on the fixture
  engine. Each of the twelve patterns as a Play; done requires a check by another agent;
  effect approval (fast path, held path, rejection, standing approval and its limits,
  changed-subject refusal); daily cap; lease expiry and retry; roles; working copy and
  pull request against a local bare repository; a backup made while the Governor runs,
  restored and started again.
- `tests/core/platform.test.ts`: the platform setting's guard (a workspace admin and a member refused, an instance admin allowed, a
  second admin workspace refused, a `read` one allowed beside it with the `platform.*` tools but no pack management, a person who is not an instance admin sees nothing of it); the `platform.*` tools (only from the platform
  workspace, audited with both workspaces, secrets never shown); `platform.repeats` (4 done twice in two workspaces found, 3 not, runs
  older than 30 days not); `platform.tool-drift`; a capitalizer proposal lands only in the platform workspace's `packs/` after an admin approves it; a
  release freezes a version, a workspace pinned to it resolves exactly it whatever is edited later, Update available shows only for a newer release, and
  Update commits the pin; the weekly schedules of `capitalize` and `sync-tools`.
- `tests/core/users.test.ts`: the access resolver with groups (highest role wins, direct or via which group); invite, accept, revoke, expiry and one use; the last-admin guard; deactivation (an issued session refused, sessions ended, sign-in refused, history kept); reset links; audit entries; the admin-only matrix.
- `tests/e2e`: the real runner on its fixture engine against the Governor in one process: a pipeline to a checked
  result, a native edit that leaves as an approved pull request, a held call carried out later.
- `tests/unit/live.test.ts`: the shaping of Live (stage counts, flow widths, the feed built from tasks and grouped so equal events become one line with a count, activity buckets, token samples, goals that just finished).
- `tests/browser` (`pnpm test:browser`: builds the web app, then Playwright with Chromium at 1440 and, for the first
  run and the accessibility pass, 390 wide): each test starts its own empty install, a Governor serving `apps/web/dist`
  and the real runner on the fixture engine, in the test process (`stack.ts`). It acts as a first-time user: setup link to
  a checked result with its cost; a typed goal, its plan changed and confirmed; an approval approved and one rejected with
  a reason; an agent's prompt edited (pack file to workspace file) and a broken file refused on its line; a workspace made
  from a pack with its first goal; Files (browse, edit and save a document, a broken `brain.toml` refused, upload with an overwrite confirmation and a size refusal, download, delete; a pack's file listed and a copy edited; selection by box, range and key, copy, move, bulk download and delete, and a dropped file; axe light and dark at 390; Arabic); Schedules (the list, the form with its live check and preview, pause and remove); users (invite, accept, sign in, deactivate); sharing (adding a person by email, the private and public switch, the invited person's grouped sidebar and a public workspace read only); the Overview across several workspaces (needs-you list, a call decided in place, a jump into a task); the Live screen (the runner lane and its slots, the numbers of the flow, a need that pulses, axe in light, dark and reduced motion); axe on Today and Task (light and dark) and an Arabic right-to-left check. It is not
  part of `pnpm verify`.

`pnpm verify` = lint, typecheck, unit, runner, core and e2e tests, and `scripts/complexity.mjs`,
which fails when tables, commands plus queries, glossary terms, step fields or screens exceed the
budget written in `docs/complexity.json`.
