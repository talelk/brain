# Packs

The reusable content shipped with Brain. A workspace lists the packs it uses in
`brain.toml`; a file in the workspace with the same path replaces the pack's file.
File formats are those of [docs/model.md](../docs/model.md). This page records the
conventions the pack files rely on, so the code that loads and runs them matches.

| Pack | Requires | Agents | Tools | Plays |
|---|---|---|---|---|
| `base` | | planner, checker, worker | task.create, task.note, task.ask, memory.search, memory.propose, git.open-pr, message.send, web.fetch | hello |
| `software-factory` | base | analyst, developer, reviewer, release-manager | | fix-issue, build-feature, review-pull-request, dependency-check |
| `sre` | base | sre-operator, incident-analyst, evaluator | host.status, host.logs, host.disk, http.check, host.restart, host.redeploy | keep-healthy, incident-triage, weekly-report |
| `customer-operations` | base | router, billing-agent, technical-agent, generalist, quality-reviewer | | handle-request, improve-answers |

`pack.toml` has exactly `name`, `description` and `requires` (a list of pack names, empty
for `base`). An agent or a Play of a pack may name agents and tools of the packs it
requires.

## Fields used

- `agent.toml`: `description`, `engine`, `native`, `tools`, `[limits]` with `turns`,
  `tokens`, `spend_usd`. No pack agent sets `model`.
- `tool.toml`, three shapes:
  - Brain-run: `description`, `runs = "brain"`, `effect`, `[inputs.*]`. No script.
  - Host command: `description`, `effect`, `host_command`, `timeout_seconds`,
    `[inputs.*]`. No script.
  - Script: `description`, `effect`, `timeout_seconds`, `needs`, `network`, `secrets`,
    `[inputs.*]`, with `run.sh` and `test.sh` beside it.
- A tool input: `type` (`string`, `integer` or `array` here), `description`, `required`
  (always written, `true` or `false`), and for an array `items = { type = "string" }`.
- A Play: `title`, `description`, `[inputs.<name>]` with `type` and `required` only,
  `[trigger]` with `schedule` or `webhook`, and `[[step]]` with `id` plus the step fields
  of model.md. Every step in the packs has a `goal`.
- A memory entry: Markdown whose first line is `# <title>`.
- Translations: every pack file that people read carries `[translations.fr]` and
  `[translations.ar]` (`pack.toml`, `agent.toml`: `description`; `tool.toml`:
  `description` and `[translations.<lang>.inputs.<name>] description`; a Play: `title`,
  `description`), and every memory entry has `memory/<name>.fr.md` and `.ar.md`. Product
  words (Brain, Play, pack, agent and tool names, code, cron) stay as they are. A test
  fails when a shipped pack lacks one.

## Goal templates

A step's `goal` is text with `{{ }}` placeholders, filled in when the step's task is
created. Nothing else in a Play is a template.

| Placeholder | Becomes |
|---|---|
| `{{name}}` | The Play input `name`. |
| `{{name.a.b}}` | A field inside an input whose type is `object` (dotted path). |
| `{{steps.<id>.result}}` | The result text of the earlier step `<id>`. |
| `{{steps.<id>.result.<field>}}` | A field of that result, when the result is a JSON object (dotted path). |
| `{{item}}`, `{{item.<field>}}` | In a `for_each` step: the item of this copy, or a field of it. |

Rules:

- `steps` and `item` are reserved; a Play input cannot have those names.
- A step that a placeholder, a `when` or a `for_each` refers to is always listed in the
  step's `after`.
- A result "is a JSON object" when the agent's whole final answer parses as one. A code
  fence around it is tolerated and removed.
- A string is inserted as it is; a number or boolean as its JSON text; an object or a
  list as compact JSON. A path that does not resolve, including into a `skipped` result,
  becomes an empty string. It is not an error.
- Text that comes out of a placeholder is never scanned for placeholders again.
- Single braces are plain text. Several goals show a JSON shape such as
  `{"healthy": true}` to the agent.

## `when`

One comparison of an earlier result with a literal:

```
when = 'steps.<id>.result.<field> == <literal>'
when = 'steps.<id>.result.<field> != <literal>'
```

`<literal>` is a double-quoted string, a number, `true` or `false`. The left side
resolves like a placeholder. If it does not resolve (the result is not JSON, the field is
missing, the step was skipped), `==` is false and `!=` is true. A step whose `when` is
false is `done` with result `skipped`. A step that waits for a skipped step still runs
unless its own `when` says otherwise; that is why `remediate` in `keep-healthy` repeats
the condition of `diagnose`.

Used as: `steps.route.result.category == "billing"` and
`steps.check.result.healthy == false`.

## `for_each`

```
for_each = "steps.<id>.result.<field>"
```

The path must resolve to a JSON list in the result of a step listed in `after`. One
sub-task is created per item, in list order, and they run in parallel. Each copy has its
own check rounds (`review_by`, `max_rounds`). A step that lists a `for_each` step in its
`after` waits for every copy and receives every copy's result in its context. An empty
or missing list creates no copies and the step is `done` with result `skipped`.

Used once: `for_each = "steps.plan.result.tasks"` in `build-feature`, with
`{{item.title}}` and `{{item.goal}}`. The items are the planner's tasks; their `agent`
and `after` fields are ignored there because the step fixes the agent.

## Final-answer formats

An agent that must return structured output replies with one JSON object and nothing
else.

Planner (`base/agents/planner`), for a `plan` attempt and for a Play step:

```json
{"summary": "string", "tasks": [{"title": "string", "goal": "string", "agent": "string", "after": ["title of an earlier task"]}]}
```

`after` holds titles of earlier tasks of the same list, `[]` when none; titles are
unique within a plan. `agent` is the name of an agent of the workspace. The planner
expects the list of the workspace's agents, names and descriptions, in its context.

Checker (`base/agents/checker`), and every agent used as `review_by`
(`reviewer`, `evaluator`, `quality-reviewer`):

```json
{"pass": true, "score": 0.9, "findings": "string"}
```

All three are always present; `score` is from 0 to 1.

Judge (the agent a step names as `judge`), for a `judge` attempt:

```json
{"keep": "<attemptId>", "findings": "string"}
```

`keep` is the attempt id of the one candidate to keep, as the judge's context lists the
candidates; `findings` says why. The judgement is the check of the kept result unless
the step also names `review_by`.

Router (`customer-operations/agents/router`):

```json
{"category": "billing | technical | other", "urgency": "low | normal | high", "summary": "string"}
```

One Play defines a format in a step goal instead of a prompt: the `check` step of
`keep-healthy` asks `sre-operator` for
`{"healthy": boolean, "unhealthy": ["string"], "summary": "string"}`.

The drafting agents of `customer-operations` return Markdown with two headings,
`## Reply` and `## Notes for the team`; only the Reply section is sent.

## Brain-run tools

Implemented by the Governor. Inputs are the `[inputs.*]` of each `tool.toml`; these are
the outputs the descriptions promise to agents.

| Tool | Effect | Inputs (`*` required) | Output |
|---|---|---|---|
| `task.create` | read | `title`*, `goal`*, `agent`*, `after` (list of task ids) | `{"id": "<task id>"}` |
| `task.note` | read | `text`* | `{"id": "<note id>"}` |
| `task.ask` | read | `question`* | `{"status": "waiting"}` |
| `memory.search` | read | `query`*, `limit` (integer; 5 by default, at most 20) | `{"results": [{"name", "title", "text", "source"}]}`, best first |
| `memory.propose` | read | `name`* (file name slug), `title`*, `text`* | `{"id": "<proposal id>", "status": "proposed"}` |
| `git.open-pr` | write | `project`*, `title`*, `body`* | `{"url", "number", "branch"}` |
| `message.send` | write | `text`* | `{"sent": true}` |

- `task.create` adds the sub-task under the calling task. In `after`, the tool takes
  task ids; the planner's JSON takes titles.
- `task.ask` returns at once. The prompts tell the agent to end its turn; the answer is
  expected in the context of the task's next attempt.
- `memory.search` returns `name` without `.md`, and in `text` the matching part of the
  entry. A text document of the workspace under `docs/` is found too, with its path as
  `name` and `source` `document` (a memory entry's is `memory`).
- For a `write` call that is not approved in time, the agent is told the call is held.
  Every prompt says: held, declined or refused means it did not happen; do not repeat it.

## Script tools

`run.sh` reads one JSON object on standard input (the validated inputs) and writes one
JSON object on standard output.

- Exit 0: the output is the result.
- Exit 2 with `{"error": "<why>"}`: the input was refused or the tool could not do its
  work.
- `test.sh` takes no input, uses no network, exits 0 and prints `<tool>: ok`. Both tests
  put a stub `curl` first on `PATH`.

| Tool | Input | Output |
|---|---|---|
| `web.fetch` (base) | `url`* (https only), `max_chars` (1 to 20000, default 8000) | `{"url", "final_url", "status", "content_type", "text", "truncated"}` |
| `http.check` (sre) | `url`* (http or https) | `{"url", "ok", "status", "time_ms"}`, plus `"redirect"` or `"error"`. No answer at all is a finding: `ok` false, `status` 0, exit 0. |

Both declare `needs = ["bash", "python3"]` and also call `curl`, which the tool sandbox
must provide. Both ship with `network = []`: a workspace makes them useful by placing its
own `tools/<name>/tool.toml` that lists the hosts it allows. Only that file is replaced;
`run.sh` and `test.sh` still come from the pack.

## Host commands of the `sre` pack

Each host tool names a command with the same name as the tool. The operator of the
runner host declares the real command line; the tool's inputs are its named arguments.
For a host that runs its services with Docker, the declarations would be:

| `host_command` | Effect | Arguments | Example command line |
|---|---|---|---|
| `host.status` | read | | `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'` |
| `host.logs` | read | `container`, `lines` (1 to 500) | `docker logs --tail {lines} {container}` |
| `host.disk` | read | | `df -h` |
| `host.restart` | privileged | `container` | `docker restart {container}` |
| `host.redeploy` | privileged | `stack` | `docker compose -f /srv/{stack}/compose.yaml up -d --pull always` |

The operator should restrict `container` and `stack` to a pattern such as
`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`. The agents treat the output as text.

## What the content expects from the engine

Prompts and goals are written for these facts. Where the build differs, change the
sentence in the prompt, not only the code.

- Projects are mounted at `/work/<project>`; files to keep go in `/out`.
- A step's working copy starts from the changes of the steps it waits for. `fix-issue`
  and `build-feature` open the pull request in a later step than the one that changed
  the code, and `build-feature` joins the changes of parallel developers.
- A check receives the goal, the result, the recorded tool calls including native shell
  commands with their output, and the working-copy diff.
- The planner's context lists the workspace's agents. The `hello` Play expects the
  worker's context to describe the workspace's agents, tools and Plays.
- A Play started by a webhook has one input named `delivery`, the delivery's JSON body,
  declared as `[inputs.delivery]` with `type = "object"`. `review-pull-request` reads
  `delivery.repository.full_name` and `delivery.pull_request.{number, title, html_url,
  diff_url, body, head.ref, base.ref}`. Its working copy is at the project's branch, so
  the reviewer fetches the diff with `web.fetch`; the workspace must allow the diff's
  hosts in its own `web.fetch`.
- `improve-answers` can only see memory and its own board, because no tool reads the
  results of other goals. It says so in its result when its context holds none.
