import type { MissionMessage, Output, OutputInput, OutputVersion, PlanTask } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

type Db = ReturnType<Store["workspaceDb"]>;
type OutputRow = { id: string; mission_id: string; name: string; continues_output_id: string | null; created_at_ms: number };
type VersionRow = { id: string; output_id: string; work_item_id: string; artifact_digest: string; state: "draft" | "final"; verified: number; created_at_ms: number };
type MessageRow = { id: string; mission_id: string; recipient_kind: "mission" | "member"; recipient_member_id: string | null; work_item_id: string | null; sender_id: string; body: string; delivery: MissionMessage["delivery"]; correction_of: string | null; created_at_ms: number };

/** The plan task a work item was materialized from. */
export function taskOf(db: Db, workItemId: string): { missionId: string; task: PlanTask } {
  const row = db.prepare("SELECT w.mission_id, w.plan_task_id, p.tasks_json FROM work_items w JOIN plan_versions p ON p.id=w.plan_version_id WHERE w.id=?").get(workItemId) as { mission_id: string; plan_task_id: string; tasks_json: string } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "work item not found");
  const task = (JSON.parse(row.tasks_json) as PlanTask[]).find((entry) => entry.id === row.plan_task_id);
  if (!task) throw new BrainDomainError("INTERNAL_ERROR", "work item has no plan task");
  return { missionId: row.mission_id, task };
}

/**
 * Records one immutable version of a named output (issue #41). The name must
 * be declared by the producing plan task; a follow-up mission's output may
 * continue an earlier mission's output of the same workspace.
 */
export function recordOutputVersion(store: Store, db: Db, input: { workItemId: string; name: string; artifactDigest: string; state: "draft" | "final"; continues?: { missionId: string; name: string } }): string {
  const { missionId, task } = taskOf(db, input.workItemId);
  if (!(task.outputs ?? []).includes(input.name)) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} declares no output ${input.name}`);
  const id = store.id("outver");
  store.inTx(db, () => {
    let output = db.prepare("SELECT * FROM mission_outputs WHERE mission_id=? AND name=?").get(missionId, input.name) as OutputRow | undefined;
    if (!output) {
      const continues = input.continues ? db.prepare("SELECT id FROM mission_outputs WHERE mission_id=? AND name=?").get(input.continues.missionId, input.continues.name) as { id: string } | undefined : undefined;
      if (input.continues && !continues) throw new BrainDomainError("NOT_FOUND", "the continued output does not exist in this workspace");
      output = { id: store.id("output"), mission_id: missionId, name: input.name, continues_output_id: continues?.id ?? null, created_at_ms: store.now() };
      db.prepare("INSERT INTO mission_outputs(id,mission_id,name,continues_output_id,created_at_ms) VALUES (?,?,?,?,?)").run(output.id, missionId, input.name, output.continues_output_id, output.created_at_ms);
    }
    db.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,created_at_ms) VALUES (?,?,?,?,?,?)").run(id, output.id, input.workItemId, input.artifactDigest, input.state, store.now());
    store.emit(db, { aggregateType: "output", aggregateId: output.id, eventType: "output.versionRecorded", payload: { missionId, workItemId: input.workItemId } });
  });
  return id;
}

/** A work item reached Done on verified evidence: its final output versions are verified. */
export function verifyOutputs(db: Db, workItemId: string): void {
  db.prepare("UPDATE output_versions SET verified=1 WHERE work_item_id=? AND state='final'").run(workItemId);
}

/**
 * Pins a work item's declared inputs to exact verified final versions at
 * admission and records them for the run. A draft, unverified or missing
 * version is refused: unverified material never spreads (E121).
 */
export function pinInputs(db: Db, workItemId: string, runId: string): void {
  const row = db.prepare("SELECT w.mission_id, w.plan_task_id, p.tasks_json FROM work_items w JOIN plan_versions p ON p.id=w.plan_version_id WHERE w.id=?").get(workItemId) as { mission_id: string; plan_task_id: string; tasks_json: string } | undefined;
  const task = row ? (JSON.parse(row.tasks_json) as PlanTask[]).find((entry) => entry.id === row.plan_task_id) : undefined;
  if (!row || !task) return; // a work item without a declared plan task declares no inputs
  const missionId = row.mission_id;
  for (const input of task.inputs ?? [] as readonly OutputInput[]) {
    const source = input.missionId ?? missionId;
    const output = db.prepare("SELECT id FROM mission_outputs WHERE mission_id=? AND name=?").get(source, input.output) as { id: string } | undefined;
    if (!output) throw new BrainDomainError("CONFLICT", `input ${input.output} has no recorded output`);
    const version = input.versionId
      ? db.prepare("SELECT * FROM output_versions WHERE id=? AND output_id=?").get(input.versionId, output.id) as VersionRow | undefined
      : db.prepare("SELECT * FROM output_versions WHERE output_id=? AND verified=1 ORDER BY created_at_ms DESC, id DESC LIMIT 1").get(output.id) as VersionRow | undefined;
    if (!version) throw new BrainDomainError("CONFLICT", `input ${input.output} has no verified final version`);
    if (version.verified !== 1) throw new BrainDomainError("CONFLICT", `input ${input.output} is pinned to a ${version.state === "draft" ? "draft" : "unverified"} version`);
    db.prepare("INSERT OR IGNORE INTO work_item_inputs(work_item_id,run_id,output_version_id,artifact_digest) VALUES (?,?,?,?)").run(workItemId, runId, version.id, version.artifact_digest);
  }
}

export function listOutputs(db: Db, missionId: string): Output[] {
  const outputs = db.prepare("SELECT * FROM mission_outputs WHERE mission_id=? ORDER BY name").all(missionId) as OutputRow[];
  return outputs.map((row) => ({
    outputId: row.id, missionId: row.mission_id, name: row.name, ...(row.continues_output_id ? { continues: row.continues_output_id } : {}),
    versions: (db.prepare("SELECT * FROM output_versions WHERE output_id=? ORDER BY created_at_ms, id").all(row.id) as VersionRow[]).map((version): OutputVersion => ({
      versionId: version.id, outputId: version.output_id, workItemId: version.work_item_id, artifactDigest: version.artifact_digest,
      state: version.state, verified: version.verified === 1, createdAt: iso(version.created_at_ms),
    })),
    createdAt: iso(row.created_at_ms),
  }));
}

/** A durable message to the mission (its coordinator) or one member; delivery is the sessions module's (T53). */
export function sendMessage(store: Store, db: Db, input: { missionId: string; senderId: string; recipient: MissionMessage["recipient"]; body: string; workItemId?: string; correctionOf?: string; team: readonly string[] }): string {
  if (input.recipient.kind === "member" && (!input.recipient.memberId || !input.team.includes(input.recipient.memberId))) throw new BrainDomainError("INVALID_ARGUMENT", "the recipient is not on the mission team");
  if (input.recipient.kind === "mission" && input.recipient.memberId) throw new BrainDomainError("INVALID_ARGUMENT", "a message to the mission names no member");
  if (input.workItemId && !db.prepare("SELECT 1 FROM work_items WHERE id=? AND mission_id=?").get(input.workItemId, input.missionId)) throw new BrainDomainError("NOT_FOUND", "work item not found in this mission");
  const id = store.id("msg");
  store.inTx(db, () => {
    if (input.correctionOf) {
      const prior = db.prepare("UPDATE mission_messages SET delivery='superseded' WHERE id=? AND mission_id=? AND sender_id=? AND delivery='pending'").run(input.correctionOf, input.missionId, input.senderId);
      if (prior.changes !== 1) throw new BrainDomainError("CONFLICT", "only your own undelivered message can be corrected");
    }
    db.prepare("INSERT INTO mission_messages(id,mission_id,recipient_kind,recipient_member_id,work_item_id,sender_id,body,correction_of,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, input.missionId, input.recipient.kind, input.recipient.memberId ?? null, input.workItemId ?? null, input.senderId, input.body, input.correctionOf ?? null, store.now());
    store.emit(db, { aggregateType: "mission", aggregateId: input.missionId, eventType: "mission.messageSent", payload: { missionId: input.missionId } });
  });
  return id;
}

export function listMessages(db: Db, missionId: string, limit: number): MissionMessage[] {
  return (db.prepare("SELECT * FROM mission_messages WHERE mission_id=? ORDER BY created_at_ms DESC, id DESC LIMIT ?").all(missionId, limit) as MessageRow[]).map((row) => ({
    messageId: row.id, missionId: row.mission_id,
    recipient: { kind: row.recipient_kind, ...(row.recipient_member_id ? { memberId: row.recipient_member_id } : {}) },
    ...(row.work_item_id ? { workItemId: row.work_item_id } : {}), senderId: row.sender_id, body: row.body, delivery: row.delivery,
    ...(row.correction_of ? { correctionOf: row.correction_of } : {}), createdAt: iso(row.created_at_ms),
  }));
}
