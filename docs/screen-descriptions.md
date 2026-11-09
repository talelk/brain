# Screen descriptions

What each Brain screen is for, who uses it and its main action. The authority is
`contracts/v1/ui-screen-contracts.json`; `apps/web/src/routes/index.gen.ts` is generated
from it. For workflow behavior read the [functional specification](functional-spec.md);
for step-by-step guides, `docs/howto/`. This page covers structure and journeys, not
layout details, which change often.

Last reviewed against commit 6fb59ae.

## How the app is organized

- **Five primary areas:** Missions, Live, Logs, Outputs, Plays. Each has a short
  secondary menu of related screens.
- **Knowledge** sits under **More** (Knowledge, Review, Studio).
- **Approvals** are under Missions. **Runners** are under Live (administrators).
- **Administration** is in the account menu: Workspaces, Setup, Security,
  Integrations, Releases, People, Invitations, Access, Authentication, Health. Entries
  appear only for people who hold the authority.
- **Kiosk wallboards** (`/tv/*`) are read-only and separate from the main app.

Every screen handles loading, empty, no-access, stale, partial-failure, retry and
offline states. Filters and selection live in the URL, so a shared link restores the
view. Authorization is checked on each action: a screen may be visible while an action
is unavailable to your role.

## Missions

| Screen | Route | Who | Main action |
|---|---|---|---|
| Missions | `/w/:id/missions` | Everyone | See what needs you (attention list), open a mission |
| New mission | `/w/:id/missions/new` | Workspace members | Start from a play or describe the work |
| Mission | `/missions/:missionId/:tab` | Members | Follow and steer one mission |
| Approvals | `/approvals` | Reviewers | Find pending decisions |
| Approval review | `/approvals/:id` | Reviewers | Approve or reject the exact proposed effect |

A mission has tabs: **Live** (what is running now), **Team**, **Plan** (proposed tasks
and their state), **Brief** (goal and settings), **Logs** and **Outputs**. A banner
suggests the one next step, such as preparing a plan, starting ready tasks, following
running work or reviewing outputs. You can pause, resume, message, propose completion
and close from here.

## Live and runs

| Screen | Route | Who | Main action |
|---|---|---|---|
| Live | `/w/:id/live` | Members | See running sessions and jobs, steer or stop them |
| Live console | `/sessions/:id` | Members | Read one session and steer or stop it |
| Run inspector | `/runs/:id` | Members | Check one run's attempts, evidence and placement; cancel or reconcile |
| Runners | `/runners` | Administrators | See runner health, capabilities, heartbeat |
| Runner detail | `/runners/:id` | Administrators | Drain or quarantine a runner |

There is no separate runs list; runs are reached from Live, a mission or a log line.

## Logs and Outputs

| Screen | Route | Main action |
|---|---|---|
| Logs | `/w/:id/logs` | Search execution and platform logs; jump to related context |
| Outputs | `/w/:id/outputs` | Browse what missions produced |
| Output | `/outputs/:id` | Inspect one output, its versions and where it came from |
| Compare | `/outputs/:id/compare` | Compare two versions with their provenance |

## Plays

| Screen | Route | Main action |
|---|---|---|
| Plays | `/w/:id/plays` | Start a mission from a play, run a single task, or describe the work |
| Play | `/plays/:id` | Review a play, its schedules and history, then start it |
| Support | `/w/:id/plays/support` | Work the ticket queue and SLA summary |
| Ticket | `/tickets/:id` | Review one ticket and start a task for it |
| Incidents | `/w/:id/plays/sre` | Work the incident list |
| Incident | `/incidents/:id` | Review one incident and start a task for it |

Schedules are set on the Play screen and shown on the mission's automations.

## Knowledge (under More)

| Screen | Route | Main action |
|---|---|---|
| Knowledge | `/w/:id/knowledge` | Search memory, documents and trusted tools; upload, publish or revoke |
| Review | `/w/:id/knowledge/review` | Review knowledge and capability candidates; run capitalization |
| Studio | `/studio/:kind` | Start a new agent or workflow definition without editing YAML |
| Configuration Studio | `/studio/:kind/:draftId` | Edit, validate, test and publish a draft |

Publishing needs a reviewer different from the publisher. Publishing a definition
needs a verified configuration write binding (Administration, Integrations) and the
result is activated separately as a release.

## Administration (account menu)

| Screen | Route | Main action |
|---|---|---|
| Workspaces | `/administration/workspaces` | Create, update and control workspaces |
| Setup | `/settings?tab=setup` | Connect a model, start runners, run the installation test |
| Security | `/settings?tab=security` | Your own sessions and two-factor settings |
| Integrations | `/administration/integrations` | Connect Git providers; bind repositories to workspaces |
| Releases | `/settings?tab=release` | Inspect and activate a release |
| People | `/settings?tab=people` | Organization members, suspend and reactivate |
| Invitations | `/settings?tab=invitations` | Invite, cancel or retry |
| Access | `/settings?tab=members` | Grant or revoke workspace roles |
| Authentication | `/settings?tab=policy` | Organization sign-in policy |
| Health | `/settings?tab=health` | Platform health, audit |
| Accept invitation | `/accept-invitation/:id` | Verify an invited account and join |

## Kiosk

`/tv/:play` (for example `/tv/support`, `/tv/sre`) shows a redacted, read-only
aggregate for a wall display. It never shows private ticket bodies and has no actions.

## Journeys

1. **First run and setup.** Sign in, open Administration, Setup, connect the model and
   run the installation test. See [Run your first task](howto/use-brain.md).
2. **Create a mission.** Missions, New mission, pick a play or describe the work.
3. **Plan, confirm, start.** Open the Plan tab, review the proposed tasks and confirm.
   Confirmed tasks start automatically by default; the mission setting `autoStart`
   (labelled "Ask me before each task") turns that off. _Pending merge: not yet in
   `contracts/v1/brain.schema.json` on main._
4. **Follow live.** Mission Live tab or the Live area; open a session to steer or stop.
5. **Review outputs and evidence.** Outputs tab; open an output, then its run's
   evidence. A model reply alone is not a pass; check the validation verdict.
6. **Close.** Propose completion, then close the mission.
7. **Approvals.** Approvals shows pending decisions; each is one exact effect. See
   [Runs and approvals](howto/operate-runs-and-approvals.md).
8. **Knowledge capture.** Upload documents or publish memory in Knowledge; review
   candidates in Review.
9. **Schedules.** On a Play, add a schedule; pause or resume it from the same place.
10. **Runners.** Live, Runners: check heartbeat, drain or quarantine.
