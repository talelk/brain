import type { ActorContext, PlanTask, StandingTeam, TeamMember } from "@brain/contracts";
import type { Store } from "../../application/store";
import { assertExpectedVersion } from "../../domain/states";
import { BrainDomainError } from "../../domain/errors";
import { assertTeamEligible, type AgentCapabilities } from "../../domain/mission-policy";

type Db = ReturnType<Store["workspaceDb"]>;
type Row = { id: string; name: string; description: string; members_json: string; coordinator_member_id: string | null; state: "active" | "archived"; version: number; created_by: string; created_at_ms: number; updated_at_ms: number };

/** A standing team stays small enough to read at a glance and to copy into a plan version. */
export const MAX_STANDING_MEMBERS = 12;

/**
 * Standing teams (ADR 0056). A standing team is a named, reusable set of roles bound to agent definitions and engines. It is a source to
 * copy from, never a live link: a plan version holds its own copy of the members (the mission team), so editing or archiving a standing
 * team changes only references made afterwards.
 */
function view(row: Row): StandingTeam {
  return {
    standingTeamId: row.id, name: row.name, ...(row.description ? { description: row.description } : {}),
    members: JSON.parse(row.members_json) as TeamMember[], ...(row.coordinator_member_id ? { coordinatorMemberId: row.coordinator_member_id } : {}),
    state: row.state, version: row.version, createdBy: row.created_by,
    createdAt: new Date(row.created_at_ms).toISOString(), updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

function row(db: Db, id: string): Row {
  const found = db.prepare("SELECT * FROM standing_teams WHERE id=?").get(id) as Row | undefined;
  if (!found) throw new BrainDomainError("NOT_FOUND", "standing team not found");
  return found;
}

/** Active teams first, then archived ones: they stay readable but are never offered for a new reference. */
export function listStandingTeams(db: Db): StandingTeam[] {
  const rows = db.prepare("SELECT * FROM standing_teams ORDER BY state, name COLLATE NOCASE, id").all() as Row[];
  return rows.map(view);
}

export const standingTeamCounts = (db: Db): { active: number; archived: number } => ({
  active: (db.prepare("SELECT COUNT(*) AS n FROM standing_teams WHERE state='active'").get() as { n: number }).n,
  archived: (db.prepare("SELECT COUNT(*) AS n FROM standing_teams WHERE state='archived'").get() as { n: number }).n,
});

/** The members and coordinator a standing team may hold: published agents on an engine they accept, unique ids, a coordinator who is a member. */
function assertValid(members: readonly TeamMember[], coordinator: string | undefined, agents: Readonly<Record<string, AgentCapabilities>>): void {
  if (members.length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "a standing team needs at least one member");
  if (members.length > MAX_STANDING_MEMBERS) throw new BrainDomainError("INVALID_ARGUMENT", `a standing team has at most ${MAX_STANDING_MEMBERS} members`);
  assertTeamEligible(members, [] as readonly PlanTask[], agents);
  if (coordinator && !members.some((member) => member.memberId === coordinator)) throw new BrainDomainError("INVALID_ARGUMENT", `the coordinator ${coordinator} is not a member of the team`);
}

function assertNameFree(db: Db, name: string, exceptId?: string): void {
  const taken = db.prepare("SELECT id FROM standing_teams WHERE state='active' AND name=? COLLATE NOCASE AND id!=?").get(name, exceptId ?? "") as { id: string } | undefined;
  if (taken) throw new BrainDomainError("CONFLICT", `a standing team named "${name}" already exists; choose another name or archive that one`);
}

const copy = (members: readonly TeamMember[]): TeamMember[] => members.map((member) => ({ memberId: member.memberId, role: member.role, agentId: member.agentId, engine: member.engine }));

export function applyStandingTeam(store: Store, db: Db, workspaceId: string, actor: ActorContext, agents: Readonly<Record<string, AgentCapabilities>>, command: { commandType: string; expectedVersion?: number; payload: Readonly<Record<string, unknown>> }): string {
  if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person manages standing teams");
  const payload = command.payload;
  const now = store.now();
  if (command.commandType === "standingTeam.create") {
    const name = String(payload["name"]).trim();
    const members = copy(payload["members"] as TeamMember[]);
    const coordinator = payload["coordinatorMemberId"] ? String(payload["coordinatorMemberId"]) : undefined;
    assertValid(members, coordinator, agents);
    return store.inTx(db, () => {
      assertNameFree(db, name);
      const id = store.id("standing-team");
      db.prepare("INSERT INTO standing_teams(id,name,description,members_json,coordinator_member_id,state,version,created_by,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'active',1,?,?,?)")
        .run(id, name, String(payload["description"] ?? "").trim(), JSON.stringify(members), coordinator ?? null, actor.actorId, now, now);
      store.emit(db, { workspaceId, aggregateType: "standingTeam", aggregateId: id, eventType: "standingTeam.created", payload: { resourceId: id, workspaceId, state: "active" } });
      return id;
    });
  }
  const id = String(payload["standingTeamId"]);
  return store.inTx(db, () => {
    const current = row(db, id);
    assertExpectedVersion(current.version, command.expectedVersion);
    if (current.state === "archived") throw new BrainDomainError("CONFLICT", "an archived standing team is read-only");
    if (command.commandType === "standingTeam.archive") {
      db.prepare("UPDATE standing_teams SET state='archived',version=version+1,updated_at_ms=? WHERE id=?").run(now, id);
      store.emit(db, { workspaceId, aggregateType: "standingTeam", aggregateId: id, eventType: "standingTeam.archived", payload: { resourceId: id, workspaceId, state: "archived" } });
      return id;
    }
    const name = payload["name"] === undefined ? current.name : String(payload["name"]).trim();
    const members = payload["members"] === undefined ? (JSON.parse(current.members_json) as TeamMember[]) : copy(payload["members"] as TeamMember[]);
    const coordinator = payload["coordinatorMemberId"] === undefined ? (current.coordinator_member_id ?? undefined) : (payload["coordinatorMemberId"] ? String(payload["coordinatorMemberId"]) : undefined);
    assertValid(members, coordinator, agents);
    assertNameFree(db, name, id);
    db.prepare("UPDATE standing_teams SET name=?,description=?,members_json=?,coordinator_member_id=?,version=version+1,updated_at_ms=? WHERE id=?")
      .run(name, payload["description"] === undefined ? current.description : String(payload["description"]).trim(), JSON.stringify(members), coordinator ?? null, now, id);
    store.emit(db, { workspaceId, aggregateType: "standingTeam", aggregateId: id, eventType: "standingTeam.updated", payload: { resourceId: id, workspaceId, state: "active" } });
    return id;
  });
}

/**
 * The members of an active standing team, as copies, and the coordinator it names. A reference is the only moment a standing team's members
 * reach a plan version. An archived team is refused for a new reference (existing plan versions are untouched); the members are checked again
 * against the release in force now, because it may have changed since the team was saved.
 */
export function referenceStandingTeam(db: Db, id: string, agents: Readonly<Record<string, AgentCapabilities>>): { members: TeamMember[]; coordinatorMemberId?: string } {
  const team = view(row(db, id));
  if (team.state === "archived") throw new BrainDomainError("CONFLICT", `the standing team ${team.name} is archived; restore its members in a new team to use them`);
  assertValid(team.members, team.coordinatorMemberId, agents);
  return { members: copy(team.members), ...(team.coordinatorMemberId ? { coordinatorMemberId: team.coordinatorMemberId } : {}) };
}

/**
 * The mission team once a standing team's members are added to the one a plan already names. A member the plan already has with the same
 * agent and engine is kept; a member id that is bound differently is refused (a member never changes its agent or engine, add another).
 */
export function addStandingMembers(base: readonly TeamMember[], standing: readonly TeamMember[]): TeamMember[] {
  const team = [...base];
  for (const member of standing) {
    const same = team.find((entry) => entry.memberId === member.memberId);
    if (!same) team.push(member);
    else if (same.agentId !== member.agentId || same.engine !== member.engine) throw new BrainDomainError("INVALID_ARGUMENT", `${member.memberId} is already on the team bound to ${same.agentId} on ${same.engine}, and the standing team binds it to ${member.agentId} on ${member.engine}`);
  }
  return team;
}
