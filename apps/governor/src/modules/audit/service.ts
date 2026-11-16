import {
  AuditChainVerifier, AuditKeyTrust, auditEventProblem, CONTROL_SCOPE, KEY_RECORDED_EVENT, checkpointSigningBytes, verifyAuditExport, workspaceScope,
  type ActorContext, type AuditCheckpoint, type AuditEventRecord, type AuditExportInput, type AuditExportPage, type AuditKey, type AuditOverview, type AuditScopeStatus, type AuditVerifyOptions, type AuditVerifyResult, type Digest,
} from "@brain/contracts";
import type { Store } from "../../application/store";
import { actingAs, eventActorOf, systemActor, type EventActor } from "../../application/actor-context";
import { BrainDomainError } from "../../domain/errors";
import type { Db } from "../../infrastructure/persistence/open";
import { ageWords } from "../operations/backup-status";
import { recordProbe, type ProbeStatus } from "../operations/probes";
import { AuditKeys } from "./keys";
import { chainHead, readEvents } from "./records";

/**
 * Tamper-evident audit, Governor side (ADR 0078): signs checkpoints of the event hash chains on a schedule and on demand, keeps the
 * audit key, serves the export that `brain audit verify` checks, and re-verifies the live chains itself (a slow background scan under
 * the `system:audit` principal) so a broken chain is alarmed on Health instead of waiting for someone to run the CLI.
 */
export interface AuditConfig {
  /** A checkpoint is due when this many events came after the last one... */
  readonly checkpointEvents: number;
  /** ...or this long passed since it and there is something new. */
  readonly checkpointMs: number;
  /** The whole log is walked again this often; between walks only new events are checked. */
  readonly rescanMs: number;
  /** Events read per slice of a scan. */
  readonly page: number;
}
export function auditConfig(env: NodeJS.ProcessEnv = process.env): AuditConfig {
  const positive = (raw: string | undefined, fallback: number): number => { const n = Number(raw); return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback; };
  return {
    checkpointEvents: Math.floor(positive(env["BRAIN_AUDIT_CHECKPOINT_EVENTS"], 1000)),
    checkpointMs: positive(env["BRAIN_AUDIT_CHECKPOINT_MINUTES"], 15) * 60_000,
    rescanMs: positive(env["BRAIN_AUDIT_RESCAN_MINUTES"], 60) * 60_000,
    page: Math.floor(positive(env["BRAIN_AUDIT_SCAN_PAGE"], 20000)),
  };
}

interface Scan { verifier: AuditChainVerifier; cursor: number; complete: boolean; startedAtMs: number; verifiedAtMs: number | null; verifiedEvents: number }
interface Target { organizationId: string; scope: string; workspaceId: string | null }
interface CheckpointRow { id: string; organization_id: string; scope: string; through_seq: number; through_cursor: number; chain_digest: string; signature: string; key_id: string; created_at_ms: number; reason: string }

const toCheckpoint = (r: CheckpointRow): AuditCheckpoint => ({
  checkpointId: r.id, organizationId: r.organization_id, scope: r.scope, throughSeq: r.through_seq, chainDigest: r.chain_digest as Digest, createdAtMs: r.created_at_ms,
  reason: r.reason as AuditCheckpoint["reason"], keyId: r.key_id, signature: r.signature,
});

export class AuditService {
  readonly keys: AuditKeys;
  private readonly scans = new Map<string, Scan>();
  constructor(private readonly store: Store, private readonly config: AuditConfig = auditConfig()) {
    this.keys = new AuditKeys(store);
  }

  // --- who may ask ---
  private requireHuman(actor: ActorContext): void {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "The audit log is read by a signed-in person");
  }
  private requireAdmin(actor: ActorContext): void {
    if (actor.kind !== "human" || !actor.scopes.includes("config:activate") || !actor.scopes.includes("runner:admin")) throw new BrainDomainError("FORBIDDEN", "The audit log needs organization administration");
  }

  // --- scopes ---
  private organizations(): string[] { return (this.store.control.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id); }
  private targets(organizationId: string): Target[] {
    const workspaces = this.store.control.prepare("SELECT id FROM workspaces WHERE organization_id=? ORDER BY id").all(organizationId) as Array<{ id: string }>;
    return [{ organizationId, scope: CONTROL_SCOPE, workspaceId: null }, ...workspaces.map((w) => ({ organizationId, scope: workspaceScope(w.id), workspaceId: w.id }))];
  }
  private dbOf(t: Target): Db { return t.workspaceId ? this.store.workspaceDb(t.workspaceId, t.organizationId) : this.store.control; }
  private headOf(t: Target) { return chainHead(this.dbOf(t), t.workspaceId ? null : t.organizationId); }
  private checkpointsOf(t: Target): AuditCheckpoint[] {
    return (this.store.control.prepare("SELECT * FROM audit_checkpoints WHERE organization_id=? AND scope=? ORDER BY through_seq, created_at_ms").all(t.organizationId, t.scope) as CheckpointRow[]).map(toCheckpoint);
  }
  private lastCheckpoint(t: Target): AuditCheckpoint | undefined {
    const row = this.store.control.prepare("SELECT * FROM audit_checkpoints WHERE organization_id=? AND scope=? ORDER BY through_seq DESC, created_at_ms DESC LIMIT 1").get(t.organizationId, t.scope) as CheckpointRow | undefined;
    return row ? toCheckpoint(row) : undefined;
  }
  private trust(organizationId: string): AuditKeyTrust {
    const control = this.scans.get(`${organizationId}/${CONTROL_SCOPE}`)?.verifier;
    return new AuditKeyTrust(this.keys.list(), control?.keyRecords ?? []);
  }

  // --- scanning ---
  private scanOf(t: Target): Scan {
    const key = `${t.organizationId}/${t.scope}`;
    let scan = this.scans.get(key);
    // A break stays reported (and its scan stays) until the Governor restarts: a finding is not cleared by looking away.
    if (scan && scan.complete && !scan.verifier.broken && this.store.now() - scan.startedAtMs >= this.config.rescanMs) scan = undefined;
    if (!scan) {
      scan = { verifier: new AuditChainVerifier(t.organizationId, t.scope, this.checkpointsOf(t)), cursor: 0, complete: false, startedAtMs: this.store.now(), verifiedAtMs: this.scans.get(key)?.verifiedAtMs ?? null, verifiedEvents: this.scans.get(key)?.verifiedEvents ?? 0 };
      this.scans.set(key, scan);
    }
    return scan;
  }

  /** Reads up to `budget` more events into the scan; once it has caught up, judges the head and (the first time) the checkpoints. */
  private advance(t: Target, scan: Scan, budget: number): void {
    const v = scan.verifier;
    const db = this.dbOf(t);
    const org = t.workspaceId ? null : t.organizationId;
    let remaining = budget; let caughtUp = false;
    while (!v.broken && remaining > 0) {
      const want = Math.min(this.config.page, remaining);
      const rows: AuditEventRecord[] = readEvents(db, org, scan.cursor, want);
      for (const e of rows) { if (v.push(e)) break; scan.cursor = e.cursor; }
      remaining -= rows.length;
      if (rows.length < want) { caughtUp = true; break; }
    }
    if (!caughtUp || v.broken) return;
    const head = chainHead(db, org);
    if ((head?.seq ?? 0) < v.lastSeq) { v.markBroken("tail-truncated", `The log now ends at position ${head?.seq ?? 0} but ${v.lastSeq} had been verified: events were removed from its end`, v.lastSeq); return; }
    if (head && head.seq === v.lastSeq && head.digest !== v.lastDigest) { v.markBroken("event-edited", `The newest event (position ${head.seq}) no longer matches the digest verified earlier`, head.seq); return; }
    // The newest events were consumed a moment ago and are the likeliest to be touched: look at them again, not only at their digest column.
    if (head) for (const e of readEvents(db, org, Math.max(0, head.cursor - 50), 50).slice(-8)) {
      const problem = auditEventProblem(e);
      if (problem) { v.markBroken(problem.kind, problem.detail, e.chainSeq); return; }
    }
    if (!scan.complete) {
      if (v.checkCheckpoints(this.trust(t.organizationId)).problem) return;
      scan.complete = true;
    }
    scan.verifiedAtMs = this.store.now(); scan.verifiedEvents = v.verified;
  }

  // --- checkpoints ---
  private writeCheckpoint(t: Target, reason: AuditCheckpoint["reason"]): AuditCheckpoint | undefined {
    const head = this.headOf(t);
    if (!head) return undefined;
    const last = this.lastCheckpoint(t);
    if (last && last.throughSeq === head.seq) return last;
    const body = { checkpointId: this.store.id("ackpt"), organizationId: t.organizationId, scope: t.scope, throughSeq: head.seq, chainDigest: head.digest as Digest, createdAtMs: this.store.now(), reason };
    const signed = this.keys.sign(checkpointSigningBytes({ ...body, keyId: this.keys.active().keyId }));
    this.store.control.prepare("INSERT INTO audit_checkpoints(id,organization_id,through_cursor,chain_digest,signature,key_id,created_at_ms,scope,through_seq,reason) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(body.checkpointId, t.organizationId, head.cursor, head.digest, signed.signature, signed.keyId, body.createdAtMs, t.scope, head.seq, reason);
    return { ...body, keyId: signed.keyId, signature: signed.signature };
  }

  private due(t: Target, headSeq: number): boolean {
    const last = this.lastCheckpoint(t);
    if (headSeq <= (last?.throughSeq ?? 0)) return false;
    return headSeq - (last?.throughSeq ?? 0) >= this.config.checkpointEvents || this.store.now() - (last?.createdAtMs ?? 0) >= this.config.checkpointMs;
  }

  /** Records, in each organization's chain, every audit key it has not yet seen (the first key at first use, a rotated-in key with its hand-over). */
  private recordKeys(organizationIds: readonly string[], by: EventActor = systemActor("audit")): void {
    actingAs(by, () => { for (const organizationId of organizationIds) {
      for (const key of this.keys.records()) {
        const known = this.store.control.prepare("SELECT 1 FROM events WHERE organization_id=? AND event_type=? AND json_extract(payload_json,'$.keyId')=? LIMIT 1").get(organizationId, KEY_RECORDED_EVENT, key.keyId);
        if (known) continue;
        this.store.emit(this.store.control, { organizationId, aggregateType: "audit", aggregateId: "keys", eventType: KEY_RECORDED_EVENT, payload: { keyId: key.keyId, publicKey: key.publicKey, previousKeyId: key.previousKeyId, rotationSignature: key.rotationSignature } });
      }
    } });
  }

  /** The Governor's own pass (a timer, and Health's refresh): record keys, walk the next slice of every log, write the checkpoints that are due, update the Health line. */
  pass(): void {
    const orgs = this.organizations();
    this.recordKeys(orgs);
    const signingProblem = this.keys.problem();
    for (const organizationId of orgs) {
      for (const t of this.targets(organizationId)) {
        const scan = this.scanOf(t);
        this.advance(t, scan, this.config.page);
        const head = this.headOf(t);
        if (!signingProblem && head && scan.complete && !scan.verifier.broken && scan.verifier.lastSeq === head.seq && this.due(t, head.seq)) this.writeCheckpoint(t, "schedule");
      }
    }
    this.recordHealth(signingProblem);
  }

  private recordHealth(signingProblem: string | undefined): void {
    let status: ProbeStatus = "healthy"; let detail: string;
    const scans = [...this.scans.values()];
    const broken = scans.map((s) => s.verifier.broken).find((b) => b !== undefined);
    const verified = scans.reduce((n, s) => n + s.verifier.verified, 0);
    let latest: AuditCheckpoint | undefined; let behind = 0;
    for (const organizationId of this.organizations()) {
      for (const t of this.targets(organizationId)) {
        const cp = this.lastCheckpoint(t);
        if (cp && (!latest || cp.createdAtMs > latest.createdAtMs)) latest = cp;
        const head = this.headOf(t);
        if (head && head.seq > (cp?.throughSeq ?? 0)) behind += 1;
      }
    }
    const now = this.store.now();
    const checkpointAge = latest ? Math.max(0, Math.round((now - latest.createdAtMs) / 1000)) : 0;
    const checkpointWords = !latest ? "No checkpoint has been written yet." : checkpointAge < 60 ? "Last checkpoint just now." : `Last checkpoint ${ageWords(checkpointAge)} ago.`;
    const logs = scans.length;
    if (broken) { status = "unavailable"; detail = `The audit log failed verification (${broken.chain}${broken.chainSeq !== null ? `, event ${broken.chainSeq}` : ""}): ${broken.detail}. Events may have been changed, removed or added outside Brain. Run brain audit verify for the full report.`; }
    else if (signingProblem) { status = "unavailable"; detail = `${signingProblem} Checkpoints cannot be signed until the key is replaced.`; }
    else if (logs === 0) detail = "No audit log exists yet; there is nothing to verify.";
    else if (scans.some((s) => !s.complete)) detail = `Verifying the audit log: ${verified} events checked so far. ${checkpointWords}`;
    else {
      const overdue = behind > 0 && latest !== undefined && now - latest.createdAtMs > 3 * this.config.checkpointMs;
      if (overdue) status = "degraded";
      detail = `Audit log verified: ${verified} events in ${logs} ${logs === 1 ? "log" : "logs"}. ${checkpointWords}${overdue ? " Checkpoints are overdue." : ""}`;
    }
    recordProbe(this.store, "audit", status, detail);
  }

  // --- on demand ---
  /** Signs a checkpoint of every log of the organization now (or of one workspace's log), after verifying each up to its head. A log that fails verification is never signed. */
  checkpointNow(actor: ActorContext, workspaceId?: string): AuditCheckpoint[] {
    this.requireAdmin(actor);
    return this.checkpointAll(actor.organizationId, "demand", workspaceId);
  }
  private checkpointAll(organizationId: string, reason: AuditCheckpoint["reason"], workspaceId?: string): AuditCheckpoint[] {
    const problem = this.keys.problem();
    if (problem) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", problem);
    const targets = this.targets(organizationId).filter((t) => !workspaceId || t.workspaceId === workspaceId);
    if (workspaceId && targets.length === 0) throw new BrainDomainError("NOT_FOUND", "workspace not found");
    // A checkpoint is verified against the keys the log recorded, so the key that signs it is in the log first.
    this.recordKeys([organizationId]);
    const out: AuditCheckpoint[] = [];
    for (const t of targets) {
      const scan = this.scanOf(t);
      this.advance(t, scan, Number.MAX_SAFE_INTEGER);
      if (scan.verifier.broken) throw new BrainDomainError("CONFLICT", `The audit log failed verification (${scan.verifier.broken.detail}); no checkpoint was signed over it`);
      const written = this.writeCheckpoint(t, reason);
      if (written) out.push(written);
    }
    return out;
  }

  /** Retires the signing key and makes a new one. The old key signs a last checkpoint of every log and the hand-over to the new key, which is recorded in the chain. */
  rotateKey(actor: ActorContext): { activeKeyId: string; retiredKeyId: string; keys: AuditKey[] } {
    this.requireAdmin(actor);
    if (!this.keys.problem()) this.checkpointAll(actor.organizationId, "rotation");
    const { retiredKeyId, active } = this.keys.rotate();
    this.recordKeys([actor.organizationId], eventActorOf(actor));
    return { activeKeyId: active.keyId, retiredKeyId, keys: this.keys.list() };
  }

  // --- reads ---
  overview(actor: ActorContext): AuditOverview {
    this.requireHuman(actor);
    return { format: "brain.audit-overview/v1", organizationId: actor.organizationId, activeKeyId: this.keys.active().keyId, keys: this.keys.list(), scopes: this.scopeStatuses(actor.organizationId) };
  }
  scopeStatuses(organizationId: string): AuditScopeStatus[] {
    return this.targets(organizationId).map((t) => ({ scope: t.scope, workspaceId: t.workspaceId, headSeq: this.headOf(t)?.seq ?? 0, lastCheckpoint: this.lastCheckpoint(t) ?? null }));
  }

  /** One page of a log in written order, with the log's checkpoints and the keys: everything an offline verifier needs. */
  exportPage(actor: ActorContext, input: { scope: string; afterCursor: number; limit: number }): AuditExportPage {
    this.requireAdmin(actor);
    const t = this.targets(actor.organizationId).find((x) => x.scope === input.scope);
    if (!t) throw new BrainDomainError("NOT_FOUND", "audit log not found");
    const limit = Math.max(1, Math.min(5000, Math.floor(input.limit)));
    const events = readEvents(this.dbOf(t), t.workspaceId ? null : t.organizationId, Math.max(0, input.afterCursor), limit);
    return {
      format: "brain.audit-export/v1", organizationId: t.organizationId, scope: t.scope, afterCursor: input.afterCursor, events,
      nextAfterCursor: events.length === limit ? events[events.length - 1]!.cursor : null, headSeq: this.headOf(t)?.seq ?? 0, checkpoints: this.checkpointsOf(t), keys: this.keys.list(),
    };
  }

  /** Verifies every log of the organization from the database, from the beginning, with the same verifier the CLI uses. */
  verifyNow(organizationId: string, options: AuditVerifyOptions = {}): AuditVerifyResult {
    return verifyAuditExport(this.exportInput(organizationId), options);
  }
  exportInput(organizationId: string): AuditExportInput {
    const pages = function* (read: (after: number) => AuditEventRecord[]): Generator<AuditEventRecord> {
      let after = 0;
      for (;;) {
        const page = read(after);
        yield* page;
        if (page.length < 5000) return;
        after = page[page.length - 1]!.cursor;
      }
    };
    const chain = (t: Target) => ({
      scope: t.scope, checkpoints: this.checkpointsOf(t),
      events: { [Symbol.iterator]: () => pages((after) => readEvents(this.dbOf(t), t.workspaceId ? null : t.organizationId, after, 5000)) },
    });
    return { organizationId, keys: this.keys.list(), chains: this.targets(organizationId).map(chain) };
  }

  /** The audit part of the diagnostics bundle: the public keys and where each log stands. No event content. */
  diagnostics(organizationId: string): { activeKeyId: string; keys: AuditKey[]; scopes: AuditScopeStatus[] } {
    return { activeKeyId: this.keys.active().keyId, keys: this.keys.list(), scopes: this.scopeStatuses(organizationId) };
  }
}
