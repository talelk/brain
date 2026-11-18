# Brain glossary

The words Brain uses, and the ones to avoid. The model is in
[docs/model.md](docs/model.md); this file only fixes the vocabulary.

**Workspace**: One area of work: a folder that is a git repository holding its agents,
tools, Plays and memory, plus the projects it works on.
_Avoid_: organization, tenant, space, team

**Project**: A code repository a workspace works on, listed in `brain.toml`.
_Avoid_: repo binding, rig

**Agent**: A prompt, the tools it may use and its limits, in `agents/<name>/`.
_Avoid_: bot, team member, role (a role is just an agent's name)

**Tool**: One governed action that reaches outside a task's sandbox, in `tools/<name>/`.
_Avoid_: plugin, skill, connector

**Native tool**: An engine's own tool (read, search, edit, shell), usable only inside the
task's sandbox.
_Avoid_: built-in tool (ambiguous with Brain-run tool)

**Brain-run tool**: A tool the Governor carries out itself (`runs = "brain"`), such as
`task.create` or `git.open-pr`.
_Avoid_: system tool, internal tool

**Effect**: What a tool call changes: `read` changes nothing, `write` and `privileged`
change something and need an approval.
_Avoid_: side effect, action class

**Play**: A saved way to do a job: steps, who does each, and what starts it.
_Avoid_: workflow, playbook, recipe, template, formula

**Step**: One entry of a Play; it becomes a task when the Play runs.
_Avoid_: node, stage, job

**Trigger**: What starts a Play without a person: a schedule or a webhook.
_Avoid_: automation, listener, event rule

**Visibility**: Whether a workspace is `private` (only its members see it) or `public` (every
signed-in person of this Brain reads it, as a viewer), set in `brain.toml`.
_Avoid_: sharing mode, permission level

**Group**: A named set of people that is given a role on workspaces; a person's role in a
workspace is the highest of their own and their groups'.
_Avoid_: team (a team is agents), org unit, department

**Invitation**: A one-use link, kept only as a digest and valid for seven days, with which a
person who has no account chooses a name and password and joins with the roles it grants.
_Avoid_: invite code, magic link, sign-up

**Platform workspace**: A workspace with `platform` set in its `brain.toml` (only by an instance
admin, shown as a platform administrator), whose agents read every workspace and propose
changes to them, each change approved by that workspace's admin or an instance admin. Of kind
`admin` (the one that also keeps and releases the packs) or `read` (any number, no packs).
_Avoid_: super workspace, root workspace

**Memory**: What a workspace has learned, as Markdown entries in `memory/`, read only by
that workspace's agents.
_Avoid_: knowledge base, context, scope

**Pack**: A reusable bundle of agents, tools, Plays and memory that a workspace lists.
_Avoid_: template, starter kit, release

**Task**: A goal and its result. A task can have sub-tasks; the top one is the goal a
person typed.
_Avoid_: mission, work item, card, ticket, bead

**Attempt**: One run of a task on a runner.
_Avoid_: job, run, session, execution

**Queue**: The list of ready tasks waiting for a free runner slot, in the order the Governor
will start them, each with the reason it is not running yet. Priority and pause steer it.
_Avoid_: backlog, pipeline, line

**Limit**: A value that stops or delays work (a cap on spend, turns, tokens, tasks at once,
rounds or retries); each says where it is set and what is used.
_Avoid_: quota, budget (a budget is the complexity budget)

**Check**: The judgement of a task's result by something other than the agent that
produced it: another agent, or a person.
_Avoid_: verdict, evaluation, validation, review (a review is one kind of check)

**Approval**: A person's yes or no to one exact tool call with an effect, bound to what
they were shown.
_Avoid_: permit, sign-off (a sign-off is a person's check of a step with `approve`)

**Standing approval**: An approval given in advance in `brain.toml` for one tool, with
named targets, a daily limit and an end date.
_Avoid_: auto-approve, allow-list, autonomy

**Needs you**: The state of a task waiting for a person: a plan to confirm, an approval,
a check, a question or a sign-off.
_Avoid_: attention item, blocked, parked

**Shared notes**: The board of one goal that every agent working on it reads and writes.
_Avoid_: blackboard (in the product), brief, chat

**Snapshot**: The exact content of a workspace at one commit, addressed by its digest;
every task records the one it ran on.
_Avoid_: release, config digest, version

**Working copy**: A task's own checkout of the workspace's projects, where native tools
work; changes leave it only as a pull request.
_Avoid_: worktree, branch, sandbox (the sandbox contains it)

**Runner**: The executable that runs attempts and tools in sandboxes.
_Avoid_: worker, agent, executor

**Engine**: The model harness a runner drives for an attempt (for example pi or claude).
_Avoid_: model, provider, harness (in the product)

**Sandbox**: The container an attempt's engine or a tool call runs in; its only network
path is the egress proxy.
_Avoid_: environment, VM

**Governor**: The one server process: API, web app, orchestration and the record.
_Avoid_: control plane, backend, server (unqualified)

**Record**: What is kept for every task: evidence, check, approvals, cost and the audit
log.
_Avoid_: trace, history, trust layer

**Audit log**: The append-only, hash-chained list of every change and decision.
_Avoid_: event store, activity log
