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
daily_spend_usd = 20        # 0 (the default) means no cap
running_tasks = 4           # 0 (the default) means no cap: runner slots set the pace
confirm_plans = "person"    # or "auto"
paused = false              # true: nothing of this workspace starts; see The queue

[healing]                   # what happens when a task has failed all its attempts
mode = "auto"              # or "off"
per_day = 5                 # heal tasks a day; 0 means no cap

[cleanup]
superseded_after_hours = 24 # close a goal waiting for a person once a newer identical one has a result; 0 means never

[[model]]                   # tried in order; the next one is used when one refuses.
                            # A workspace with none of its own calls the admin workspace's models, with that workspace's keys.
name = "main"
provider = "openai-compatible"
url = "https://models.example/v1"
model = "qwen3-coder"
key = "secret:model-main"
input_usd_per_mtok = 0.40   # optional prices per million tokens, used when
output_usd_per_mtok = 1.60  # the model server reports no cost itself
context_tokens = 262144       # optional: the model's context window (default 200000). A long conversation is
compact_at = 0.7            # compacted at this share of it (default 0.7), never left to overflow

[[project]]
name = "kios-newrh"
repo = "https://github.com/keyrustunisie/kios-newrh.git"
branch = "master"
access = "read"             # "write" (the default) allows pull requests; "read" limits to reading
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
are the default (`access = "write"`, `branch = "main"`, the limits above) are not written to a file.

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
turns = 12                 # 0 means no cap; 100 when not written
tokens = 100000            # 0 means no cap; 2,000,000 when not written
spend_usd = 0.50            # 0 means no cap, and is when not written
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
network = ["api.github.com"]  # hosts the sandbox may reach. Left out: any public host ("*"); [] is none
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

The Files screen also lists, read only and apart from the folder, what tasks kept: a file an attempt
saved in `/out` as `out/<task>/<name>`, and the diff of its changes to a project as
`work/<task>/changes.patch` (the files of a task as its Evidence tab shows them). They are not part
of the folder, are never committed, and go with the retention of the task's results.

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
3. The Governor starts every task whose prerequisites are done, on a **runner**, in the order
   of **the queue** (below). Each run of a task is an **attempt**. Agents never start each other; an agent that needs help
   adds a sub-task through the `task.create` tool.
4. The agent works in a sandbox on the runner with the task's own working copy of the
   projects mounted. Inside it, it uses the engine's native tools. To act outside it, it
   calls a workspace tool, and that call is validated, recorded and, for an effect,
   approved.
   A plan is checked before anyone sees it. Each task has `needs`: the workspace tools it calls and
   `files.write` when it saves a file; what its goal only names is not a need (a goal may review a tool). The catalog the planner reads lists what each agent can do (its tools, and whether it writes
   files: its `native` level is `all`). A task whose agent lacks a need goes, by itself, to the agent
   that has all of them (the fewest capabilities, then the name), and the plan's note says so; the
   plan is refused with the reason, and made again twice at most, only when no agent has them all.
   An agent that can read files is also given, under `/work/.workspace`, a read-only copy of its
   workspace as the task's snapshot holds it (`manifest.json`, the agents' prompts, the tools'
   files, the memory entries and the documents; bounded in size, never kept, no secret in it), so
   a goal about the workspace's own files can be done.
   The task text tells every agent what is kept (the project folders under `/work`, and the files in `/out`;
   a file written anywhere else is lost when the attempt ends) and not to search the rest of the
   file system, and what the model is sent of one tool's answer is bounded, Pi's own tools included.
5. The result is **checked** by something other than the agent that produced it: the
   step's reviewer, the base pack's `checker`, or a person. Only a checked task is done. When a
   reviewer's verdict repeats almost word for word the one before, the rounds stop there and a
   person is asked at once, with that said: another round would change nothing.
   Brain also checks, in code and before any reviewer is asked, what a report says it did: a
   result that says it saved a file under `/out` that was not kept (or a file in `/work` outside
   a project folder, which is lost) goes back as a failed round with the reason, and a result
   whose first line starts with `BLOCKED:` is the agent saying it cannot do the task as it is set
   up: it goes back the same way, with its reason, and the reviewer is not asked. Every agent is
   told so in its task text; both count as rounds, so they end at the step's limit and a person
   is asked.
6. Code changes leave only as a pull request opened from the working copy's diff.

A task is in one of these states: `waiting`, `ready`, `running`, `needs you`, `done`,
`failed`, `stopped`.

## The queue

A task that is ready waits in the **queue** until a runner has a free slot. The queue is a
screen, `/queue` (everything the person sees; an instance admin sees everything) and
`/w/<address>/queue` (one workspace), and it answers three questions at once: what is running
and on which runner, what waits and in which order, and why each waiting task is not running yet.

- **Runners as lanes.** Each runner shows its slots (used and free), its engines and
  capabilities, whether it is online, and the attempts that occupy its slots: task, agent,
  workspace, how long, tokens so far, cost. A slot held by a workspace the person cannot see is
  shown as busy, without a name.
- **The waiting list, in the order the Governor will start it.** The order is: **priority**
  first (`high`, then `normal`, then `low`); within a priority the workspaces take turns (a
  workspace with five tasks waiting cannot starve one with one: the first of each goes before
  the second of any, and a workspace that already has attempts running goes after one that has
  none); within a workspace, oldest first. A task has a priority, `normal` unless a person who
  can steer sets it; its sub-tasks follow their goal. **Run next** sets `high`, and of two
  `high` tasks the one promoted last goes first.
- **Why it waits**, in words, one of: a free slot (and how many are ahead); the workspace's
  `running_tasks` (4 of 4); no runner online; no runner has the engine or capability it needs
  (the missing one is named); the workspace's daily spend cap is reached; another task it
  waits for (named); the workspace's queue is paused; the task is paused; the time of the
  retry after an infrastructure failure; or **it cannot work yet** (below).
- **A task that cannot work is not started, and does not fail later.** Before an attempt is
  offered, Brain checks what it can see without leaving the Governor, and the task waits with
  the sentence of the first thing that is wrong: the workspace has no model (its own or the
  admin workspace's); the keys of every
  model are not set; a project's credential (its own, or the workspace's `[github]` one) is not
  set; the agent's prompt alone is larger than the model's window before compaction. A secret set
  later is seen at once and the task starts; a file fixed later reaches a task when it runs on the
  new snapshot. Nothing is stored for it.
- **An estimated start** when at least three attempts of that kind finished recently: the
  median of their durations, spread over the runners' slots. Otherwise none; it is never invented.
- **Steering**, for members: set a task's priority (`low`, `normal`, `high`), **Run next**, pause
  and resume a task (a paused task and its sub-tasks are not started; what already runs goes
  on), stop. For admins: pause and resume the workspace's queue (`[limits] paused` in `brain.toml`:
  nothing of it starts, what runs goes on). A priority and a pause are recorded as the audit
  event `task.steered`, not in a table.

The Queue is also shown as a short line on Today and the Overview ("3 running, 5 waiting")
and as the count of waiting tasks beside each workspace in the sidebar.

**Live** is the same facts drawn as they happen, with nothing added to the model: the runners as lanes
with their attempts, the counts of Queued, Running, Checking, Needs you, Done and Failed as one flow,
a feed of what just happened and today's spend. It reads the Overview, the Queue and the tasks; it
stores nothing and starts nothing.

## Limits

A limit stops or delays work so a mistake cannot cost without end. Each one is shown, with its
current use and where its value comes from (the agent's file, the workspace's `brain.toml`, or
Brain's default), in **Limits** of the workspace's Settings and of each agent's form, with a
button to change it. Defaults are generous and no money cap is set unless a person sets one.

| Limit | Applies to | Default | Set in |
|---|---|---|---|
| `daily_spend_usd` | a workspace, per UTC day | 0 (no cap) | `brain.toml [limits]` |
| `running_tasks` | a workspace | 0 (no cap; runner slots set the pace) | `brain.toml [limits]` |
| `paused` | a workspace | false | `brain.toml [limits]` |
| `healing.per_day` | heal tasks of a workspace, per day | 5 | `brain.toml [healing]` |
| `turns` | one attempt of an agent | 100 | `agent.toml [limits]` |
| `tokens` | one attempt of an agent | 2,000,000 | `agent.toml [limits]` |
| `spend_usd` | one attempt of an agent | 0 (no cap) | `agent.toml [limits]` |
| `max_rounds` | check rounds of one step | 3 | the step in the Play |
| attempts | one attempt is retried after an infrastructure failure, with waits growing from 5 seconds to an hour, for about six hours (13 tries in all) | 13 (not editable) | Brain |
| slots | one runner | 1 | `BRAIN_RUNNER_SLOTS` of the runner, then restart it; another runner is `pnpm brain runner --governor <address> --token <token>` |
| uploads | a document | 5 MB each, 20 MB per upload | Brain |

A reply the model writes may be as long as 32,768 tokens (a thinking model needs room; the
checks and judgements get the same), unless the agent's `tokens` is smaller.
When a limit stops or delays a task, the attempt's failure or the task's page says so: the
limit's name, its value, what was used, where it is set, and **Raise the limit**, which opens
the form that holds it. It is never shown as a generic failure.

## How long Brain keeps what is large

What a goal produced in bulk is kept for a week after it ended, and then forgotten: its files and diffs, the log of what each attempt did, and the
work that passed between runners. What stays for good is the record: the goal and its tasks with their results, the checks, the approvals (with the
digests of what was shown, though not the bytes), the pull requests, and the whole audit chain, which also says what was forgotten and when. A goal
that has not ended is never touched, however old. A runner keeps copies of snapshots and repositories only as a cache, forgotten after a week.

## The timeline and Insights

Two pages show work over time. Neither adds a thing to the model: both read what is already
recorded for every task (attempts, tool calls, approvals, checks, usage).

- **The timeline of a goal**, on the Task page beside the graph (`?view=timeline`). A Gantt of
  every attempt of the goal and its sub-tasks: one row per task, grouped by agent, time across.
  A bar is one attempt, coloured by kind (work, check, judge, plan, act) and marked by state;
  attempts of a later check round or a retry sit after the first on the same row, and
  candidates that ran at once sit in their own lanes. A faint stretch before a bar is the time
  the attempt waited in the queue. Marks show what a person was asked: an approval (requested,
  then decided) and a question (asked, then answered); the stretch between is **waiting for a
  person**. Each tool call is a tick on its attempt. The **critical path**, the chain of tasks
  that sets when the goal can finish (the longest by duration through what each waits for), can be
  highlighted. Zoom and pan with the buttons, the keyboard or the wheel. Selecting a bar selects
  its task, exactly as selecting a node of the graph does; hovering or focusing one shows its
  duration, wait, tokens and cost. A table behind the chart lists the same attempts.
- **Insights**, at `/insights` (every workspace the person sees) and `/w/<address>/insights`, for
  people who steer, over the last 7, 30 or 90 days (days are the person's own days):
  goals started per day (calendar heatmap) and attempts started by weekday and hour (load);
  per day, goals finished and failed and the times a person was asked (approvals and
  questions); where time and money go, ranked by workspace, agent and Play with a small
  trend each, and time and calls by tool (money is recorded per attempt, so it is not split by
  tool); how long goals of each Play take and attempts of each agent run (p50 and p90, the
  nearest rank); how long attempts waited in the queue, by day; why tasks failed (limits,
  setup, engine, checks) with the failing tasks one click away; and work started again with
  the same Play and inputs or the same words. Everything is computed from the existing rows when
  asked and kept for a minute; nothing new is stored.

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
caused (model unreachable, runner lost, a connection that dropped, a model that says its window overflowed when no turn of the conversation came near it) is not healed: it is tried again by itself for about six hours (see the limit `attempts`), and the failed task says so
when that is not enough. A heal task that waits for a person is stopped when the task it heals is done, whoever made it so. The healer knows Brain's own rules (a workspace with no model of its own uses the
admin workspace's) and does not ask a person about them. The
healer never edits project code and never retries by itself. `[healing]` in `brain.toml`
turns this off or caps the heal tasks a workspace starts in a UTC day. `workspace.fix`
changes only `brain.toml` (not its approvals, GitHub, git remote, Teams or secret references),
`agents/`, `tools/`, `plays/`, `memory/` and `docs/`, and only an admin may approve it.

## When a newer identical task made a waiting one useless

A task waits for a person (a check, an answer, an approval, the confirmation of a plan, a
failed sub-task) and nobody comes. When the same work has been started again since, the old
wait no longer helps anyone. A goal is **closed automatically** (it becomes `stopped`, is
never deleted, and the audit chain says why) when all of this holds:

- one of its tasks has waited for a person at least `superseded_after_hours` (`[cleanup]` in
  `brain.toml`, 24 by default, 0 turns it off);
- a newer goal in the workspace is exactly the same: the same Play with equal inputs, or,
  without a Play, the same goal text; and its task that corresponds to the waiting one (the
  same step, agent and title; the goal itself for a waiting goal) is `done` or itself waits
  for a check. A merely running or waiting one does not count;
- nothing else of the old goal is running or about to run, and every task of it that
  waits for a person is of the kinds above and superseded the same way.

Its attempts end, its approvals are cancelled, and the heal tasks of its failed tasks are
closed with it. The closed goal's page says which newer goal replaced it, and when. It is
not reopened; starting the Play again does the work again.

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

### Users, invitations and groups

An **instance admin** (shown as a platform administrator) looks after the people of the whole
Brain at `/users`; everyone else is an instance **member**. A person is `active`, `invited`
(an invitation not yet accepted) or `deactivated`.

- **Every workspace.** An instance admin is an `admin` of every workspace, private and archived ones
  included, whether or not they are listed as a member: they read and change what a workspace admin does, and
  the audit log names them.
- **Invitation.** An admin invites an email address with an instance role, optional workspace
  roles and optional groups. Brain may have no mail server, so the invitation is a one-use link
  the admin copies (mail is also sent when `BRAIN_SMTP_URL` is set). The link works once, for
  seven days; inviting the same address again, or revoking, makes the earlier link useless. The
  person opens it, chooses a name and a password, and is signed in with what was granted. An
  address that already has an account cannot be invited.
- **Reset link.** An admin can make a one-use link, valid for one day, with which a person
  chooses a new password; using it signs that person out everywhere.
- **Group.** A named set of people that is given a role on workspaces. A person's role in a
  workspace is the highest of their own role and the roles of their groups. A workspace's
  People tab and Share dialog list the groups with a role there, and each person's access says
  whether it is direct or through which group. Groups are made and changed by instance admins.
  A workspace still keeps at least one admin of its own: a role a group gives does not count.
- **Deactivation.** A deactivated person cannot sign in, and their sessions end at once. Their
  history, tasks, approvals waiting for them and audit trail stay; the workspace roles stay and
  work again when the person is reactivated. At least one active instance admin always exists:
  the last one cannot be demoted or deactivated, and nobody deactivates themselves.
- **Sign-in log.** A person's detail shows their open sessions, their recent sign-ins and
  failed attempts (from the audit log), and their access: every workspace with the role and
  whether it comes directly or through a group.
- **Profile.** At `/profile` anyone changes their name and password, sees their sessions and
  signs out the others; language and theme stay a choice of the browser.

Every change above is an audit event written in the same transaction as the change; links are
kept only as keyed digests and shown once.

