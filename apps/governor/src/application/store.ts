import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@brain/contracts";
import { domainDigest } from "@brain/contracts";
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
  // never held across awaits (audited), so eviction cannot strand a caller.
  private readonly maxWorkspaces = Math.min(256, Math.max(4, Number(process.env["BRAIN_MAX_WORKSPACE_DBS"] ?? 16) || 16));

  openWorkspaceCount(): number { return this.workspaces.size; }
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

  emit(db: Db, input: {
    organizationId?: string; workspaceId?: string | null;
    aggregateType: string; aggregateId: string; eventType: string;
    payload: JsonValue; destinations?: readonly string[];
  }): string {
    const eventId = this.id("evt");
    const payloadJson = JSON.stringify(input.payload);
    const payloadDigest = domainDigest("brain:event:v1", input.payload);
    const seqRow = db.prepare(
      input.organizationId
        ? "SELECT COALESCE(MAX(aggregate_seq),0) AS m FROM events WHERE organization_id=? AND aggregate_type=? AND aggregate_id=?"
        : "SELECT COALESCE(MAX(aggregate_seq),0) AS m FROM events WHERE aggregate_type=? AND aggregate_id=?",
    ).get(...(input.organizationId ? [input.organizationId, input.aggregateType, input.aggregateId] : [input.aggregateType, input.aggregateId])) as { m: number };
    const seq = seqRow.m + 1;
    if (input.organizationId) {
      db.prepare(`INSERT INTO events(event_id, organization_id, workspace_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, input.organizationId, input.workspaceId ?? null, input.aggregateType, input.aggregateId, seq, input.eventType, payloadJson, payloadDigest, this.now());
    } else {
      db.prepare(`INSERT INTO events(event_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms)
        VALUES (?,?,?,?,?,?,?,?)`).run(eventId, input.aggregateType, input.aggregateId, seq, input.eventType, payloadJson, payloadDigest, this.now());
    }
    for (const dest of input.destinations ?? []) {
      db.prepare("INSERT INTO outbox_deliveries(event_id, destination, state, next_attempt_at_ms) VALUES (?,?, 'pending', ?)")
        .run(eventId, dest, this.now());
    }
    return eventId;
  }

  inTx<T>(db: Db, fn: () => T): T {
    return db.transaction(fn).immediate();
  }
}
