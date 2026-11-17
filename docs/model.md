# Brain: the model

Brain runs agents on your projects and keeps a record you can trust: what ran, what it
cost, what was checked, and who approved. This page is the whole model. If something is
not named here, Brain does not have it.

## The eight things

| Thing | What it is | Where it lives |
|---|---|---|
| **Workspace** | One area of work: its projects, agents, tools, Plays and memory. | A folder that is a git repository. |
| **Project** | A code repository the workspace works on. | An entry in `brain.toml`. |
| **Agent** | A prompt, the tools it may use, and its limits. | `agents/<name>/` |
| **Tool** | One governed action that reaches outside the task's sandbox. | `tools/<name>/` |
| **Play** | A saved way to do a job: steps, who does each, and what starts it. | `plays/<name>.toml` |
| **Memory** | What the workspace has learned, read by its agents only. | `memory/<name>.md` |
| **Pack** | A reusable bundle of agents, tools, Plays and memory. | `packs/<name>/` shipped with Brain |
| **Task** | A goal and its result. A task can have sub-tasks. | The database. |

Everything except tasks is a file. Editing in the app writes the file and commits it.
Every task records the commit it ran on, so a result can always be traced to the exact
agents, tools and Plays that produced it. A task that was healed records the commit of
the fix, and each attempt keeps the commit it ran on.

## A workspace folder

```
kios-newrh/
  brain.toml
  agents/reviewer/agent.toml
  agents/reviewer/prompt.md
  tools/deploy.restart/tool.toml
  tools/deploy.restart/run.sh
  tools/deploy.restart/test.sh
  plays/fix-issue.toml
  memory/release-checklist.md
```

### `brain.toml`

```toml
name = "Kios RH"
description = "Workforce cost platform"
timezone = "Africa/Tunis"   # schedules are read in it; UTC when not given
visibility = "private"      # or "public": see People
# platform = "admin"      # or "read": only a platform workspace; see The platform workspace
packs = ["base", "software-factory"]   # "base@2" uses release 2 of a pack (see The platform workspace)

[limits]
daily_spend_usd = 20        # 0 means no cap
running_tasks = 4           # 0 means no cap
confirm_plans = "person"    # or "auto"

[healing]                   # what happens when a task has failed all its attempts
mode = "auto"              # or "off"
per_day = 5                 # heal tasks a day; 0 means no cap

[[model]]                   # tried in order; the next one is used when one refuses
name = "main"
provider = "openai-compatible"
url = "https://models.example/v1"
model = "qwen3-coder"
key = "secret:model-main"
input_usd_per_mtok = 0.40   # optional prices per million tokens, used when
output_usd_per_mtok = 1.60  # the model server reports no cost itself

[[project]]
name = "kios-newrh"
repo = "https://github.com/keyrustunisie/kios-newrh.git"
branch = "master"
access = "write"            # "read", or "write" to allow pull requests
credential = "secret:github"
setup = "pnpm install --frozen-lockfile"
network = ["registry.npmjs.org"]

[github]
credential = "secret:github"

[git]                           # optional: where the folder itself is backed up or shared
remote = "https://github.com/keyrustunisie/kios-newrh-workspace.git"
credential = "secret:github"    # left out: the [github] credential

[teams]
webhook = "secret:teams-webhook"

[approvals."deploy.restart"]    # a standing approval: named targets, a limit, an end date
targets = ["kios-rh-new-1"]
per_day = 3
until = 2027-01-31
```

A workspace's folder name is its **address** (`/w/kios-rh`), made from its name when it is
created: accents dropped, anything that is not a letter or a digit becomes one dash, so `Kios RH`
is `kios-rh`. An address is never numbered: a name that makes the address of an existing
workspace (archived ones included, whatever the case or accents) is refused, and the person
changes the name. A new workspace's first project takes its name from the repository's address
and its branch from the repository's own default (`main` when that cannot be asked). Values that
are the default (`access = "read"`, `branch = "main"`, the limits above) are not written to a file.

The folder is pushed to `[git] remote` after every change, in the background (an `http` or
`https` address with no password in it; `credential` is the `[github]` one when left out). The
first push initialises an empty remote; nothing is forced, so a remote that has moved on refuses.
A failed push never blocks or undoes a change: it is recorded in the audit log and shown in
Settings and Health with the time of the last push.

A value written `secret:<name>` is a reference. The secret itself is set in the app and
never appears in a file, a log or a result.

Cost is what the model server reports for each call. Where it reports none, Brain
prices the call from its token counts and the model's two prices; a model with no
prices records no cost, and the task says it was not priced. `timezone` is an IANA
name such as `Europe/Paris`; a Play's `schedule` means that clock.

### An agent

```toml
# agents/reviewer/agent.toml
description = "Checks a change against the project's conventions and tests."
engine = ["pi", "claude"]
native = "all"              # the engine's own tools: "none", "read" or "all"
tools = ["git.open-pr", "task.note"]    # workspace and pack tools, by name
model = "main"              # optional; the workspace's first model otherwise

[limits]
turns = 12                 # 0 means no cap
tokens = 100000            # 0 means no cap
spend_usd = 0.50            # 0 means no cap
```

`prompt.md` beside it holds the instructions. The agents in a workspace are its team;
there is no separate team object.

An agent has two kinds of tools:

- **Native tools** are the engine's own: read, search, edit, shell. They run inside the
  task's sandbox, on its working copy, and can reach nothing else. `native = "read"`
  allows reading and searching only; `"none"` turns them off.
- **Workspace tools** are the files under `tools/` and in packs. Anything that leaves the
  sandbox (a pull request, a restart, a message) is a workspace tool.

### A tool

```toml
# tools/deploy.restart/tool.toml
description = "Restarts one named container of this workspace's stack."
effect = "privileged"       # "read", "write" or "privileged"
timeout_seconds = 90
needs = ["bash"]            # what the runner must have
network = []                # hosts the sandbox may reach
secrets = []                # secret names the tool receives

[inputs.container]
type = "string"
description = "Container name"
required = true
```

`run.sh` does the work; `test.sh` proves it without touching anything real. A `read` tool
runs freely. A `write` or `privileged` call stops until a person approves exactly that
call, unless `brain.toml` holds a standing approval that covers it.

### A Play

```toml
# plays/fix-issue.toml
title = "Fix an issue"
description = "Investigate, change, review, and open a pull request."

[inputs.issue]
type = "string"
required = true

[trigger]                   # optional; a Play can always be started by hand
schedule = "0 8 * * 1"      # or: webhook = "github.issues.opened"
paused = false              # true keeps the trigger in the file but never fires it

[[step]]
id = "investigate"
agent = "analyst"
goal = "Find the cause of: {{issue}}"

[[step]]
id = "change"
agent = "developer"
after = ["investigate"]
review_by = "reviewer"
max_rounds = 3

[[step]]
id = "release"
agent = "release-manager"
after = ["change"]
approve = true
```

A schedule is five cron fields (minute, hour, day of month, month, day of week; numbers,
lists, ranges and steps) read on the workspace's clock. The Schedules screen lists every
scheduled and webhook Play of the workspaces a person can see, with its next time (when
the Governor will start it), its last start and that task's state. Scheduling, pausing and
removing is an edit of the Play's `[trigger]` by an admin; scheduling a pack's Play writes
a workspace copy of it that replaces the pack's.

Step fields, and nothing else:

| Field | Meaning |
|---|---|
| `agent`, `goal` | Who does the step and what it is asked. |
| `after` | Steps this one waits for. |
| `for_each` | One copy per item of an earlier result, run in parallel. |
| `review_by`, `max_rounds`, `target_score` | A second agent checks the result and sends it back until it passes. |
| `candidates`, `judge` | Several agents attempt the step; a judge agent, or a person, keeps one. |
| `when` | Run only if a condition on an earlier result holds. |
| `approve` | A person signs off before the step counts as done. |

### Memory

A Markdown file per entry, with a title line. Agents read memory through the
`memory.search` tool and add to it with `memory.propose`; a person accepts a proposal,
which commits the file. A workspace never reads another workspace's memory.

### Translations

An agent, a tool or a Play may carry the text people read in another language, so a French
or Arabic page does not show English that a pack wrote for people. The file says it in
`[translations.fr]` and `[translations.ar]` (only these two languages; anything else is
an error):

```toml
# plays/fix-issue.toml
title = "Fix an issue"
description = "Investigate, change, review, and open a pull request."

[inputs.issue]
type = "string"
description = "The issue to fix"

[translations.fr]
title = "Corriger un ticket"
description = "Enquêter, modifier, faire relire et ouvrir une pull request."
inputs.issue.description = "Le ticket à corriger"
```

The keys are the human-facing ones: `description` (agent, tool, Play, pack), `title` (Play)
and `inputs.<name>.description` (tool, Play; the input must exist). Everything else (a
step's goal, a prompt, an input's name) is read by agents and stays English. A memory entry
is translated by a sibling file, `memory/<name>.fr.md` or `.ar.md`, whose first line is the
translated title; it is read by people only, is never searched, offered or proposed, and
needs the English entry beside it. The app shows the translation when the page is in that
language and the English otherwise. Agents, tool calls, approvals and every digest of what
ran use the English text; editing a file in the form keeps its translations, and the Files
tab shows them as they are. The packs shipped with Brain are translated.

### Documents

A workspace folder may also hold documents: any other file, usually under `docs/`
(handbooks, specifications, reference sheets, images, PDFs, office files). A document is a
plain file, committed with the rest of the folder, so git keeps its history and a change
can be reverted. Brain does not interpret it. Text and Markdown documents under `docs/`
are searched by agents through `memory.search`, next to the memory entries, and each
result says it comes from a document. Other documents (images, PDFs, office files) are
stored and downloadable only. Viewers read and download documents; admins add, edit,
rename and delete them in the Files tab. The Files tab lists every file that belongs to the
workspace: its own folder, and the files its packs supply, each marked with its pack and
read only until an admin edits a copy, which writes the same path into the folder. A document never holds a secret. A path may not
climb out of the folder (`..`) or start a hidden name (only `.gitkeep` is allowed), and an
upload is limited to 5 MB per file and 20 MB in all.

### Packs

A workspace lists the packs it uses, each as its shipped baseline (`base`) or as a release the
admin workspace made (`base@2`). A file in the workspace with the same name as a
pack's file replaces it. `base` holds the task, memory and pull request tools plus a
planner and a checker; the other packs build on it.

## How work runs

1. A person types a goal, or starts a Play, or a trigger starts one.
2. The goal becomes a **task**. With a Play, its steps become sub-tasks. Without one, the
   `planner` agent proposes sub-tasks and a person confirms them (or the workspace
   confirms automatically).
3. The Governor starts every task whose prerequisites are done, on a **runner**. Each run
   of a task is an **attempt**. Agents never start each other; an agent that needs help
   adds a sub-task through the `task.create` tool.
4. The agent works in a sandbox on the runner with the task's own working copy of the
   projects mounted. Inside it, it uses the engine's native tools. To act outside it, it
   calls a workspace tool, and that call is validated, recorded and, for an effect,
   approved.
5. The result is **checked** by something other than the agent that produced it: the
   step's reviewer, the base pack's `checker`, or a person. Only a checked task is done.
6. Code changes leave only as a pull request opened from the working copy's diff.

A task is in one of these states: `waiting`, `ready`, `running`, `needs you`, `done`,
`failed`, `stopped`.

## When a task fails

A task that has failed all its attempts is not left to a person alone. Brain starts one
goal for it, "Heal: *title*", run by the base pack's `workspace-healer` agent. The healer
is given the evidence (the goal, the sub-task chain, every attempt's failure, the tool
calls with their inputs and outputs, the checks) and the workspace files involved, and
finds the cause of the repeated failure. It then does one of two things:

- The cause is in the configuration (a prompt too vague, a wrong limit, a missing network
  host, a setup command, a tool script): it calls the tool `workspace.fix` with the
  minimal change to the workspace's files. That call is a `write`: an admin sees the
  files as a diff with the reason, and approves exactly that change. The change is
  committed like any edit of the folder, and the failed task, and only it, runs again on
  that new commit. A rejection ends the goal; the failed task shows the healer's analysis
  and the proposal.
- The cause is not in the configuration (the model is down, the project's code is wrong),
  or the healer cannot tell: it asks a person a question with `task.ask`. The person's
  answer comes back to the healer, which may then call `workspace.fix`.

A task is healed once, a heal task is never healed, and a failure that only infrastructure
caused (model unreachable, runner lost) is not healed; the failed task says so. The
healer never edits project code and never retries by itself. `[healing]` in `brain.toml`
turns this off or caps the heal tasks a workspace starts in a UTC day. `workspace.fix`
changes only `brain.toml` (not its approvals, GitHub, git remote, Teams or secret references),
`agents/`, `tools/`, `plays/`, `memory/` and `docs/`, and only an admin may approve it.

## The platform workspace

A workspace may look after the others: optimizing the platform, its configuration and keeping
it in shape. `platform` in its own `brain.toml` designates it, in one of two kinds:

- `platform = "admin"`, the **admin workspace**: at most one in a Brain. It is the only place
  where packs are kept, edited, versioned and released (below), and it also reads every
  workspace.
- `platform = "read"`: any number. It reads every workspace with the same tools and has no
  pack management: no Packs tab, no `packs/<name>/` sources (a `packs/` file there is an
  ordinary document that nothing reads as a pack), no release. Its `workspace.fix` is the one
  every workspace has, for healing.

Only a platform administrator (an instance admin) sees either kind in the app, in the new
workspace wizard and in Settings; for everyone else the option is absent. Only a platform
administrator can add, change or remove that line: any other write that would (an edit, a copy
or move, a delete, a fix, the settings form, creating a workspace) is refused, and so is a
second `admin`. A platform workspace is private, and only instance admins see it, whatever its
members list says. Only a platform workspace may list the `platform` pack; any other workspace
that lists it is invalid. The pack's Plays `capitalize` and `sync-tools` change pack sources, so
they are for the admin workspace; a `read` workspace uses the pack for its `platform.*` tools.

Its agents **read everything and change only their own workspace**:

- **Read.** Read-only tools of the `platform` pack, usable only by a task of a platform
  workspace: `platform.workspaces` (every workspace, with its spend and counts),
  `platform.tasks` (search the tasks of every workspace, failures included), `platform.task`
  (one task: goal, result, attempts, tool calls with inputs and outputs, checks, cost),
  `platform.file` (any file of any workspace), `platform.repeats` and, for the admin workspace
  only, `platform.tool-drift` (see below). Each call is recorded in the audit log with the
  source and the target workspace. A secret's value is never shown (only `secret:<name>`
  references exist in files, and a value that a tool call echoed is hidden), and every answer is
  cut to a size.
- **Write.** A task of the admin workspace (not a heal task) may call `workspace.fix`, as
  a heal task does, but only for files under `packs/` of its own workspace: the change is
  checked, shown as a diff with the reason, and applied only once an admin approves exactly
  it. Nothing in another workspace is ever written by a platform workspace.

### Packs are kept and delivered here

The packs shipped with Brain are the baseline. The admin workspace holds an editable copy
of each under `packs/<name>/` (same layout as a pack; made from the shipped ones in the
commit that makes a workspace the admin workspace), and `pack.toml` there has a `version`,
the last release (absent: none). An admin of the admin workspace edits those files like any
others (Files, the forms, a proposal approved) and **releases** a pack: its version goes up
by one, the content of that commit is frozen as version N (git tag `<name>@N`; it never changes),
and any workspace may use it.

A pin `base@N` is read only from the admin workspace's releases. A workspace chooses what it uses in `brain.toml`: `packs = ["base"]` is the shipped baseline,
`packs = ["base@2"]` is released version 2. A workspace whose pack has a newer release than the
one it uses (the baseline counts as 0) shows **Update available**; an admin of that workspace
sees the difference and presses **Update to vN**, which commits the new pin like any edit of
`brain.toml` and is audited. Brain never changes a workspace's pins by itself.

### Capitalisation

Work that keeps being done the same way should become something Brain has. The `platform`
pack's Play `capitalize`, run by its agent `capitalizer`, starts every Monday at 07:00 on the
admin workspace's clock and by hand. **Repeated work** is a job done four or more times
in the last 30 days, in all workspaces together, by the same agent (by name) calling the same
sequence of tools on similar goals. `platform.repeats` finds these deterministically, with no
model. The `capitalizer` judges each one, and for each that is worth it proposes, in the pack
sources of the admin workspace, one of:

1. a **new tool** (`tool.toml`, `run.sh`, `test.sh` that proves it without touching anything
   real) in a pack, and the agents' `tools` lists updated;
2. an **update** of an existing tool, agent or Play with what was learned (a better prompt, a
   limit, a missing step, a fixed script);
3. a **memory note** of a pack, when the lesson needs neither.

It may also read the analyses the `workspace-healer` made (`platform.tasks` with that agent),
since a failure that was healed is something learned. Once the proposals are approved and the
pack released, workspaces get them with Update.

### Tool sync

The Play `sync-tools` (Monday 07:30 and by hand), run by the agent `syncer`, brings home
what workspaces improved on their own. `platform.tool-drift` compares, by name, the tools, agents
and Plays that workspaces hold in their own folders with the admin workspace's pack sources: a
workspace copy that differs, or one that no pack has. A tool that is a script (`run.sh`) is compared
with its scripts; a tool Brain runs itself has none and is not compared. For each, the agent decides
whether to adopt the workspace's version into a pack, as a `workspace.fix` proposal to approve; an
adopted tool includes its `run.sh` and a `test.sh` that proves it. Then the pack can be released.

## What is recorded for every task

- **Evidence**: each tool call with its input and output, and the files produced.
- **Check**: who or what checked the result and what they found.
- **Approvals**: who approved which exact call, and what they were shown.
- **Cost**: tokens and money per attempt, against the workspace's daily cap.
- **Audit**: one append-only, hash-chained log of every change and decision.

## What runs

One Governor process (API and web app) with SQLite, and one or more runners. A runner
executes attempts and runs tools in sandboxes whose only network path is the egress
proxy.

## People

A person signs in and is a member of workspaces as `viewer`, `member` or `admin`.
Members start and steer work and approve calls. Admins also edit the workspace's files,
secrets and members. An admin shares a workspace by adding people by email with a role.

A person's workspaces are grouped as **My workspaces** (those they admin), **Shared with
me** (those they are a viewer or member of) and **Public workspaces**. A workspace is
`private` (only its members see it) unless `brain.toml` says `visibility = "public"`: then
every signed-in person of this Brain sees it as a viewer, read only. That person can read
its tasks, files and results; they cannot start work, approve, edit, or see its secrets or
members. Changing visibility is a change of `brain.toml` and is audited.
