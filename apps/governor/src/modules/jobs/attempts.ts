import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@brain/contracts";
import { domainDigest, sha256Digest } from "@brain/contracts";
import { releaseToolPins } from "../configuration/index";
import { BrainDomainError } from "../../domain/errors";
import { evaluateRunner, type RunnerView } from "../../domain/placement";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";

/**
 * Job/attempt lifecycle: fair claim, offers as pinned execution artifacts,
 * leases and fences, event ingest, completion receipts and expiry sweeps.
 * Private files; the public surface is the module index.
 */
export function casPathOf(dataDir: string, digest: string): string {
  const hex = digest.replace("sha256:", "");
  return join(dataDir, "cas", hex.slice(0, 2), hex);
}

export function runnerView(s: Store, runnerId: string): RunnerView | undefined {
  const r = s.control.prepare(`SELECT id, group_id, admin_state, health, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity,
    cpu_reserved, memory_reserved, disk_reserved, slots_reserved FROM runners WHERE id=?`).get(runnerId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const caps = new Map<string, { verified: boolean; expiresAtMs: number }>();
  for (const c of s.control.prepare("SELECT capability, verified, expires_at_ms FROM runner_capabilities WHERE runner_id=?").all(runnerId) as Array<Record<string, unknown>>) {
    caps.set(String(c["capability"]), { verified: Number(c["verified"]) === 1, expiresAtMs: Number(c["expires_at_ms"]) });
  }
  const engines = (s.control.prepare("SELECT capability FROM runner_capabilities WHERE runner_id=? AND capability LIKE 'engine:%'").all(runnerId) as Array<{ capability: string }>)
    .map((e) => e.capability.slice("engine:".length));
  return {
    id: runnerId, groupId: String(r["group_id"]), adminState: String(r["admin_state"]), health: String(r["health"]),
    online: Number(r["last_heartbeat_ms"] ?? 0) > s.now() - 45_000,
    capabilities: caps,
    capacity: { cpuMillicores: Number(r["cpu_capacity"]), memoryMb: Number(r["memory_capacity"]), diskMb: Number(r["disk_capacity"]), slots: Number(r["slot_capacity"]) },
    reserved: { cpuMillicores: Number(r["cpu_reserved"]), memoryMb: Number(r["memory_reserved"]), diskMb: Number(r["disk_reserved"]), slots: Number(r["slots_reserved"]) },
    reserve: { cpuMillicores: 500, memoryMb: 1024, diskMb: 0, slots: 0 },
    isolation: caps.has("isolation:ephemeral-container") ? "ephemeral-container" : "ephemeral-container",
    engines,
  };
}

export function claim(s: Store, deps: { isEvaluatorEligible: (runnerId: string, jobId: string) => boolean }, runner: { runnerId: string; epoch: number; organizationId: string }, requestId: string): JsonValue | null {
  let offer: JsonValue | null = null;
  s.inTx(s.control, () => {
    const priorClaim = s.control.prepare("SELECT attempt_id FROM runner_claim_requests WHERE runner_id=? AND runner_epoch=? AND request_id=?").get(runner.runnerId, runner.epoch, requestId) as { attempt_id: string | null } | undefined;
    if (priorClaim?.attempt_id) {
      offer = offerJson(s, priorClaim.attempt_id);
      return;
    }
    const view = runnerView(s, runner.runnerId);
    if (!view) throw new BrainDomainError("UNAUTHENTICATED", "runner missing");
    // Fair paging (E047/E048/E049): scan beyond the first 100-row page with a
    // keyset cursor so an eligible job is eventually found, cap effective
    // priority, and prefer the workspace with the fewest in-flight attempts
    // so one workspace cannot starve the others by inflating priority.
    const eligible: Array<Record<string, unknown>> = [];
    let afterPriority: number | null = null;
    let afterCreated: number | null = null;
    let afterId: string | null = null;
    for (let page = 0; page < 10; page++) {
      const rows = (afterPriority === null
        ? s.control.prepare(`SELECT id, workspace_id, placement_json, version, workflow_run_id, step_id, config_digest, effect_class, priority, created_at_ms
            FROM jobs WHERE organization_id=? AND state='queued' AND deadline_ms>? AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=jobs.workspace_id AND w.organization_id=jobs.organization_id AND w.status='active') ORDER BY priority DESC, created_at_ms ASC, id ASC LIMIT 100`)
            .all(runner.organizationId, s.now())
        : s.control.prepare(`SELECT id, workspace_id, placement_json, version, workflow_run_id, step_id, config_digest, effect_class, priority, created_at_ms
            FROM jobs WHERE organization_id=? AND state='queued' AND deadline_ms>? AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=jobs.workspace_id AND w.organization_id=jobs.organization_id AND w.status='active')
            AND (priority < ? OR (priority = ? AND created_at_ms > ?) OR (priority = ? AND created_at_ms = ? AND id > ?))
            ORDER BY priority DESC, created_at_ms ASC, id ASC LIMIT 100`)
            .all(runner.organizationId, s.now(), afterPriority, afterPriority, afterCreated, afterPriority, afterCreated, afterId)) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const job of rows) {
        const placement = JSON.parse(String(job["placement_json"])) as import("@brain/contracts").Placement;
        const demand = placement.resources ?? { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 };
        if (evaluateRunner(placement, demand, view, s.now()).eligible && deps.isEvaluatorEligible(runner.runnerId, String(job["id"]))) eligible.push(job);
      }
      const last = rows[rows.length - 1]!;
      afterPriority = Number(last["priority"] ?? 0);
      afterCreated = Number(last["created_at_ms"] ?? 0);
      afterId = String(last["id"]);
      if (eligible.length > 0 && page > 0) break;
      if (rows.length < 100) break;
    }
    const inFlight = new Map<string, number>();
    for (const row of s.control.prepare(`SELECT j.workspace_id AS ws, COUNT(*) AS n FROM job_attempts a JOIN jobs j ON j.id=a.job_id
      WHERE a.state IN ('offered','running') GROUP BY j.workspace_id`).all() as Array<{ ws: string; n: number }>) {
      inFlight.set(row.ws, row.n);
    }
    eligible.sort((a, b) => {
      const fa = inFlight.get(String(a["workspace_id"])) ?? 0;
      const fb = inFlight.get(String(b["workspace_id"])) ?? 0;
      if (fa !== fb) return fa - fb;
      const pa = Math.min(Number(a["priority"] ?? 0), 100);
      const pb = Math.min(Number(b["priority"] ?? 0), 100);
      if (pb !== pa) return pb - pa;
      const ca = Number(a["created_at_ms"] ?? 0) - Number(b["created_at_ms"] ?? 0);
      return ca !== 0 ? ca : String(a["id"]).localeCompare(String(b["id"]));
    });
    for (const job of eligible) {
      const placement = JSON.parse(String(job["placement_json"])) as import("@brain/contracts").Placement;
      const demand = placement.resources ?? { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 };
      const attemptId = s.id("att");
      const leaseId = s.id("lease");
      const upd = s.control.prepare(`UPDATE runners SET cpu_reserved=cpu_reserved+?, memory_reserved=memory_reserved+?, disk_reserved=disk_reserved+?, slots_reserved=slots_reserved+?
        WHERE id=? AND cpu_capacity-500-cpu_reserved>=? AND memory_capacity-1024-memory_reserved>=? AND disk_capacity-disk_reserved>=? AND slot_capacity-slots_reserved>=?`)
        .run(demand.cpuMillicores, demand.memoryMb, demand.diskMb, demand.slots, runner.runnerId, demand.cpuMillicores, demand.memoryMb, demand.diskMb, demand.slots);
      if (upd.changes !== 1) continue;
      const jobUpd = s.control.prepare("UPDATE jobs SET state='offered', attempt_counter=attempt_counter+1, job_fence=job_fence+1, version=version+1 WHERE id=? AND state='queued' AND version=?")
        .run(String(job["id"]), Number(job["version"]));
      if (jobUpd.changes !== 1) throw new BrainDomainError("CONFLICT", "job claim race lost; transaction rolled back");
      const fresh = s.control.prepare("SELECT attempt_counter, job_fence FROM jobs WHERE id=?").get(String(job["id"])) as { attempt_counter: number; job_fence: number };
      s.control.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms)
        VALUES (?,?,?,?,?,?,?,'offered',?,?)`).run(attemptId, String(job["id"]), runner.runnerId, runner.epoch, fresh.attempt_counter, leaseId, fresh.job_fence, s.now() + 10_000, s.now() + 10_000);
      s.control.prepare("INSERT INTO capacity_reservations(attempt_id, runner_id, cpu, memory, disk, slots) VALUES (?,?,?,?,?,?)")
        .run(attemptId, runner.runnerId, Math.max(1, demand.cpuMillicores), Math.max(1, demand.memoryMb), Math.max(1, demand.diskMb), Math.max(1, demand.slots));
      s.control.prepare("INSERT INTO runner_claim_requests(runner_id, runner_epoch, request_id, attempt_id, request_digest, created_at_ms) VALUES (?,?,?,?,?,?)")
        .run(runner.runnerId, runner.epoch, requestId, attemptId, requestId, s.now());
      offer = offerJson(s, attemptId);
      return;
    }
    s.control.prepare("INSERT OR IGNORE INTO runner_claim_requests(runner_id, runner_epoch, request_id, attempt_id, request_digest, created_at_ms) VALUES (?,?,?,NULL,?,?)")
      .run(runner.runnerId, runner.epoch, requestId, requestId, s.now());
  });
  return offer;
}

// Materializes a job's execution payload as a scoped CAS artifact so the
// JobOffer references durable bytes instead of inlining the payload (T02).
export function ensureExecutionArtifact(s: Store, jobId: string, organizationId: string, workspaceId: string, payloadText: string): { artifactId: string; digest: string; bytes: number } {
  const artifactId = `exec-${jobId}`;
  const bytes = new TextEncoder().encode(payloadText);
  const digest = sha256Digest(bytes);
  const existing = s.control.prepare("SELECT digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(artifactId, organizationId) as { digest: string } | undefined;
  if (existing) {
    if (existing.digest !== digest) throw new BrainDomainError("CONFLICT", "job execution artifact already pinned to different bytes");
    return { artifactId, digest, bytes: bytes.length };
  }
  const path = casPathOf(s.dataDir, digest);
  mkdirSync(join(path, ".."), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, bytes);
  s.control.prepare(`INSERT OR IGNORE INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms)
    VALUES (?,?,?,?,'job',?,'internal',?)`).run(artifactId, organizationId, workspaceId, digest, jobId, s.now());
  const ws = s.workspaceDb(workspaceId, organizationId);
  ws.prepare("INSERT OR IGNORE INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES (?,?,?, 'application/json','internal','verified',?)")
    .run(artifactId, digest, bytes.length, s.now());
  return { artifactId, digest, bytes: bytes.length };
}

export function readExecutionArtifact(s: Store, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string): Uint8Array {
  const row = loadAttempt(s, attemptId);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  assertAttemptLive(s, runner, row);
  const artifactId = `exec-${String(row["job_id"])}`;
  const assoc = s.control.prepare("SELECT digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(artifactId, runner.organizationId) as { digest: string } | undefined;
  if (!assoc) throw new BrainDomainError("EVIDENCE_MISSING", "execution artifact not materialized");
  const path = casPathOf(s.dataDir, assoc.digest);
  if (!existsSync(path)) throw new BrainDomainError("EVIDENCE_MISSING", "execution artifact bytes missing");
  const bytes = readFileSync(path);
  if (sha256Digest(bytes) !== assoc.digest) throw new BrainDomainError("EVIDENCE_MISSING", "execution artifact bytes corrupted");
  return bytes;
}

export function offerJson(s: Store, attemptId: string): JsonValue {
  const row = s.control.prepare(`SELECT a.id AS attempt_id, a.job_id, a.runner_id, a.runner_epoch, a.lease_id, a.job_fence, a.attempt_no, a.offer_expires_at_ms,
    j.organization_id, j.workspace_id, j.config_digest, j.placement_json, j.workflow_run_id, j.step_id
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?`).get(attemptId) as Record<string, unknown> | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  const payloadRow = s.control.prepare("SELECT kind, payload_json FROM job_payloads WHERE job_id=?").get(String(row["job_id"])) as { kind: string; payload_json: string } | undefined;
  const artifactText = payloadRow?.payload_json ?? "{}";
  const artifact = ensureExecutionArtifact(s, String(row["job_id"]), String(row["organization_id"]), String(row["workspace_id"]), artifactText);
  let workflowDigest = String(row["config_digest"]);
  try {
    const ws = s.workspaceDb(String(row["workspace_id"]), String(row["organization_id"]));
    const runRow = ws.prepare("SELECT workflow_digest FROM workflow_runs WHERE id=?").get(String(row["workflow_run_id"])) as { workflow_digest: string } | undefined;
    if (runRow) workflowDigest = runRow.workflow_digest;
  } catch { /* direct jobs without a run keep the config digest */ }
  const parsedPayload = JSON.parse(artifactText) as { step?: { uses?: { type?: string } } };
  const kind = payloadRow?.kind === "eval" ? "eval"
    : payloadRow?.kind === "merge" ? "merge"
    : parsedPayload.step?.uses?.type === "agent" ? "agent" : "tool";
  const toolPins = releaseToolPins(s, String(row["config_digest"]));
  return {
    contractVersion: "brain.job-offer/v1", jobId: String(row["job_id"]), attemptId,
    runnerId: String(row["runner_id"]), runnerEpoch: Number(row["runner_epoch"]), leaseId: String(row["lease_id"]),
    jobFence: Number(row["job_fence"]), organizationId: String(row["organization_id"]), workspaceId: String(row["workspace_id"]),
    attemptNumber: Number(row["attempt_no"]), offerExpiresAt: iso(Number(row["offer_expires_at_ms"])),
    configDigest: String(row["config_digest"]), workflowDigest,
    placement: JSON.parse(String(row["placement_json"])),
    execution: { kind, artifact: { artifactId: artifact.artifactId, digest: artifact.digest, bytes: artifact.bytes, mediaType: "application/json", classification: "internal" } },
    toolPins,
    grantRef: `grant-${attemptId}`,
  } as unknown as JsonValue;
}

export function loadAttempt(s: Store, attemptId: string): Record<string, unknown> {
  const row = s.control.prepare(`SELECT a.*, j.organization_id, j.workspace_id, j.workflow_run_id, j.step_id, j.job_fence AS current_job_fence,j.state AS job_state, j.version AS job_version
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?`).get(attemptId) as Record<string, unknown> | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  return row;
}

export function assertAttemptLive(s: Store, runner: { runnerId: string; epoch: number }, row: Record<string, unknown>, leaseId?: string, jobFence?: number): void {
  if (String(row["runner_id"]) !== runner.runnerId) throw new BrainDomainError("FORBIDDEN", "attempt belongs to another runner");
  if (Number(row["runner_epoch"]) !== runner.epoch) throw new BrainDomainError("LEASE_LOST", "runner epoch fenced");
  const currentRunner = s.control.prepare("SELECT session_epoch,admin_state FROM runners WHERE id=?").get(runner.runnerId) as { session_epoch: number; admin_state: string } | undefined;
  if (!currentRunner || currentRunner.session_epoch !== runner.epoch || ["quarantined","disabled"].includes(currentRunner.admin_state) || row["job_fence"] !== row["current_job_fence"]) throw new BrainDomainError("LEASE_LOST", "runner or job is fenced");
  if (leaseId && String(row["lease_id"]) !== leaseId) throw new BrainDomainError("LEASE_LOST", "lease mismatch");
  if (jobFence !== undefined && Number(row["job_fence"]) !== jobFence) throw new BrainDomainError("LEASE_LOST", "job fence stale");
  if (Number(row["lease_expires_at_ms"]) <= s.now() && String(row["state"]) === "running") throw new BrainDomainError("LEASE_LOST", "lease expired");
  s.assertWorkspaceActive(String(row["workspace_id"]), String(row["organization_id"]));
}

export function ackAttempt(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  let result: JsonValue = null;
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, String(body["leaseId"] ?? ""), Number(body["jobFence"] ?? row["job_fence"]));
    if (String(row["state"]) === "running") { result = { attemptId, leaseExpiresAt: iso(Number(row["lease_expires_at_ms"])) } as unknown as JsonValue; return; }
    if (String(row["state"]) !== "offered") throw new BrainDomainError("CONFLICT", "attempt not offered");
    if (Number(row["offer_expires_at_ms"]) <= s.now()) throw new BrainDomainError("LEASE_LOST", "offer expired");
    const expires = s.now() + 60_000;
    s.control.prepare("UPDATE job_attempts SET state='running', lease_expires_at_ms=? WHERE id=?").run(expires, attemptId);
    s.control.prepare("UPDATE jobs SET state='running', version=version+1 WHERE id=?").run(String(row["job_id"]));
    result = { attemptId, leaseId: String(row["lease_id"]), jobFence: Number(row["job_fence"]), leaseExpiresAt: iso(expires) } as unknown as JsonValue;
  });
  return result;
}

export function renewAttempt(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  let expires = 0;
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, String(body["leaseId"] ?? ""), Number(body["jobFence"] ?? row["job_fence"]));
    if (String(row["state"]) !== "running") throw new BrainDomainError("CONFLICT", "attempt not running");
    expires = s.now() + 60_000;
    s.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(expires, attemptId);
  });
  return { attemptId, leaseExpiresAt: iso(expires) } as unknown as JsonValue;
}

export function attemptEvents(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  const events = (body["events"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (events.length > 128) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "event batch exceeds 128");
  // E063: malformed stream items are contained — rejected with diagnostics
  // before any sequence advance, never coerced (NaN would poison lastSeq).
  for (const ev of events) {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      throw new BrainDomainError("INVALID_CONTRACT", "attempt event must be an object");
    }
    const seqRaw = (ev as { sequence?: unknown }).sequence;
    if (seqRaw !== undefined && (!Number.isSafeInteger(seqRaw) || (seqRaw as number) < 1)) {
      throw new BrainDomainError("INVALID_CONTRACT", "attempt event sequence must be a positive safe integer");
    }
    if (JSON.stringify(ev).length > 64 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "attempt event exceeds 64 KiB");
  }
  let lastSeq = 0;
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, String(body["leaseId"] ?? row["lease_id"]), Number(body["jobFence"] ?? row["job_fence"]));
    lastSeq = Number(row["last_event_seq"]);
    s.control.exec("CREATE TABLE IF NOT EXISTS attempt_events(attempt_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(attempt_id, seq)) STRICT");
    for (const ev of events) {
      const seq = Number((ev as { sequence?: number }).sequence ?? (lastSeq + 1));
      if (seq <= lastSeq) continue;
      s.control.prepare("INSERT OR IGNORE INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, seq, JSON.stringify(ev));
      lastSeq = seq;
    }
    s.control.prepare("UPDATE job_attempts SET last_event_seq=? WHERE id=?").run(lastSeq, attemptId);
  });
  return { attemptId, lastCommittedSequence: lastSeq } as unknown as JsonValue;
}

export function releaseReservation(s: Store, attemptId: string): void {
  const res = s.control.prepare("SELECT runner_id, cpu, memory, disk, slots, released_at_ms FROM capacity_reservations WHERE attempt_id=?").get(attemptId) as
    | { runner_id: string; cpu: number; memory: number; disk: number; slots: number; released_at_ms: number | null } | undefined;
  if (!res || res.released_at_ms) return;
  s.control.prepare("UPDATE runners SET cpu_reserved=MAX(0,cpu_reserved-?), memory_reserved=MAX(0,memory_reserved-?), disk_reserved=MAX(0,disk_reserved-?), slots_reserved=MAX(0,slots_reserved-?) WHERE id=?")
    .run(res.cpu, res.memory, res.disk, res.slots, res.runner_id);
  s.control.prepare("UPDATE capacity_reservations SET released_at_ms=? WHERE attempt_id=?").run(s.now(), attemptId);
}

export function completeAttempt(s: Store, deps: { completeStep: (organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean) => void }, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, body: Record<string, unknown>): JsonValue {
  const result = String(body["result"] ?? "failed");
  if (!["succeeded","failed","unknown-outcome"].includes(result) || !Number.isSafeInteger(body["jobFence"]) || typeof body["cleanupConfirmed"] !== "boolean") throw new BrainDomainError("INVALID_CONTRACT", "completion requires a valid result, fence and cleanup status");
  const output = (body["output"] ?? null) as JsonValue;
  let jobState = "";
  let runId = ""; let stepId = ""; let workspaceId = ""; let jobId = "";
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    runId = String(row["workflow_run_id"]); stepId = String(row["step_id"]); workspaceId = String(row["workspace_id"]); jobId = String(row["job_id"]);
    const receiptDigest = domainDigest("brain:receipt:v1", body as unknown as JsonValue);
    assertAttemptLive(s, runner, row, undefined, Number(body["jobFence"]));
    if (row["organization_id"] !== runner.organizationId) throw new BrainDomainError("FORBIDDEN", "attempt tenant mismatch");
    if (row["receipt_digest"] === receiptDigest) { jobState=String(row["job_state"]); return; }
    if (row["receipt_digest"] && String(row["receipt_digest"]) !== receiptDigest && ["verifying", "succeeded"].includes(String(row["state"]))) {
      throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "different receipt for completed attempt");
    }
    if (row["state"] !== "running" || row["job_state"] !== "running") throw new BrainDomainError("CONFLICT", "attempt cannot accept a new completion receipt");
    const cleanup = body["cleanupConfirmed"] === true ? 1 : 0;
    if (result === "unknown-outcome" || result === "unknown") {
      s.control.prepare("UPDATE job_attempts SET state='outcome_unknown', receipt_digest=?, cleanup_confirmed=? WHERE id=?").run(receiptDigest, cleanup, attemptId);
      s.control.prepare("UPDATE jobs SET state='outcome_unknown', version=version+1 WHERE id=?").run(String(row["job_id"]));
      jobState = "outcome_unknown";
    } else if (result === "succeeded") {
      s.control.prepare("UPDATE job_attempts SET state='verifying', receipt_digest=?, cleanup_confirmed=? WHERE id=?").run(receiptDigest, cleanup, attemptId);
      s.control.prepare("UPDATE jobs SET state='verifying', version=version+1 WHERE id=?").run(String(row["job_id"]));
      s.control.exec("CREATE TABLE IF NOT EXISTS job_outputs(job_id TEXT PRIMARY KEY, output_json TEXT NOT NULL) STRICT");
      s.control.prepare("INSERT OR REPLACE INTO job_outputs(job_id, output_json) VALUES (?,?)").run(String(row["job_id"]), JSON.stringify(output));
      jobState = "verifying";
    } else {
      s.control.prepare("UPDATE job_attempts SET state='failed', receipt_digest=?, cleanup_confirmed=? WHERE id=?").run(receiptDigest, cleanup, attemptId);
      s.control.prepare("UPDATE jobs SET state='failed', version=version+1 WHERE id=?").run(String(row["job_id"]));
      jobState = "failed";
    }
    if (cleanup === 1) releaseReservation(s, attemptId);
    for (const keyRow of s.control.prepare("SELECT resource_key FROM resource_leases WHERE attempt_id=?").all(attemptId) as Array<{ resource_key: string }>) {
      void keyRow; // unresolved guards persist until reconciled; compute release is separate
    }
  });
  s.emit(s.control, { organizationId: runner.organizationId, workspaceId, aggregateType: "job", aggregateId: jobId, eventType: "job.updated", payload: { attemptId, jobState }, destinations: [`workspace:${workspaceId}`] });
  if (jobState === "failed") deps.completeStep(runner.organizationId, workspaceId, runId, stepId, output, false);
  return { attemptId, jobState, acceptedForVerification: jobState === "verifying" } as unknown as JsonValue;
}

export function releaseAttempt(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, body["leaseId"] === undefined ? undefined : String(body["leaseId"]), body["jobFence"] === undefined ? undefined : Number(body["jobFence"]));
    const cleanup = body["cleanupConfirmed"] === true;
    if (cleanup) s.control.prepare("UPDATE job_attempts SET cleanup_confirmed=1 WHERE id=?").run(attemptId);
    if (cleanup) releaseReservation(s, attemptId);
    if (String(row["state"]) === "offered") {
      s.control.prepare("UPDATE job_attempts SET state='declined' WHERE id=?").run(attemptId);
      s.control.prepare("UPDATE jobs SET state='queued', version=version+1 WHERE id=?").run(String(row["job_id"]));
      releaseReservation(s, attemptId);
    }
  });
  return { attemptId, released: true } as unknown as JsonValue;
}

export function expireLeases(s: Store): number {
  let count = 0;
  s.inTx(s.control, () => {
    const offered = s.control.prepare("SELECT id, job_id FROM job_attempts WHERE state='offered' AND offer_expires_at_ms<=?").all(s.now()) as Array<{ id: string; job_id: string }>;
    for (const a of offered) {
      s.control.prepare("UPDATE job_attempts SET state='expired' WHERE id=?").run(a.id);
      s.control.prepare("UPDATE jobs SET state='queued', queue_reason='WAITING_FOR_RUNNER', version=version+1 WHERE id=? AND state='offered'").run(a.job_id);
      releaseReservation(s, a.id);
      count++;
    }
    const running = s.control.prepare("SELECT id, job_id FROM job_attempts WHERE state='running' AND lease_expires_at_ms<=?").all(s.now()) as Array<{ id: string; job_id: string }>;
    for (const a of running) {
      s.control.prepare("UPDATE job_attempts SET state='outcome_unknown' WHERE id=?").run(a.id);
      s.control.prepare("UPDATE jobs SET state='outcome_unknown', version=version+1 WHERE id=? AND state='running'").run(a.job_id);
      count++;
    }
  });
  return count;
}
