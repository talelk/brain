import { describe, expect, it } from "vitest";
import { createStreamService, emitterOf, severityOf, sweepStream } from "../../apps/governor/src/modules/stream/index";
import { JobProtocol } from "../../apps/governor/src/modules/jobs/index";
import type { Store } from "../../apps/governor/src/application/store";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";

const DAY = 24 * 3600_000;

/** JobProtocol with scripted ports: heartbeat/event paths never reach the ports. */
function jobsProtocol(s: Store): JobProtocol {
  return new JobProtocol(s, {
    completeStep: () => undefined,
    evaluatorEligible: () => true,
    runnerCurrent: () => true,
    activeRelease: () => undefined,
    resolveWorkflow: () => ({ workflow: {}, configDigest: `sha256:${"0".repeat(64)}` }),
    startRun: () => ({ runId: "unused" }),
  });
}

function seedRunner(w: TestWorld, runnerId: string): void {
  w.brain.store.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity, session_epoch)
    VALUES (?, ?, 'group-fixture', 'key-digest', 'enabled', 'healthy', ?, 4000, 8192, 20480, 1, 1)`).run(runnerId, w.org, w.brain.activeRelease(w.org)!.digest);
}

function seedJob(w: TestWorld, jobId: string, runId: string, runnerId: string, attemptId: string): void {
  const s = w.brain.store;
  const now = s.now();
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, job_fence, created_at_ms, ready_at_ms, deadline_ms)
    VALUES (?, ?, ?, ?, ?, 'step-1', 'running', ?, '{"resources":{"cpuMillicores":500,"memoryMb":512,"diskMb":512,"slots":1}}', 'exec-digest', 'read', 1, ?, ?, ?)`)
    .run(jobId, w.org, w.workspaceId, `exec-${jobId}`, runId, w.brain.activeRelease(w.org)!.digest, now, now, now + 7 * DAY);
  s.control.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms, last_event_seq)
    VALUES (?, ?, ?, 1, 1, ?, 1, 'running', ?, ?, 0)`).run(attemptId, jobId, runnerId, `lease-${attemptId}`, now + 10_000, now + 60_000);
}

function seedSession(w: TestWorld, sessionId: string, jobId: string, attemptId: string, engineFeatures: string[]): void {
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const now = w.brain.store.now();
  ws.prepare(`INSERT INTO sessions(id, job_id, attempt_id, mode, agent_id, task, engine_id, adapter_digest, engine_features, state, root_session_id, worktree_id, created_by, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, 'managed', 'agent-fixture', 'inspect the failing diff', 'fixture', ?, ?, 'running', ?, 'wt-fixture', 'owner-1', ?, ?)`)
    .run(sessionId, jobId, attemptId, `sha256:${"0".repeat(64)}`, JSON.stringify(engineFeatures), sessionId, now, now);
}

function seedAttemptEvent(w: TestWorld, attemptId: string, seq: number, wire: Record<string, unknown>): void {
  w.brain.store.control.exec(`CREATE TABLE IF NOT EXISTS attempt_events(attempt_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(attempt_id, seq)) STRICT`);
  w.brain.store.control.prepare("INSERT OR IGNORE INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)")
    .run(attemptId, seq, JSON.stringify({ sequence: seq, kind: "engine", payload: wire }));
}

function engineEvent(attemptId: string, seq: number, kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { contractVersion: "brain.engine-event/v1", eventId: `seed-evt-${attemptId}-${seq}`, sessionId: `eng-${attemptId}`, attemptId, sequence: seq, occurredAt: new Date().toISOString(), kind, payload };
}

describe("unified execution stream", () => {
  it("projects records from all three source logs with identity, time, source, severity, emitter and correlation", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      seedRunner(w, "runner-stream-1");
      seedJob(w, "job-stream-1", "run-stream-1", "runner-stream-1", "att-stream-1");
      seedSession(w, "ses-stream-1", "job-stream-1", "att-stream-1", ["sessions", "steer"]);
      // attempt source (engine text event, payload carries occurredAt)
      seedAttemptEvent(w, "att-stream-1", 1, engineEvent("att-stream-1", 1, "text", { text: "fixture steering target hello", channel: "assistant", provisional: true }));
      // control source
      s.emit(s.control, { organizationId: w.org, workspaceId: w.workspaceId, aggregateType: "job", aggregateId: "job-stream-1", eventType: "job.queued", payload: { jobId: "job-stream-1", runId: "run-stream-1" } });
      // workspace source
      s.emit(s.workspaceDb(w.workspaceId, w.org), { aggregateType: "session", aggregateId: "ses-stream-1", eventType: "session.created", payload: { sessionId: "ses-stream-1" } });
      const result = stream.project();
      expect(result.projected).toBeGreaterThanOrEqual(3);
      const page = stream.read(w.owner, { workspaceId: w.workspaceId }, 200);
      const sources = new Set(page.items.map((item) => item.source));
      expect(sources.has("attempt")).toBe(true);
      expect(sources.has("control")).toBe(true);
      expect(sources.has("workspace")).toBe(true);
      const attemptRow = page.items.find((item) => item.source === "attempt")!;
      expect(attemptRow.eventId).toBe("evt-attempt-att-stream-1-1");
      expect(attemptRow.eventType).toBe("text");
      expect(attemptRow.emitter).toBe("agent");
      expect(attemptRow.severity).toBe("info");
      expect(attemptRow.tsApproximate).toBe(false);
      expect(attemptRow.correlation).toMatchObject({ jobId: "job-stream-1", runId: "run-stream-1", attemptId: "att-stream-1", sessionId: "ses-stream-1" });
      expect((attemptRow.payloadRef as { kind: string }).kind).toBe("attempt");
      const controlRow = page.items.find((item) => item.source === "control" && item.eventType === "job.queued")!;
      expect(controlRow.eventId).toBeTruthy();
      expect(controlRow.emitter).toBe("governor");
      expect(controlRow.correlation).toMatchObject({ jobId: "job-stream-1", runId: "run-stream-1" });
      // Cursor spaces are unified: stream_seq is the only cursor.
      const seqs = page.items.map((item) => item.streamSeq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(stream.head()).toBe(Math.max(...seqs));
    } finally {
      w.brain.close();
    }
  });

  it("surfaces seeded rows on read without a prior maintenance tick (projection-on-read)", () => {
    const w = setupWorld();
    try {
      seedRunner(w, "runner-stream-2");
      seedJob(w, "job-stream-2", "run-stream-2", "runner-stream-2", "att-stream-2");
      seedSession(w, "ses-stream-2", "job-stream-2", "att-stream-2", ["sessions"]);
      seedAttemptEvent(w, "att-stream-2", 1, engineEvent("att-stream-2", 1, "error", { error: { code: "DEPENDENCY_UNAVAILABLE", detail: "model unreachable" }, phase: "stream", retryClass: "new-attempt" }));
      // No explicit project(): the read path projects.
      const frames = w.brain.listEvents(w.owner, 0, { workspaceId: w.workspaceId }, 200);
      const errorFrame = frames.find((frame) => frame["type"] === "error");
      expect(errorFrame).toBeTruthy();
      expect(errorFrame!["severity"]).toBe("error");
      expect(errorFrame!["emitter"]).toBe("agent");
      expect(errorFrame!["source"]).toBe("attempt");
    } finally {
      w.brain.close();
    }
  });

  it("is idempotent under watermark replay and rebuilds after a lost watermark", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      seedRunner(w, "runner-stream-3");
      seedJob(w, "job-stream-3", "run-stream-3", "runner-stream-3", "att-stream-3");
      seedSession(w, "ses-stream-3", "job-stream-3", "att-stream-3", ["sessions"]);
      seedAttemptEvent(w, "att-stream-3", 1, engineEvent("att-stream-3", 1, "text", { text: "replay me", channel: "diagnostic", provisional: true }));
      s.emit(s.control, { organizationId: w.org, aggregateType: "config", aggregateId: "cfg-x", eventType: "config.compiled", payload: { digest: "cfg-x" } });
      stream.project();
      const count = () => (s.control.prepare("SELECT COUNT(*) AS c FROM execution_stream").get() as { c: number }).c;
      const first = count();
      stream.project();
      stream.project();
      expect(count()).toBe(first);
      // Crash recovery: a lost watermark row re-projects as a no-op.
      s.control.prepare("DELETE FROM stream_watermarks WHERE source='attempt' AND key='att-stream-3'").run();
      stream.project();
      expect(count()).toBe(first);
      const fts = (s.control.prepare("SELECT COUNT(*) AS c FROM execution_stream_fts").get() as { c: number }).c;
      expect(fts).toBe(first);
    } finally {
      w.brain.close();
    }
  });

  it("scopes reads in SQL by organization and workspace membership before LIMIT", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      w.brain.createWorkspace(w.owner, { workspaceId: "ws-stream-b", slug: "stream-b" });
      // member-1 belongs to ws-test only.
      seedHuman(w.brain, w.org, "member-1");
      s.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'member-1', 'viewer', 1, 'owner-1', ?)")
        .run(w.workspaceId, w.org, s.now());
      const wsB = s.workspaceDb("ws-stream-b", w.org);
      s.emit(wsB, { aggregateType: "session", aggregateId: "ses-b-1", eventType: "session.created", payload: { sessionId: "ses-b-1" } });
      s.emit(s.workspaceDb(w.workspaceId, w.org), { aggregateType: "session", aggregateId: "ses-a-1", eventType: "session.created", payload: { sessionId: "ses-a-1" } });
      s.emit(s.control, { organizationId: w.org, aggregateType: "config", aggregateId: "cfg-org-1", eventType: "config.compiled", payload: { digest: "cfg-org-1" } });
      stream.project();
      const member = w.actor("member-1");
      // LIMIT 1 must be filled by an authorized row, not post-filtered to emptiness.
      const page = stream.read(member, {}, 1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.workspaceId === w.workspaceId || page.items[0]!.workspaceId === undefined).toBe(true);
      const all = stream.read(member, {}, 200).items;
      expect(all.some((item) => item.workspaceId === "ws-stream-b")).toBe(false);
      expect(all.some((item) => item.workspaceId === undefined && item.eventType === "config.compiled")).toBe(true);
      // Org-scoped rows are visible org-wide: explicit workspace scoping still
      // surfaces them — runner records carry no workspace of their own — while
      // other workspaces' member rows stay excluded.
      s.emit(s.control, { organizationId: w.org, aggregateType: "runner", aggregateId: "runner-stream-scope", eventType: "runner.enabled", payload: { runnerId: "runner-stream-scope" } });
      stream.project();
      const scoped = stream.read(member, { workspaceId: w.workspaceId }, 200).items;
      expect(scoped.some((item) => item.workspaceId === undefined && item.eventType === "config.compiled")).toBe(true);
      expect(scoped.some((item) => item.emitter === "runner" && item.eventType === "runner.enabled")).toBe(true);
      expect(scoped.some((item) => item.workspaceId === "ws-stream-b")).toBe(false);
      // Explicit workspace scoping stays denied without membership.
      expect(() => stream.read(member, { workspaceId: "ws-stream-b" }, 10)).toThrow(/workspace not found/);
      // Cross-organization actors see nothing.
      expect(stream.read({ ...w.owner, organizationId: "org-elsewhere" }, {}, 200).items).toEqual([]);
    } finally {
      w.brain.close();
    }
  });

  it("classifies severity and emitter from the pure table", () => {
    expect(severityOf("attempt", "error", {})).toBe("error");
    expect(severityOf("attempt", "session.stopped", { reason: "budget" })).toBe("error");
    expect(severityOf("attempt", "session.stopped", { reason: "timeout" })).toBe("error");
    expect(severityOf("attempt", "session.stopped", { reason: "completed" })).toBe("info");
    expect(severityOf("attempt", "tool.result", { receipt: { result: "failed" } })).toBe("error");
    expect(severityOf("attempt", "tool.result", { receipt: { result: "partial" } })).toBe("warning");
    expect(severityOf("attempt", "tool.result", { receipt: { result: "unknown" } })).toBe("warning");
    expect(severityOf("attempt", "tool.result", { receipt: { result: "succeeded" } })).toBe("info");
    expect(severityOf("attempt", "text", { channel: "diagnostic" })).toBe("debug");
    expect(severityOf("attempt", "text", { channel: "assistant" })).toBe("info");
    expect(severityOf("control", "operations.restored-authority-quarantined", null)).toBe("critical");
    expect(severityOf("control", "job.queued", {})).toBe("info");
    expect(emitterOf("control", "session.created")).toBe("agent");
    expect(emitterOf("workspace", "workItem.message")).toBe("agent");
    expect(emitterOf("control", "workItem.transition")).toBe("governor");
    expect(emitterOf("attempt", "tool.proposed")).toBe("tool");
    expect(emitterOf("attempt", "attempt.effect")).toBe("tool");
    expect(emitterOf("attempt", "text")).toBe("agent");
    expect(emitterOf("control", "runner.online")).toBe("runner");
    expect(emitterOf("control", "evidence.verified")).toBe("evaluator");
    expect(emitterOf("control", "integration.verified")).toBe("connector");
    expect(emitterOf("control", "reconciliation.requested")).toBe("system");
    expect(emitterOf("control", "brand.new.event")).toBe("governor");
  });

  it("searches bounded summaries via FTS with scope enforced", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      seedRunner(w, "runner-stream-4");
      seedJob(w, "job-stream-4", "run-stream-4", "runner-stream-4", "att-stream-4");
      seedSession(w, "ses-stream-4", "job-stream-4", "att-stream-4", ["sessions"]);
      seedAttemptEvent(w, "att-stream-4", 1, engineEvent("att-stream-4", 1, "text", { text: "the quokka migration completed", channel: "assistant", provisional: true }));
      stream.project();
      const found = stream.search(w.owner, { search: "quokka migration" }, 20);
      expect(found.totalEstimate).toBeGreaterThanOrEqual(1);
      expect(found.items[0]!.source).toBe("attempt");
      // Member scoping applies to search as well.
      seedHuman(w.brain, w.org, "member-search");
      s.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'member-search', 'viewer', 1, 'owner-1', ?)")
        .run(w.workspaceId, w.org, s.now());
      expect(stream.search(w.actor("member-search"), { search: "quokka" }, 20).items.length).toBe(found.items.length);
      expect(stream.search({ ...w.owner, organizationId: "org-elsewhere" }, { search: "quokka" }, 20).items).toEqual([]);
    } finally {
      w.brain.close();
    }
  });

  it("pages search matches past the first page with the before cursor", async () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      seedRunner(w, "runner-stream-11");
      seedJob(w, "job-stream-11", "run-stream-11", "runner-stream-11", "att-stream-11");
      seedSession(w, "ses-stream-11", "job-stream-11", "att-stream-11", ["sessions"]);
      for (let seq = 1; seq <= 60; seq++) {
        seedAttemptEvent(w, "att-stream-11", seq, engineEvent("att-stream-11", seq, "text", { text: `paging probe ${seq}`, channel: "assistant", provisional: true }));
      }
      stream.project();
      const first = stream.search(w.owner, { search: "paging probe", workspaceId: w.workspaceId }, 50);
      expect(first.items).toHaveLength(50);
      expect(first.totalEstimate).toBe(60);
      expect(typeof first.nextCursor).toBe("number");
      // The cursor is the page's oldest stream_seq; as the exclusive `before`
      // bound it yields exactly the next older page, with no overlap.
      const second = stream.search(w.owner, { search: "paging probe", workspaceId: w.workspaceId, before: first.nextCursor as number }, 50);
      expect(second.items).toHaveLength(10);
      // The estimate counts matches within the page's own bounds — the cursor
      // is part of the filter set — so page two reports the 10 remaining.
      expect(second.totalEstimate).toBe(10);
      const firstSeqs = new Set(first.items.map((item) => item.streamSeq));
      for (const item of second.items) expect(firstSeqs.has(item.streamSeq)).toBe(false);
      expect(second.items.every((item) => item.streamSeq < (first.nextCursor as number))).toBe(true);
      // The last page leaves no further cursor.
      expect(second.nextCursor).toBe("");
      // The cursor rides the public query envelope: the contract accepts
      // `before` and the brain-level read returns the same older page.
      const envelope = (await w.brain.executeQuery(w.owner, { queryType: "stream.search", workspaceId: w.workspaceId, search: "paging probe", before: first.nextCursor as number, limit: 50 })) as { snapshot: { items: Array<{ streamSeq: number }> } };
      expect(envelope.snapshot.items.map((item) => item.streamSeq)).toEqual(second.items.map((item) => item.streamSeq));
    } finally {
      w.brain.close();
    }
  });

  it("resolves the correlation bundle for a record including approval linkage and artifacts", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      const now = s.now();
      seedRunner(w, "runner-stream-5");
      seedJob(w, "job-stream-5", "run-stream-5", "runner-stream-5", "att-stream-5");
      seedSession(w, "ses-stream-5", "job-stream-5", "att-stream-5", ["sessions"]);
      const stdoutDigest = `sha256:${"b".repeat(64)}`;
      const ws = s.workspaceDb(w.workspaceId, w.org);
      ws.prepare("INSERT INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES ('art-stdout-5', ?, 32, 'text/plain', 'internal', 'verified', ?)")
        .run(stdoutDigest, now);
      s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
        VALUES ('apr-stream-5', ?, ?, 'owner-1', 'subject-digest', '{}', 'approved', ?, ?)`).run(w.org, w.workspaceId, now + DAY, now);
      s.control.prepare(`INSERT INTO effect_permits(id, invocation_id, attempt_id, subject_digest, approval_id, state, revocation_generation, expires_at_ms, created_at_ms)
        VALUES ('perm-stream-5', 'inv-stream-5', 'att-stream-5', 'subject-digest', 'apr-stream-5', 'issued', 1, ?, ?)`).run(now + DAY, now);
      seedAttemptEvent(w, "att-stream-5", 1, engineEvent("att-stream-5", 1, "tool.result", {
        proposalId: "prop-stream-5", invocationId: "inv-stream-5",
        receipt: { invocationId: "inv-stream-5", attemptId: "att-stream-5", jobFence: 1, result: "failed", startedAt: new Date().toISOString(), stdout: { artifactId: "art-stdout-5", digest: stdoutDigest, bytes: 32, mediaType: "text/plain", classification: "internal" }, effects: [] },
      }));
      stream.project();
      const record = stream.read(w.owner, { attemptId: "att-stream-5" }, 10).items.find((item) => item.eventType === "tool.result")!;
      expect(record.severity).toBe("error");
      const bundle = stream.context(w.owner, record.eventId) as {
        record: { eventId: string }; attempt: { attemptId: string }; invocation: { invocationId: string; approvalId?: string };
        approval: { approvalId: string; state: string }; artifacts: Array<{ artifactId: string; digest: string }>; job?: { jobId: string };
      };
      expect(bundle.record.eventId).toBe(record.eventId);
      expect(bundle.attempt.attemptId).toBe("att-stream-5");
      expect(bundle.invocation.invocationId).toBe("inv-stream-5");
      expect(bundle.invocation.approvalId).toBe("apr-stream-5");
      expect(bundle.approval.state).toBe("approved");
      expect(bundle.artifacts).toContainEqual(expect.objectContaining({ artifactId: "art-stdout-5", digest: stdoutDigest }));
    } finally {
      w.brain.close();
    }
  });

  it("compares attempts of one job within bounds", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      seedRunner(w, "runner-stream-6");
      seedJob(w, "job-stream-6", "run-stream-6", "runner-stream-6", "att-stream-6a");
      seedSession(w, "ses-stream-6", "job-stream-6", "att-stream-6a", ["sessions"]);
      s.control.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms, last_event_seq)
        VALUES ('att-stream-6b', 'job-stream-6', 'runner-stream-6', 1, 2, 'lease-b', 2, 'failed', ?, ?, 0)`).run(s.now() + 10_000, s.now() + 60_000);
      seedAttemptEvent(w, "att-stream-6a", 1, engineEvent("att-stream-6a", 1, "text", { text: "first attempt text", channel: "assistant", provisional: true }));
      seedAttemptEvent(w, "att-stream-6b", 1, engineEvent("att-stream-6b", 1, "text", { text: "second attempt text", channel: "assistant", provisional: true }));
      stream.project();
      const comparison = stream.compare(w.owner, "job-stream-6", ["att-stream-6a", "att-stream-6b"]) as {
        jobId: string; attempts: Array<{ attemptId: string; items: Array<{ eventType: string }> }>;
      };
      expect(comparison.jobId).toBe("job-stream-6");
      expect(comparison.attempts).toHaveLength(2);
      expect(comparison.attempts[0]!.items.some((item) => item.eventType === "text")).toBe(true);
      expect(comparison.attempts[1]!.items.some((item) => item.eventType === "text")).toBe(true);
      expect(() => stream.compare(w.owner, "job-stream-6", ["a", "b", "c", "d", "e"])).toThrow(/1..4/);
      expect(() => stream.compare(w.owner, "job-stream-6", ["att-elsewhere"])).toThrow(/does not belong/);
    } finally {
      w.brain.close();
    }
  });

  it("exports bounded sanitized segments with source and time information", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      seedRunner(w, "runner-stream-7");
      seedJob(w, "job-stream-7", "run-stream-7", "runner-stream-7", "att-stream-7");
      seedSession(w, "ses-stream-7", "job-stream-7", "att-stream-7", ["sessions"]);
      for (let seq = 1; seq <= 5; seq++) {
        seedAttemptEvent(w, "att-stream-7", seq, engineEvent("att-stream-7", seq, "text", { text: `export line ${seq}`, channel: "assistant", provisional: true }));
      }
      stream.project();
      const exported = stream.exportSegment(w.owner, { workspaceId: w.workspaceId }, 3);
      const lines = exported.body.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const line of parsed) {
        expect(typeof line["streamSeq"]).toBe("number");
        expect(typeof line["eventId"]).toBe("string");
        expect(typeof line["emitter"]).toBe("string");
        expect(typeof line["eventType"]).toBe("string");
        expect(typeof line["at"]).toBe("string");
      }
      expect(exported.filename).toMatch(/^brain-logs-ws-test-\d+-\d+\.ndjson$/u);
      // Export authorization equals read authorization.
      expect(() => stream.exportSegment({ ...w.owner, organizationId: "org-elsewhere" }, { workspaceId: w.workspaceId }, 10)).toThrow();
    } finally {
      w.brain.close();
    }
  });

  it("retention sweep deletes old rows, keeps anchors and repairs FTS drift", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const stream = createStreamService(s);
      seedRunner(w, "runner-stream-8");
      seedJob(w, "job-stream-8", "run-stream-8", "runner-stream-8", "att-stream-8");
      seedSession(w, "ses-stream-8", "job-stream-8", "att-stream-8", ["sessions"]);
      seedAttemptEvent(w, "att-stream-8", 1, engineEvent("att-stream-8", 1, "text", { text: "old chatter to sweep", channel: "assistant", provisional: true }));
      s.emit(s.control, { organizationId: w.org, workspaceId: w.workspaceId, aggregateType: "job", aggregateId: "job-stream-8", eventType: "job.queued", payload: { jobId: "job-stream-8" } });
      stream.project();
      const cutoff = s.now() - 40 * DAY;
      s.control.prepare("UPDATE execution_stream SET occurred_at_ms=? WHERE event_type IN ('text','job.queued')").run(cutoff - 1);
      const result = sweepStream(s);
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      const remaining = s.control.prepare("SELECT event_type FROM execution_stream").all() as Array<{ event_type: string }>;
      expect(remaining.some((row) => row.event_type === "job.queued")).toBe(true); // anchor kept
      expect(remaining.some((row) => row.event_type === "text")).toBe(false);
      expect((s.control.prepare("SELECT COUNT(*) AS c FROM execution_stream_fts").get() as { c: number }).c)
        .toBe((s.control.prepare("SELECT COUNT(*) AS c FROM execution_stream").get() as { c: number }).c);
      // FTS drift repair rebuilds from the authoritative rows.
      s.control.prepare("DELETE FROM execution_stream_fts WHERE stream_seq IN (SELECT stream_seq FROM execution_stream LIMIT 1)").run();
      const repaired = sweepStream(s);
      expect(repaired.repaired).toBe(true);
      expect((s.control.prepare("SELECT COUNT(*) AS c FROM execution_stream_fts").get() as { c: number }).c)
        .toBe((s.control.prepare("SELECT COUNT(*) AS c FROM execution_stream").get() as { c: number }).c);
    } finally {
      w.brain.close();
    }
  });

  it("delivers session controls through the heartbeat ack and deletes them (at-most-once)", () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      const now = s.now();
      seedRunner(w, "runner-stream-9");
      seedJob(w, "job-stream-9", "run-stream-9", "runner-stream-9", "att-stream-9");
      seedSession(w, "ses-stream-9", "job-stream-9", "att-stream-9", ["sessions", "steer"]);
      s.control.prepare(`INSERT INTO runner_sessions(token_digest, runner_id, runner_epoch, expires_at_ms, created_at_ms)
        VALUES ('token-digest-9', 'runner-stream-9', 1, ?, ?)`).run(now + 900_000, now);
      const ws = s.workspaceDb(w.workspaceId, w.org);
      ws.exec("CREATE TABLE IF NOT EXISTS session_controls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT");
      ws.prepare("INSERT INTO session_controls(id, session_id, kind, payload, created_at_ms) VALUES ('ctl-steer-9', ?, 'session.steer', ?, ?)")
        .run("ses-stream-9", JSON.stringify({ sessionId: "ses-stream-9", message: "focus on the failing diff" }), now);
      ws.prepare("INSERT INTO session_controls(id, session_id, kind, payload, created_at_ms) VALUES ('ctl-stop-9', ?, 'session.stop', ?, ?)")
        .run("ses-stream-9", JSON.stringify({ sessionId: "ses-stream-9", reason: "operator stop" }), now);
      const first = jobsProtocol(s).heartbeat({ runnerId: "runner-stream-9", epoch: 1 }, { sequence: 1, health: "healthy" });
      expect(first.serverTime).toBeTruthy();
      expect(first.commands).toContainEqual(expect.objectContaining({ type: "steer", attemptId: "att-stream-9", text: "focus on the failing diff" }));
      expect(first.commands).toContainEqual(expect.objectContaining({ type: "stop-attempt", attemptId: "att-stream-9" }));
      expect((ws.prepare("SELECT COUNT(*) AS c FROM session_controls").get() as { c: number }).c).toBe(0);
      // A second heartbeat delivers nothing: rows were deleted with the ack.
      const second = jobsProtocol(s).heartbeat({ runnerId: "runner-stream-9", epoch: 1 }, { sequence: 2, health: "healthy" });
      expect(second.commands).toEqual([]);
      // Unbound sessions (no live attempt) are not drained.
      ws.prepare("INSERT INTO session_controls(id, session_id, kind, payload, created_at_ms) VALUES ('ctl-idle-9', 'ses-idle', 'session.steer', '{}', ?)").run(now);
      const third = jobsProtocol(s).heartbeat({ runnerId: "runner-stream-9", epoch: 1 }, { sequence: 3, health: "healthy" });
      expect(third.commands).toEqual([]);
      expect((ws.prepare("SELECT COUNT(*) AS c FROM session_controls").get() as { c: number }).c).toBe(1);
    } finally {
      w.brain.close();
    }
  });

  it("persists engine features from event batches and exposes continuation facts", async () => {
    const w = setupWorld();
    try {
      const s = w.brain.store;
      seedRunner(w, "runner-stream-10");
      seedJob(w, "job-stream-10", "run-stream-10", "runner-stream-10", "att-stream-10");
      seedSession(w, "ses-stream-10", "job-stream-10", "att-stream-10", ["sessions"]);
      const ack = jobsProtocol(s).events({ runnerId: "runner-stream-10", epoch: 1 }, "att-stream-10", {
        leaseId: "lease-att-stream-10", jobFence: 1,
        engine: { id: "fixture", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions", "steer"] },
        events: [{ sequence: 1, kind: "engine", payload: engineEvent("att-stream-10", 1, "text", { text: "feature carrier", channel: "assistant", provisional: true }) }],
      });
      expect(ack).toMatchObject({ attemptId: "att-stream-10", lastCommittedSequence: 1 });
      const ws = s.workspaceDb(w.workspaceId, w.org);
      const features = (ws.prepare("SELECT engine_features FROM sessions WHERE id='ses-stream-10'").get() as { engine_features: string }).engine_features;
      expect(JSON.parse(features)).toEqual(["sessions", "steer"]);
      const envelopeOf = async (query: Record<string, unknown>) => (await w.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: "ses-stream-10", ...query })) as unknown as { snapshot: Record<string, unknown> };
      const snapshot = (await envelopeOf({})) as unknown as { snapshot: {
        engine: { features: string[] }; streamCursor: number;
        continuation: { reconnectable: boolean; resumable: boolean; continueNative: boolean; restartable: boolean; reconcileRequired: boolean };
      } };
      expect(snapshot.snapshot.engine.features).toEqual(["sessions", "steer"]);
      expect(snapshot.snapshot.continuation.reconnectable).toBe(true);
      expect(snapshot.snapshot.continuation.continueNative).toBe(false);
      expect(snapshot.snapshot.streamCursor).toBeGreaterThan(0);
      // resume advertisement flips the continue-native fact.
      ws.prepare("UPDATE sessions SET engine_features='[\"sessions\",\"steer\",\"resume\"]' WHERE id='ses-stream-10'").run();
      const after = (await envelopeOf({})) as unknown as { snapshot: { continuation: { continueNative: boolean } } };
      expect(after.snapshot.continuation.continueNative).toBe(true);
      // Job snapshot names its bound session server-side.
      const job = (await w.brain.executeQuery(w.owner, { queryType: "job.get", resourceId: "job-stream-10" })) as unknown as { snapshot: { sessionId?: string } };
      expect(job.snapshot.sessionId).toBe("ses-stream-10");
    } finally {
      w.brain.close();
    }
  });
});
