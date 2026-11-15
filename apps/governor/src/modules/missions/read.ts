import type { ActorContext, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { workspaceSummary } from "../operations/read";
import { settleAll } from "./budget";
import { missionUsage, spendCapOf } from "./usage";

/**
 * bridge: the contract's WorkspaceSummary list — per-workspace counts rendered
 * by the Bridge screen, derived from the same read model workspace.context uses.
 */
export function bridge(store: Store, actor: ActorContext, workspaceIds: readonly string[]): JsonValue {
  const items = workspaceIds.slice(0, 25).map((id) => workspaceSummary(store, actor.organizationId, id) as unknown as JsonValue);
  return { items } as unknown as JsonValue;
}

type Db = ReturnType<Store["workspaceDb"]>;
const LIVE_SESSION = "('starting','running','waiting')";

export interface FleetMissionFact { missionId: string; title: string; state: string; runningTasks: number }
export interface FleetMemberFact { missionId: string; missionTitle: string; memberId: string; role: string; sessions: number }
export interface FleetFacts { missions: FleetMissionFact[]; members: FleetMemberFact[]; spentTodayMicroUsd: number; dailyCapMicroUsd?: number }

/**
 * What the fleet overview counts, read from the mission, session and spend records of one workspace. An open mission's running tasks are
 * its unsettled attempts (the figure Today's Working-now strip shows). A team member is active while a session serving a task assigned to
 * it is starting, running or waiting; spend today is the trailing 24 hours of settled cost plus open reservations (the daily cap's own figure).
 */
export function fleetFacts(store: Store, db: Db): FleetFacts {
  settleAll(store, db);
  const missions = (db.prepare("SELECT id, title, state FROM missions WHERE state!='closed' ORDER BY updated_at_ms DESC, id").all() as Array<{ id: string; title: string; state: string }>)
    .map((row) => ({ missionId: row.id, title: row.title, state: row.state, runningTasks: missionUsage(db, row.id).openAttempts }));
  const live = db.prepare(`SELECT m.id AS missionId, m.title AS missionTitle, m.active_plan_version_id AS planId, w.assignment_json AS assignment, COUNT(*) AS sessions
    FROM sessions s JOIN work_items w ON w.id=s.work_item_id JOIN missions m ON m.id=w.mission_id
    WHERE s.state IN ${LIVE_SESSION} AND m.state!='closed' GROUP BY m.id, w.assignment_json`).all() as Array<{ missionId: string; missionTitle: string; planId: string | null; assignment: string | null; sessions: number }>;
  const members = new Map<string, FleetMemberFact>();
  for (const row of live) {
    const assignment = row.assignment ? JSON.parse(row.assignment) as { kind?: string; id?: string } : undefined;
    if (assignment?.kind !== "agent" || !assignment.id) continue;
    const team = row.planId ? JSON.parse((db.prepare("SELECT team_json FROM plan_versions WHERE id=?").get(row.planId) as { team_json: string } | undefined)?.team_json ?? "[]") as Array<{ memberId: string; role: string }> : [];
    const key = `${row.missionId}:${assignment.id}`;
    const known = members.get(key);
    members.set(key, { missionId: row.missionId, missionTitle: row.missionTitle, memberId: assignment.id, role: team.find((entry) => entry.memberId === assignment.id)?.role ?? assignment.id, sessions: (known?.sessions ?? 0) + row.sessions });
  }
  const cap = spendCapOf(db, store.now());
  return { missions, members: [...members.values()], spentTodayMicroUsd: cap.dailySpentMicroUsd, ...(cap.dailyMicroUsd !== undefined ? { dailyCapMicroUsd: cap.dailyMicroUsd } : {}) };
}
