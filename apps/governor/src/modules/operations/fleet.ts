import type { ActorContext, FleetOverview, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { attentionItems } from "../stream/index";
import { fleetFacts } from "../missions/index";
import { listRunners, loadAttempt, runContext, runnerCapacity } from "../jobs/index";

type Condition = FleetOverview["missions"]["items"][number]["condition"];

/** The mission an approval's proposing attempt belongs to, when it belongs to one. */
function missionOfApproval(store: Store, db: ReturnType<Store["workspaceDb"]>, approvalId: string): string | undefined {
  const row = store.control.prepare("SELECT subject_json FROM approval_requests WHERE id=?").get(approvalId) as { subject_json: string } | undefined;
  if (!row) return undefined;
  try {
    const attemptId = (JSON.parse(row.subject_json) as { effectBounds?: { attemptId?: unknown } }).effectBounds?.attemptId;
    if (typeof attemptId !== "string") return undefined;
    return runContext(db, String(loadAttempt(store, attemptId)["workflow_run_id"]))?.missionId;
  } catch { return undefined; }
}

/**
 * fleet.overview: every member's glance at the workspace (spec #90, stories 43 and 44). Each open mission is counted once, in the first
 * condition that holds: needs attention (a blocking attention item names it), working (a task is running), else waiting. Conditions are
 * derived from the same records the attention list and Working-now strip read, never stored. Runner capacity is a sum; the runners
 * themselves are listed only for a holder of runner:admin.
 */
export function fleetOverview(store: Store, actor: ActorContext, workspaceId: string): JsonValue {
  requireWorkspaceRead(store, actor, workspaceId);
  const db = store.workspaceDb(workspaceId, actor.organizationId);
  const facts = fleetFacts(store, db);
  const blocking = attentionItems(store, actor.organizationId, [workspaceId]).filter((item) => item.tier <= 4);
  const needing = new Set<string>();
  let outside = 0;
  for (const item of blocking) {
    const missionId = item.missionId ?? (item.kind === "approval" ? missionOfApproval(store, db, item.resourceId) : undefined);
    if (missionId && facts.missions.some((mission) => mission.missionId === missionId)) needing.add(missionId); else outside += 1;
  }
  const items = facts.missions.map((mission) => ({
    missionId: mission.missionId, title: mission.title,
    condition: (needing.has(mission.missionId) ? "needs-attention" : mission.runningTasks > 0 ? "working" : "waiting") as Condition,
    runningTasks: mission.runningTasks,
  }));
  const count = (condition: Condition): number => items.filter((item) => item.condition === condition).length;
  const capacity = runnerCapacity(store, actor.organizationId);
  const listed = actor.scopes.includes("runner:admin")
    ? (listRunners(store, actor, 100) as unknown as { items: Array<{ runnerId: string; group: string; displayStatus: string; capacity: { slots: number }; reserved: { slots: number } }> }).items
    : undefined;
  const overview: FleetOverview = {
    workspaceId,
    missions: { open: items.length, working: count("working"), waiting: count("waiting"), needsAttention: count("needs-attention"), items: items.slice(0, 50) },
    activeMembers: { count: facts.members.length, items: facts.members.slice(0, 20) },
    runners: {
      registered: capacity.registered, online: capacity.online, slotsUsed: capacity.slotsUsed, slotsTotal: capacity.slotsTotal,
      ...(listed ? { detail: listed.map((entry) => ({ runnerId: entry.runnerId, group: entry.group, status: entry.displayStatus, slotsUsed: entry.reserved.slots, slotsTotal: entry.capacity.slots })) } : {}),
    },
    spend: { todayMicroUsd: facts.spentTodayMicroUsd, ...(facts.dailyCapMicroUsd !== undefined ? { dailyCapMicroUsd: facts.dailyCapMicroUsd } : {}) },
    attentionOutsideMissions: outside,
    observedAt: store.nowIso(),
  };
  return overview as unknown as JsonValue;
}
