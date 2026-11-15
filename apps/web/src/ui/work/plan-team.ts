import type { AgentCatalogEntry, PlanAssignment, PlanCandidate, PlanTask, TeamMember, WorkItem } from "@brain/contracts";
import { t } from "../../i18n";
import { formatUsd } from "../format";

/**
 * What the plan editor needs to know to change a step's assignment or the mission team: which agents a member may be bound to, whether a
 * member covers what a step requires (the same rule the Governor enforces when the version is proposed and again when it is confirmed),
 * and what a pending edit changes. Pure functions only.
 */

/** What eligibility needs of a published agent definition. */
export interface AgentFit { readonly agentId: string; readonly engines: readonly string[]; readonly tools: readonly string[]; readonly maxMicroUsd: number }

export const agentFits = (entries: readonly AgentCatalogEntry[]): AgentFit[] => entries.map((entry) => ({
  agentId: entry.release.id, engines: entry.definition.spec.engine.anyOf, tools: entry.definition.spec.tools.map((tool) => tool.id), maxMicroUsd: entry.definition.spec.maxMicroUsd,
}));

/** Why a member bound to this agent cannot take the step, or nothing when it can: tools and spend cap, never the role label. */
export function whyNotEligible(agent: AgentFit | undefined, task: Pick<PlanTask, "requiredTools" | "maxMicroUsd">): string | undefined {
  if (!agent) return undefined;
  const missing = (task.requiredTools ?? []).filter((tool) => !agent.tools.includes(tool));
  if (missing.length > 0) return t("plan.team.lacks-tools", { tools: missing.join(", ") });
  if (task.maxMicroUsd !== undefined && agent.maxMicroUsd > 0 && task.maxMicroUsd > agent.maxMicroUsd) return t("plan.team.cap-below", { cap: formatUsd(agent.maxMicroUsd), need: formatUsd(task.maxMicroUsd) });
  return undefined;
}

/** The steps whose assigned member cannot take them, with why: nothing is confirmed while any remain. */
export function ineligibleSteps(tasks: readonly PlanTask[], team: readonly TeamMember[], agents: readonly AgentFit[] | undefined): Array<{ task: PlanTask; reason: string }> {
  return tasks.flatMap((task) => {
    const member = assignedMember(task, team);
    const reason = member ? whyNotEligible(agents?.find((agent) => agent.agentId === member.agentId), task) : undefined;
    return reason ? [{ task, reason }] : [];
  });
}

/** Work that has started is never changed in place: its step keeps its assignment and its member keeps its binding. */
export const isStartedWork = (item: Pick<WorkItem, "state" | "parked">): boolean => item.state === "in-progress" || item.state === "review" || item.state === "done" || (item.state === "blocked" && !item.parked);

/** An id a person never has to type: the role as a ConfigId (`^[a-z][a-z0-9.-]*$`), made unique among the members already there. */
export function memberIdFor(role: string, taken: readonly string[]): string {
  const base = role.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^[^a-z]+/u, "").replace(/-+$/u, "").slice(0, 56) || "member";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

export const memberLabel = (member: Pick<TeamMember, "role" | "memberId">): string => `${member.role} (${member.memberId})`;

/** The team member a step is assigned to, when it is assigned to one of this team's members. */
export const assignedMember = (task: Pick<PlanTask, "assignment">, team: readonly TeamMember[]): TeamMember | undefined => task.assignment?.kind === "agent" ? team.find((member) => member.memberId === task.assignment?.id) : undefined;

export const assignTo = (task: PlanTask, memberId: string): PlanTask => {
  const { assignment: previous, ...rest } = task;
  if (!memberId) return rest;
  const assignment: PlanAssignment = { kind: "agent", id: memberId, role: previous?.role ?? "specialist" };
  return { ...rest, assignment };
};

/** Plain-words lines for what a pending edit does to assignments and to the team, against the version it starts from. */
export function assignmentChanges(before: { readonly tasks: readonly PlanTask[]; readonly team?: readonly TeamMember[] | undefined }, tasks: readonly PlanTask[], team: readonly TeamMember[]): string[] {
  const priorTeam = before.team ?? [];
  const nameOf = (id: string | undefined, members: readonly TeamMember[]) => (id ? (members.find((member) => member.memberId === id) ? memberLabel(members.find((member) => member.memberId === id) as TeamMember) : id) : t("plan.team.unassigned"));
  const lines: string[] = [];
  for (const task of tasks) {
    const prior = before.tasks.find((entry) => entry.id === task.id);
    if (!prior || JSON.stringify(prior.assignment ?? null) === JSON.stringify(task.assignment ?? null)) continue;
    lines.push(t("plan.team.change-reassigned", { step: task.title, from: nameOf(prior.assignment?.id, priorTeam), to: nameOf(task.assignment?.id, team) }));
  }
  for (const member of team) if (!priorTeam.some((entry) => entry.memberId === member.memberId)) lines.push(t("plan.team.change-added", { member: memberLabel(member), agent: member.agentId, engine: member.engine }));
  for (const member of priorTeam) if (!team.some((entry) => entry.memberId === member.memberId)) lines.push(t("plan.team.change-removed", { member: memberLabel(member) }));
  return lines;
}

/**
 * What using a standing team does to the team being edited: its members are copied in (a member already there with the same agent and engine
 * is the same member), and one bound differently is a collision named for the person. This is the rule the Governor applies on a reference.
 */
export function copyStandingTeam(team: readonly TeamMember[], standing: readonly TeamMember[]): { team: TeamMember[]; added: TeamMember[]; collisions: Array<{ member: TeamMember; existing: TeamMember }> } {
  const result = [...team];
  const added: TeamMember[] = [];
  const collisions: Array<{ member: TeamMember; existing: TeamMember }> = [];
  for (const member of standing) {
    const existing = result.find((entry) => entry.memberId === member.memberId);
    if (!existing) { const copy = { memberId: member.memberId, role: member.role, agentId: member.agentId, engine: member.engine }; result.push(copy); added.push(copy); }
    else if (existing.agentId !== member.agentId || existing.engine !== member.engine) collisions.push({ member, existing });
  }
  return { team: collisions.length ? [...team] : result, added: collisions.length ? [] : added, collisions };
}

/** What a candidate row of the editor stands for: a team member, a way of working, or nothing chosen yet. */
export const candidateChoice = (candidate: PlanCandidate): string => (candidate.memberId ? `member:${candidate.memberId}` : candidate.workflowId ? `workflow:${candidate.workflowId}` : "");

/** A step has N candidates (2 to 4), or none (ADR 0071). Growing keeps what was chosen; shrinking drops the last ones; one attempt removes the field. */
export function withCandidateCount(task: PlanTask, count: number): PlanTask {
  const { candidates, ...rest } = task;
  if (count < 2) return rest;
  return { ...rest, candidates: Array.from({ length: Math.min(4, count) }, (_, index) => candidates?.[index] ?? { id: `c${index + 1}` }) };
}

export function withCandidateChoice(task: PlanTask, position: number, choice: string): PlanTask {
  if (!task.candidates) return task;
  const [kind, ...rest] = choice.split(":");
  const id = rest.join(":");
  return { ...task, candidates: task.candidates.map((candidate, index) => index !== position ? candidate : { id: candidate.id, ...(kind === "member" && id ? { memberId: id } : {}), ...(kind === "workflow" && id ? { workflowId: id } : {}) }) };
}

/** Whether a step's candidates are all chosen and no two alike: the same rule the Governor applies. */
export const candidatesComplete = (task: Pick<PlanTask, "candidates">): boolean => {
  const choices = (task.candidates ?? []).map((candidate) => candidateChoice(candidate));
  return choices.every(Boolean) && new Set(choices).size === choices.length;
};
