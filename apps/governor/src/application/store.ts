import { UNATTRIBUTED, currentEventActor, strictActors } from "./actor-context";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@brain/contracts";
import { withTrace } from "../domain/trace";
import { CONTROL_SCOPE, auditChainDigest, auditGenesis, domainDigest, workspaceScope } from "@brain/contracts";
import type { Digest } from "@brain/contracts";
import type { Db } from "../infrastructure/persistence/open";
import { initializeFresh, loadSchemaSql, openDb } from "../infrastructure/persistence/open";
import { acquireDirectory, authorityKeys, durableWrite } from "../infrastructure/persistence/directory";
import { iso, newId, systemClock } from "../domain/clock";
import type { Clock } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";

export interface BrainOptions {
  readonly dataDir: string;
  readonly clock?: Clock;
  readonly serverPepper?: Uint8Array;
  readonly cursorKey?: Uint8Array;
  readonly allowTestActor?: boolean;
}

/** One recorded event as the trace export sees it: ids and the payload, never read back from the database. */
export interface EmittedEvent { eventId: string; organizationId?: string; workspaceId?: string; aggregateType: string; aggregateId: string; eventType: string; payload: JsonValue; atMs: number }

export class Store {
  readonly control: Db;
  readonly clock: Clock;
  readonly dataDir: string;
  readonly pepper: Uint8Array;
  readonly cursorKey: Uint8Array;
  readonly allowTestActor: boolean;
  private readonly workspaces = new Map<string, Db>();
  private readonly workspaceOrganizations = new Map<string, string>();
  private readonly lru: string[] = [];
  // Bounded workspace-handle cache. Handles are fetched per operation and
  // never held across awaits (audited), so eviction cannot strand a caller. The default must exceed the number of workspaces in regular
  // use: with fewer handles than active workspaces every operation reopens one (pragmas, identity and schema check) and closes another,
  // which was the largest share of command time and of event-loop delay in the steady benchmark (25 workspaces against a cap of 16).
  private readonly maxWorkspaces = Math.min(256, Math.max(4, Number(process.env["BRAIN_MAX_WORKSPACE_DBS"] ?? 64) || 64));

  // Workspaces whose event logs gained rows since the stream projector last
  // took them; the projector tails only these on its hot path.
  private readonly workspaceOfDb = new WeakMap<Db, string>();
  private readonly changedWorkspaces = new Set<string>();
  takeChangedWorkspaces(): string[] { const ids = [...this.changedWorkspaces]; this.changedWorkspaces.clear(); return ids; }
  markWorkspaceChanged(workspaceId: string): void { this.changedWorkspaces.add(workspaceId); }

  openWorkspaceCount(): number { return this.workspaces.size; }
  isWorkspaceOpen(workspaceId: string): boolean { return this.workspaces.has(workspaceId); }
  private readonly releaseDirectory: () => void;

  constructor(opts: BrainOptions) {
    this.dataDir = opts.dataDir;
    this.clock = opts.clock ?? systemClock;
    this.allowTestActor = opts.allowTestActor ?? false;
    this.releaseDirectory = acquireDirectory(this.dataDir);
    let control: Db | undefined;
    try {
      const keys = authorityKeys(this.dataDir);
      this.pepper = opts.serverPepper ?? keys.subarray(0, 32);
      this.cursorKey = opts.cursorKey ?? keys.subarray(32);
      mkdirSync(join(this.dataDir, "workspaces"), { recursive: true });
      mkdirSync(join(this.dataDir, "cas"), { recursive: true });
      control = openDb(join(this.dataDir, "control.db"));
      initializeFresh(control, loadSchemaSql("control.sql"));
      if (!control.prepare("SELECT 1 FROM organizations LIMIT 1").get() && !existsSync(join(this.dataDir, "setup.token"))) {
        durableWrite(join(this.dataDir, "setup.token"), randomBytes(32).toString("base64url"));
      }
      this.control = control;
    } catch (e) {
      control?.close();
      this.releaseDirectory();
      throw e;
    }
  }

  now(): number { return this.clock.nowMs(); }
  nowIso(): string { return iso(this.now()); }
  id(prefix: string): string { return newId(prefix); }

  tokenDigest(purpose: string, token: string): string {
    return createHmac("sha256", this.pepper).update(`${purpose}\n${token}`).digest("hex");
  }

  assertWorkspaceActive(workspaceId: string, organizationId: string): void {
    const row = this.control.prepare("SELECT status FROM workspaces WHERE id=? AND organization_id=?").get(workspaceId, organizationId) as { status: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "workspace not found");
    if (row.status !== "active") throw new BrainDomainError("FORBIDDEN", "workspace execution is suspended");
  }

  workspaceDb(workspaceId: string, organizationId: string): Db {
    const hit = this.workspaces.get(workspaceId);
    if (hit) {
      if (this.workspaceOrganizations.get(workspaceId) !== organizationId) throw new BrainDomainError("FORBIDDEN", "workspace database identity mismatch");
      this.lru.splice(this.lru.indexOf(workspaceId), 1);
      this.lru.push(workspaceId);
      return hit;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error("invalid workspace id");
    const db = openDb(join(this.dataDir, "workspaces", `${workspaceId}.db`));
    try { initializeFresh(db, loadSchemaSql("workspace.sql"), { workspaceId, organizationId }); }
    catch (e) { db.close(); throw e; }
    this.workspaces.set(workspaceId, db);
    this.workspaceOfDb.set(db, workspaceId);
    this.workspaceOrganizations.set(workspaceId, organizationId);
    this.lru.push(workspaceId);
    while (this.lru.length > this.maxWorkspaces) {
      const evict = this.lru.shift();
      if (!evict) break;
      const old = this.workspaces.get(evict);
      this.workspaces.delete(evict);
      this.workspaceOrganizations.delete(evict);
      old?.close();
    }
    return db;
  }

  close(): void {
    try {
      for (const db of this.workspaces.values()) if (db.open) db.close();
      this.workspaces.clear();
      this.workspaceOrganizations.clear();
      this.lru.length = 0;
      if (this.control.open) this.control.close();
    } finally { this.releaseDirectory(); }
  }

  /** Told about every event once it is recorded (the optional trace export); it must not throw or wait. */
  eventObserver?: (event: EmittedEvent) => void;

  emit(db: Db, input: {
    organizationId?: string; workspaceId?: string | null;
    aggregateType: string; aggregateId: string; eventType: string;
    payload: JsonValue; destinations?: readonly string[];
  }): string {
    const actor = currentEventActor();
    if (!actor && strictActors()) throw new Error(`event ${input.eventType} written outside an actor scope (ADR 0032: wrap the entry point in actingAs)`);
    const eventId = this.id("evt");
    const changed = this.workspaceOfDb.get(db);
    if (changed) this.changedWorkspaces.add(changed);
    const payload = withTrace(input.aggregateType, input.aggregateId, input.payload);
    const payloadJson = JSON.stringify(payload);
    const payloadDigest = domainDigest("brain:event:v1", payload);
    const at = this.now();
    const actorColumns = [actor?.principalId ?? UNATTRIBUTED, actor?.kind ?? "system", actor?.attemptId ?? null, actor?.actingFor ?? null] as const;
    // The chain position and the insert are one atomic step: the head is read and extended inside the same transaction, so two events
    // never share a position and a rolled-back caller leaves no gap (ADR 0078).
    const record = (): void => {
      const seqRow = db.prepare(
        input.organizationId
          ? "SELECT COALESCE(MAX(aggregate_seq),0) AS m FROM events WHERE organization_id=? AND aggregate_type=? AND aggregate_id=?"
          : "SELECT COALESCE(MAX(aggregate_seq),0) AS m FROM events WHERE aggregate_type=? AND aggregate_id=?",
      ).get(...(input.organizationId ? [input.organizationId, input.aggregateType, input.aggregateId] : [input.aggregateType, input.aggregateId])) as { m: number };
      const seq = seqRow.m + 1;
      let organization = input.organizationId;
      let scope = CONTROL_SCOPE;
      if (!organization) {
        if (!changed) throw new Error("event written to a workspace database the store did not open");
        organization = this.workspaceOrganizations.get(changed);
        scope = workspaceScope(changed);
      }
      const head = (input.organizationId
        ? db.prepare("SELECT chain_seq AS seq, chain_digest AS digest FROM events WHERE organization_id=? AND chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1").get(input.organizationId)
        : db.prepare("SELECT chain_seq AS seq, chain_digest AS digest FROM events WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1").get()) as { seq: number; digest: string } | undefined;
      const prev = (head?.digest ?? auditGenesis(organization!, scope)) as Digest;
      const chainSeq = (head?.seq ?? 0) + 1;
      const chainDigest = auditChainDigest(prev, chainSeq, {
        eventId, organizationId: input.organizationId ?? null, workspaceId: input.organizationId ? (input.workspaceId ?? null) : null, aggregateType: input.aggregateType, aggregateId: input.aggregateId, aggregateSeq: seq,
        eventType: input.eventType, payloadDigest, createdAtMs: at, actorId: actorColumns[0], actorKind: actorColumns[1], actorAttemptId: actorColumns[2], actingFor: actorColumns[3],
      });
      if (input.organizationId) {
        db.prepare(`INSERT INTO events(event_id, organization_id, workspace_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms, actor_id, actor_kind, actor_attempt_id, acting_for, chain_seq, prev_digest, chain_digest)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, input.organizationId, input.workspaceId ?? null, input.aggregateType, input.aggregateId, seq, input.eventType, payloadJson, payloadDigest, at, ...actorColumns, chainSeq, prev, chainDigest);
      } else {
        db.prepare(`INSERT INTO events(event_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms, actor_id, actor_kind, actor_attempt_id, acting_for, chain_seq, prev_digest, chain_digest)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, input.aggregateType, input.aggregateId, seq, input.eventType, payloadJson, payloadDigest, at, ...actorColumns, chainSeq, prev, chainDigest);
      }
    };
    if (db.inTransaction) record(); else db.transaction(record).immediate();
    for (const dest of input.destinations ?? []) {
      db.prepare("INSERT INTO outbox_deliveries(event_id, destination, state, next_attempt_at_ms) VALUES (?,?, 'pending', ?)")
        .run(eventId, dest, this.now());
    }
    if (this.eventObserver) {
      try { this.eventObserver({ eventId, ...(input.organizationId ? { organizationId: input.organizationId } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : changed ? { workspaceId: changed } : {}), aggregateType: input.aggregateType, aggregateId: input.aggregateId, eventType: input.eventType, payload, atMs: this.now() }); } catch { /* observers are best-effort */ }
    }
    return eventId;
  }

  inTx<T>(db: Db, fn: () => T): T {
    return db.transaction(fn).immediate();
  }
}
