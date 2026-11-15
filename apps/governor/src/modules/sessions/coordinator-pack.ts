import type { AutonomyPolicy, PlanTask, TeamMember } from "@brain/contracts";
import type { Store } from "../../application/store";
import { parseCriteria } from "../../domain/criteria";
import type { PackItem, PackSection } from "./context-pack";

type Db = ReturnType<Store["workspaceDb"]>;

const MESSAGES_SHOWN = 10;

/**
 * What a coordinator's wake reads (ADR 0045): the mission as a planner needs it, built by the Governor from declared sections only. A coordinator
 * session serves no work item, so this is its context pack; it holds what `plan.propose` needs, because a version must repeat every started task
 * unchanged and name the team it keeps.
 *   - the brief, the success criteria (as `c1: words`, the ids a task serves) and the autonomy policy (what it may change without a person);
 *   - the confirmed plan's tasks and team exactly as the Governor stores them, and where each task's work stands;
 *   - the handoff notes of finished tasks, the proposals still waiting for a person, and the messages sent to the mission.
 * Messages shown here count as delivered, as a work item's pack does for its own.
 */
export function coordinatorSections(db: Db, missionId: string): PackSection[] | undefined {
  const mission = db.prepare("SELECT intent, success_criteria_json, policy_json, state, active_plan_version_id FROM missions WHERE id=?").get(missionId) as
    | { intent: string; success_criteria_json: string; policy_json: string; state: string; active_plan_version_id: string | null } | undefined;
  if (!mission) return undefined;
  const brief = db.prepare("SELECT intent, constraints_json FROM mission_brief_versions WHERE mission_id=? ORDER BY version DESC LIMIT 1").get(missionId) as { intent: string; constraints_json: string } | undefined;
  const constraints = brief ? (JSON.parse(brief.constraints_json) as string[]) : [];
  const policy = JSON.parse(mission.policy_json) as AutonomyPolicy;
  const fact = (id: string, text: string): PackItem => ({ id, text, prose: false });
  const prose = (id: string, text: string, label: string): PackItem => ({ id, text, prose: true, label });
  const active = mission.active_plan_version_id
    ? db.prepare("SELECT id, revision, tasks_json, team_json FROM plan_versions WHERE id=?").get(mission.active_plan_version_id) as { id: string; revision: number; tasks_json: string; team_json: string } | undefined
    : undefined;
  const tasks = active ? (JSON.parse(active.tasks_json) as PlanTask[]) : [];
  const team = active ? (JSON.parse(active.team_json) as TeamMember[]) : [];

  // The latest live work item of each plan task: where its work stands now.
  const latest = new Map<string, { id: string; state: string; parked: number; failed_attempts: number; failure_class: string | null; next_action: string }>();
  for (const item of db.prepare("SELECT id, plan_task_id, state, parked, failed_attempts, failure_class, next_action FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY created_at_ms DESC, id DESC").all(missionId) as Array<{ id: string; plan_task_id: string; state: string; parked: number; failed_attempts: number; failure_class: string | null; next_action: string }>) {
    if (!latest.has(item.plan_task_id)) latest.set(item.plan_task_id, item);
  }
  const standing = tasks.map((task) => {
    const item = latest.get(task.id);
    if (!item) return fact(`work-${task.id}`, `- ${task.id}: no work yet`);
    const detail = item.parked === 1 ? `parked${item.failure_class ? ` (${item.failure_class})` : ""}; ${item.next_action}` : item.state === "ready" || item.state === "backlog" ? `not started (${item.state})` : item.state;
    return fact(`work-${task.id}`, `- ${task.id}: ${detail}${item.failed_attempts > 0 ? `; ${item.failed_attempts} failed attempt(s)` : ""}`);
  });
  const notes = [...latest.entries()].flatMap(([taskId, item]) => {
    if (item.state !== "done") return [];
    const row = db.prepare("SELECT notes_json FROM handoffs WHERE work_item_id=? AND superseded_by IS NULL ORDER BY version DESC LIMIT 1").get(item.id) as { notes_json: string } | undefined;
    const summary = row ? (JSON.parse(row.notes_json) as { summary?: string; openQuestions?: string[]; nextAction?: string }) : undefined;
    if (!summary?.summary) return [];
    const parts = [summary.summary, ...(summary.openQuestions?.length ? [`Open questions: ${summary.openQuestions.join("; ")}`] : []), ...(summary.nextAction ? [`Suggested next action: ${summary.nextAction}`] : [])];
    return [prose(`handoff-${taskId}`, `- ${taskId}: ${parts.join(" ")}`, `Handoff note of ${taskId}`)];
  });
  const proposals = (db.prepare("SELECT id, revision, origin, summary FROM plan_versions WHERE mission_id=? AND state='proposed' ORDER BY revision").all(missionId) as Array<{ id: string; revision: number; origin: string; summary: string | null }>)
    .map((row) => fact(row.id, `- revision ${row.revision} (${row.origin})${row.summary ? `: ${row.summary}` : ""} waits for a person`));

  db.prepare("UPDATE mission_messages SET delivery='delivered-at-session-start' WHERE delivery='pending' AND mission_id=? AND recipient_kind='mission' AND work_item_id IS NULL").run(missionId);
  const messages = (db.prepare("SELECT id, body, sender_id FROM mission_messages WHERE mission_id=? AND recipient_kind='mission' AND work_item_id IS NULL AND delivery IN ('delivered-at-session-start','delivered-live') ORDER BY created_at_ms DESC, id DESC LIMIT ?")
    .all(missionId, MESSAGES_SHOWN) as Array<{ id: string; body: string; sender_id: string }>).reverse().map((row) => prose(row.id, `- ${row.sender_id === "governor" ? "Brain: " : ""}${row.body}`, "A message sent to the mission"));

  const criteria = parseCriteria(mission.success_criteria_json).map((criterion) => `${criterion.id}: ${criterion.text}`);
  return [
    { id: "brief", title: "Mission brief", label: "fact", items: [
      fact("goal", `Goal: ${brief?.intent ?? mission.intent}`),
      ...(constraints.length > 0 ? [fact("constraints", `Constraints:\n${constraints.map((entry) => `- ${entry}`).join("\n")}`)] : []),
      fact("mission-criteria", `Mission success criteria:\n${criteria.join("\n")}`),
      fact("state", `The mission is ${mission.state}.`),
    ] },
    { id: "autonomy", title: "What you may change without a person", label: "fact", items: [
      fact("policy", `Autonomy policy ${policy.preset}: ${policy.operations.length > 0 ? policy.operations.join(", ") : "no plan operation"}. A plan version that needs anything else waits for a person to confirm it.`),
    ] },
    { id: "team", title: "Team", label: "fact", items: team.map((member) => fact(member.memberId, `- ${member.memberId}: ${member.role} (agent ${member.agentId}, engine ${member.engine})`)) },
    { id: "plan", title: active ? `Confirmed plan, revision ${active.revision}` : "Confirmed plan", label: "fact", items: active ? [fact("tasks", `Tasks: ${JSON.stringify(tasks)}`)] : [] },
    { id: "work", title: "Where each task stands", label: "fact", items: standing },
    { id: "handoffs", title: "Handoff notes of finished tasks (written by the members)", label: "claim", items: notes },
    { id: "proposals", title: "Plan proposals waiting for a person", label: "fact", items: proposals },
    { id: "messages", title: "Messages sent to the mission", label: "claim", items: messages },
  ];
}
