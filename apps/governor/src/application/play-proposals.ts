import { createHash } from "node:crypto";
import type { ActorContext, AutonomyPolicy, PlanTask, PlaySpec, TeamMember } from "@brain/contracts";
import { stringify } from "yaml";
import { handlersFor, type CommandHandlers } from "./command-funnel";
import { requireWorkspaceRead } from "./authz";
import type { Store } from "./store";
import { BrainDomainError } from "../domain/errors";
import { iso } from "../domain/clock";
import { practiceConfig } from "./practices";

/**
 * Suggest a Play from an achieved mission (issue #74, ADR 0015). Plays are release-defined content, so a proposal is never a Play:
 * it is a reviewable description built only from the mission's stored, confirmed plan version, its team and its success criteria.
 * Approving it opens an ordinary configuration draft (kind Play) in the Studio; nothing activates until a person validates,
 * publishes, stages and activates that draft through the existing steps.
 */
export interface PlayProposalView {
  readonly proposalId: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly state: "proposed" | "approved" | "rejected";
  readonly playId: string;
  readonly spec: PlaySpec;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  readonly reason?: string;
  readonly draftId?: string;
  readonly selfReviewed?: boolean;
  /** The practice tag and the missions a team-built proposal came from. */
  readonly practice?: string;
  readonly sourceMissionIds?: readonly string[];
}

interface Row {
  id: string; mission_id: string; state: PlayProposalView["state"]; play_id: string; spec_json: string; proposed_by: string; created_at_ms: number;
  reviewed_by: string | null; reviewed_at_ms: number | null; reason: string | null; draft_id: string | null; self_reviewed: number;
  practice: string | null; source_missions_json: string | null;
}

interface MissionRow {
  id: string; title: string; intent: string; success_criteria_json: string; state: string; outcome: string | null; active_plan_version_id: string | null; policy_json: string;
  parking_threshold: number; budget_micro_usd: number | null; member_cap: number; coordinator_member_id: string | null; updated_at_ms: number;
}

interface Ports {
  readonly store: Store;
  /** Opens a configuration draft (the existing `configDraft.create` handler) and returns its id. */
  createDraft(actor: ActorContext, workspaceId: string, input: { title: string; kind: "Play"; documents: Array<{ path: string; text: string }> }): string;
  /** The ids of the Plays of the active release, so a proposal never collides with one. */
  existingPlayIds(organizationId: string): readonly string[];
  /** The Plays of the active release with the practice each is tagged with. */
  releasePlays(organizationId: string): ReadonlyArray<{ id: string; practice?: string }>;
}

const cut = (text: string, max: number) => text.length > max ? text.slice(0, max) : text;

/** A play id: lowercase, starts with a letter, at most 64 characters, stable per mission, unique among the release's Plays. */
function playIdFor(title: string, missionId: string, taken: readonly string[]): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "");
  const stem = /^[a-z]/u.test(base) ? base : `play-${base}`.replace(/-+$/u, "");
  const root = stem || "play";
  if (!taken.includes(root)) return root;
  return `${root}-${createHash("sha256").update(missionId).digest("hex").slice(0, 6)}`;
}

/** What a Play carries from a task: the shape of the work, never a mission's own references (inputs from other missions are dropped). */
function taskOf(task: PlanTask): PlanTask {
  return {
    id: task.id, title: cut(task.title, 256), criteria: task.criteria.map((entry) => cut(entry, 1024)), dependsOn: [...task.dependsOn],
    ...(task.assignment ? { assignment: task.assignment } : {}), ...(task.workflowId ? { workflowId: task.workflowId } : {}),
    ...(task.estimatedMinutes !== undefined ? { estimatedMinutes: task.estimatedMinutes } : {}), ...(task.optional ? { optional: true } : {}),
    ...(task.requiredTools?.length ? { requiredTools: [...task.requiredTools] } : {}), ...(task.outputs?.length ? { outputs: [...task.outputs] } : {}),
  };
}

const viewOf = (row: Row, missionTitle: string): PlayProposalView => ({
  proposalId: row.id, missionId: row.mission_id, missionTitle, state: row.state, playId: row.play_id, spec: JSON.parse(row.spec_json) as PlaySpec,
  proposedBy: row.proposed_by, proposedAt: iso(row.created_at_ms), ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
  ...(row.reviewed_at_ms !== null ? { reviewedAt: iso(row.reviewed_at_ms) } : {}), ...(row.reason ? { reason: row.reason } : {}),
  ...(row.draft_id ? { draftId: row.draft_id } : {}), ...(row.self_reviewed === 1 ? { selfReviewed: true } : {}),
  ...(row.practice ? { practice: row.practice } : {}), ...(row.source_missions_json ? { sourceMissionIds: JSON.parse(row.source_missions_json) as string[] } : {}),
});

const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length > 2));
/** How alike two missions' plans are: the overlap of the words in their task titles. */
function planSimilarity(a: PlanTask[], b: PlanTask[]): number {
  const left = words(a.map((task) => task.title).join(" ")); const right = words(b.map((task) => task.title).join(" "));
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

export class PlayProposals {
  constructor(private readonly ports: Ports) {}

  commands(): CommandHandlers {
    const { store } = this.ports;
    return {
      ...handlersFor(["play.propose"], {
        kind: "workspace",
        handle: ({ actor, cmd, workspaceId }) => {
          requireWorkspaceRead(store, actor, workspaceId);
          const db = store.workspaceDb(workspaceId, actor.organizationId);
          const missionId = String(cmd.payload["missionId"]);
          const mission = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as MissionRow | undefined;
          if (!mission) throw new BrainDomainError("NOT_FOUND", "mission not found");
          // Only a mission that was achieved and signed off is worth repeating; a cancelled or ended one is not offered.
          if (mission.state !== "closed" || mission.outcome !== "achieved") throw new BrainDomainError("CONFLICT", "only an achieved mission can be proposed as a Play");
          if (db.prepare("SELECT 1 FROM play_proposals WHERE mission_id=?").get(missionId)) throw new BrainDomainError("CONFLICT", "this mission already has a Play proposal");
          const spec = this.specOf(db, mission);
          const playId = playIdFor(mission.title, mission.id, this.ports.existingPlayIds(actor.organizationId));
          const id = store.id("playprop");
          db.prepare("INSERT INTO play_proposals(id,mission_id,state,play_id,spec_json,proposed_by,created_at_ms) VALUES (?,?,'proposed',?,?,?,?)").run(id, mission.id, playId, JSON.stringify(spec), actor.actorId, store.now());
          store.emit(db, { workspaceId, aggregateType: "playProposal", aggregateId: id, eventType: "playProposal.proposed", payload: { proposalId: id, missionId: mission.id, playId } });
          return { resourceId: id };
        },
      }),
      // A Play from a team's own verified missions (Phase 4): the structure is chosen from stored records alone, no model is asked, and the
      // result is an ordinary proposal that still needs a person (ADR 0015).
      ...handlersFor(["play.proposeFromMissions"], {
        kind: "workspace",
        handle: ({ actor, cmd, workspaceId }) => {
          requireWorkspaceRead(store, actor, workspaceId);
          const config = practiceConfig();
          const practice = String(cmd.payload["practice"]);
          const known = config.practices.find((entry) => entry.id === practice);
          if (!known) throw new BrainDomainError("INVALID_ARGUMENT", `practice ${practice} is not configured; choose ${config.practices.map((entry) => entry.id).join(", ")}`);
          const db = store.workspaceDb(workspaceId, actor.organizationId);
          const candidates = this.verifiedMissions(db);
          if (candidates.length < config.minMissions) throw new BrainDomainError("CONFLICT", `a practice Play needs at least ${config.minMissions} verified missions of this team that no proposal is built on yet; there ${candidates.length === 1 ? "is" : "are"} ${candidates.length}`);
          // The reference is the mission whose plan is most like the others: the shape this team actually repeats. A tie goes to the newest.
          const scored = candidates.map((candidate) => ({ candidate, score: candidates.reduce((sum, other) => sum + (other.mission.id === candidate.mission.id ? 0 : planSimilarity(candidate.tasks, other.tasks)), 0) }))
            .sort((x, y) => y.score - x.score || y.candidate.mission.updated_at_ms - x.candidate.mission.updated_at_ms || x.candidate.mission.id.localeCompare(y.candidate.mission.id));
          const reference = scored[0]!.candidate.mission;
          const spec: PlaySpec = { ...this.specOf(db, reference), practice,
            description: cut(`${known.title} Play built from ${candidates.length} verified missions of this team: ${candidates.map((entry) => cut(entry.mission.title, 80)).join("; ")}.`, 4000) };
          const sources = candidates.map((entry) => entry.mission.id).sort();
          const playId = playIdFor(`${practice} ${reference.title}`, reference.id, this.ports.existingPlayIds(actor.organizationId));
          const id = store.id("playprop");
          db.prepare("INSERT INTO play_proposals(id,mission_id,state,play_id,spec_json,proposed_by,created_at_ms,practice,source_missions_json) VALUES (?,?,'proposed',?,?,?,?,?,?)")
            .run(id, reference.id, playId, JSON.stringify(spec), actor.actorId, store.now(), practice, JSON.stringify(sources));
          store.emit(db, { workspaceId, aggregateType: "playProposal", aggregateId: id, eventType: "playProposal.proposed", payload: { proposalId: id, missionId: reference.id, playId, practice, sourceMissions: sources.length } });
          return { resourceId: id };
        },
      }),
      ...handlersFor(["play.proposal.review"], {
        kind: "self",
        handle: ({ actor, cmd, workspaceId }) => {
          requireWorkspaceRead(store, actor, workspaceId);
          const db = store.workspaceDb(workspaceId, actor.organizationId);
          const id = String(cmd.payload["proposalId"]);
          const decision = String(cmd.payload["decision"]);
          const reason = String(cmd.payload["reason"]);
          const row = db.prepare("SELECT * FROM play_proposals WHERE id=?").get(id) as Row | undefined;
          if (!row) throw new BrainDomainError("NOT_FOUND", "Play proposal not found");
          if (row.state !== "proposed") {
            // A retried decision returns what it already did.
            if ((row.state === "approved") === (decision === "approve")) return { resourceId: id };
            throw new BrainDomainError("CONFLICT", `this proposal was already ${row.state}`);
          }
          const now = store.now();
          if (decision === "reject") {
            db.prepare("UPDATE play_proposals SET state='rejected', reviewed_by=?, reviewed_at_ms=?, reason=? WHERE id=? AND state='proposed'").run(actor.actorId, now, reason, id);
            store.emit(db, { workspaceId, aggregateType: "playProposal", aggregateId: id, eventType: "playProposal.rejected", payload: { proposalId: id } });
            return { resourceId: id };
          }
          // Approval only opens a draft in the Studio. It never compiles, publishes or activates anything.
          const spec = JSON.parse(row.spec_json) as PlaySpec;
          const document = { path: `plays/${row.play_id}.yaml`, text: stringify({ apiVersion: "brain.keyrus/v1", kind: "Play", metadata: { id: row.play_id, version: "1.0.0" }, spec }) };
          const draftId = this.ports.createDraft(actor, workspaceId, { title: spec.title, kind: "Play", documents: [document] });
          // The producer may approve their own proposal: nothing here grants authority, and the draft still needs validation and activation (ADR 0007, ADR 0015).
          const selfReviewed = row.proposed_by === actor.actorId ? 1 : 0;
          db.prepare("UPDATE play_proposals SET state='approved', reviewed_by=?, reviewed_at_ms=?, reason=?, draft_id=?, self_reviewed=? WHERE id=? AND state='proposed'").run(actor.actorId, now, reason, draftId, selfReviewed, id);
          store.emit(db, { workspaceId, aggregateType: "playProposal", aggregateId: id, eventType: "playProposal.approved", payload: { proposalId: id, draftId, selfReviewed: selfReviewed === 1 } });
          return { resourceId: draftId };
        },
      }),
    };
  }

  /** The spec a mission's stored, confirmed plan, team and criteria make. Throws when the mission has no confirmed plan. */
  private specOf(db: ReturnType<Store["workspaceDb"]>, mission: MissionRow): PlaySpec {
    const plan = mission.active_plan_version_id ? db.prepare("SELECT tasks_json, team_json FROM plan_versions WHERE id=? AND state='confirmed'").get(mission.active_plan_version_id) as { tasks_json: string; team_json: string } | undefined : undefined;
    if (!plan) throw new BrainDomainError("EVIDENCE_MISSING", "the mission has no confirmed plan to build a Play from");
    const tasks = (JSON.parse(plan.tasks_json) as PlanTask[]).map(taskOf);
    const team = JSON.parse(plan.team_json) as TeamMember[];
    const criteria = (JSON.parse(mission.success_criteria_json) as string[]).map((entry) => cut(String(entry), 1024));
    const policy = JSON.parse(mission.policy_json) as AutonomyPolicy;
    return {
      title: cut(mission.title, 256), intent: cut(mission.intent, 8000), successCriteria: criteria.length ? criteria : ["The result is independently verified"],
      team: team.map((member) => ({ memberId: member.memberId, role: member.role, agentId: member.agentId, engine: member.engine })),
      ...(mission.coordinator_member_id ? { coordinator: mission.coordinator_member_id } : {}),
      plan: { tasks }, autonomy: policy.preset ?? "standard", parkingThreshold: mission.parking_threshold,
      budget: { memberCap: mission.member_cap, ...(mission.budget_micro_usd !== null ? { maxMicroUsd: mission.budget_micro_usd } : {}) },
    };
  }

  /** Missions closed as achieved (which already needed a verified verdict) with a confirmed plan, that no proposal is built on or anchored on yet. */
  private verifiedMissions(db: ReturnType<Store["workspaceDb"]>): Array<{ mission: MissionRow; tasks: PlanTask[] }> {
    const used = new Set<string>();
    for (const row of db.prepare("SELECT mission_id, source_missions_json FROM play_proposals").all() as Array<{ mission_id: string; source_missions_json: string | null }>) {
      used.add(row.mission_id);
      for (const id of row.source_missions_json ? JSON.parse(row.source_missions_json) as string[] : []) used.add(id);
    }
    const rows = (db.prepare("SELECT * FROM missions WHERE state='closed' AND outcome='achieved' ORDER BY updated_at_ms DESC, id").all() as MissionRow[]).filter((mission) => !used.has(mission.id));
    const out: Array<{ mission: MissionRow; tasks: PlanTask[] }> = [];
    for (const mission of rows) {
      const plan = mission.active_plan_version_id ? db.prepare("SELECT tasks_json FROM plan_versions WHERE id=? AND state='confirmed'").get(mission.active_plan_version_id) as { tasks_json: string } | undefined : undefined;
      if (plan) out.push({ mission, tasks: JSON.parse(plan.tasks_json) as PlanTask[] });
    }
    return out;
  }

  /** practices.list: the configured practices with the Plays of the active release tagged for each, this team's proposals, and how many verified missions could feed the next one. */
  practices(actor: ActorContext, workspaceId: string): unknown {
    requireWorkspaceRead(this.ports.store, actor, workspaceId);
    const config = practiceConfig();
    const db = this.ports.store.workspaceDb(workspaceId, actor.organizationId);
    const eligible = this.verifiedMissions(db).length;
    const proposals = (db.prepare("SELECT id, state, play_id, practice FROM play_proposals WHERE practice IS NOT NULL ORDER BY created_at_ms DESC").all() as Array<{ id: string; state: string; play_id: string; practice: string }>);
    const plays = this.ports.releasePlays(actor.organizationId);
    return {
      minMissions: config.minMissions, eligibleMissions: eligible,
      practices: config.practices.map((entry) => ({ ...entry, plays: plays.filter((play) => play.practice === entry.id).map((play) => play.id),
        proposals: proposals.filter((proposal) => proposal.practice === entry.id).map((proposal) => ({ proposalId: proposal.id, state: proposal.state, playId: proposal.play_id })), canPropose: eligible >= config.minMissions })),
    };
  }

  list(actor: ActorContext, workspaceId: string, limit = 50): { items: PlayProposalView[] } {
    requireWorkspaceRead(this.ports.store, actor, workspaceId);
    const db = this.ports.store.workspaceDb(workspaceId, actor.organizationId);
    const rows = db.prepare("SELECT * FROM play_proposals ORDER BY (state='proposed') DESC, created_at_ms DESC, id LIMIT ?").all(limit) as Row[];
    return { items: rows.map((row) => viewOf(row, (db.prepare("SELECT title FROM missions WHERE id=?").get(row.mission_id) as { title: string } | undefined)?.title ?? row.mission_id)) };
  }
}
