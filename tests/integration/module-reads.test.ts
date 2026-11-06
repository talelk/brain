import { casFilePath } from "../../apps/governor/src/modules/artifacts/index";
import { describe, expect, it } from "vitest";
import { setupWorld, type TestWorld } from "../helpers";
import { BrainDomainError } from "../../apps/governor/src/domain/errors";
import { explainJob, getJob, getRunner, listJobs, listRunners } from "../../apps/governor/src/modules/jobs/read";
import { commandReceipt, getApproval, listApprovals } from "../../apps/governor/src/modules/governance/read";
import { liveStatus, platformHealth, workspaceContext, workspaceSummary } from "../../apps/governor/src/modules/operations/read";
import { getPack, listPack, slaSummary } from "../../apps/governor/src/modules/packs/read";
import { bridge, today } from "../../apps/governor/src/modules/work/read";
import { activeRelease, configExplain, releaseDefinitions, searchReleaseDocuments } from "../../apps/governor/src/modules/configuration/read";
import { artifactHistory, listArtifacts, readArtifactBytes } from "../../apps/governor/src/modules/evidence/read";
import { searchSessions } from "../../apps/governor/src/modules/sessions/read";
import { textMatcher } from "../../apps/governor/src/application/query";
import { sha256Digest } from "../../packages/contracts/src/index";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Module-level tests: each read model is exercised through its owning module's
// interface against a fixture Store, without going through the Brain facade.

function seedRunner(w: TestWorld, id: string, heartbeatMs = w.brain.store.now()) {
  w.brain.store.control.prepare(`INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,cpu_capacity,memory_capacity,disk_capacity,slot_capacity,last_heartbeat_ms)
    VALUES (?,?,'grp',?,'enabled','healthy',?,8000,16384,102400,4,?)`)
    .run(id, w.org, `sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`, heartbeatMs);
}

function seedJob(w: TestWorld, id: string, state = "queued", runId = `run-${id}`) {
  const digest = activeRelease(w.brain.store, w.org)!.digest;
  const now = w.brain.store.now();
  w.brain.store.control.prepare(`INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,version,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms)
    VALUES (?,?,'ws-test',?,?,?,?,1,?,?,?,'read',?,?,?)`)
    .run(id, w.org, `exec-${id}`, runId, "step", state, digest,
      JSON.stringify({ resources: { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 }, all: [] }), `sha256:${"d".repeat(64)}`, now, now, now + 60_000);
}

function seedApproval(w: TestWorld, id: string, state = "pending", expiresAtMs = w.brain.store.now() + 3_600_000) {
  w.brain.store.control.prepare(`INSERT INTO approval_requests(id,organization_id,workspace_id,requested_by,subject_digest,subject_json,state,expires_at_ms,created_at_ms)
    VALUES (?,?,?,'owner-1',?,?,'pending',?,?)`)
    .run(id, w.org, w.workspaceId, `sha256:${"e".repeat(64)}`, JSON.stringify({ operation: "deploy", target: { targetId: "svc-x" } }), state === "pending" ? w.brain.store.now() + 3_600_000 : expiresAtMs, w.brain.store.now());
}

describe("jobs module read surface", () => {
  it("lists, resolves and explains jobs through the module interface", () => {
    const w = setupWorld();
    seedJob(w, "job-1");
    seedRunner(w, "runner-1", w.brain.store.now() - 120_000); // offline by heartbeat age

    const page = listJobs(w.brain.store, w.owner, [w.workspaceId], 50);
    const snapshot = page.snapshot as { items: Array<Record<string, unknown>>; totalEstimate: number };
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.totalEstimate).toBe(1);
    expect((snapshot.items[0] as { jobId: string }).jobId).toBe("job-1");

    const job = getJob(w.brain.store, w.owner, "run-job-1") as Record<string, unknown>;
    expect(job.jobId).toBe("job-1"); // run id resolves to the newest job

    const explained = explainJob(w.brain.store, w.owner, "job-1");
    expect(explained.runners).toHaveLength(1);
    expect(explained.primaryReason).toBe("RUNNER_OFFLINE");

    const runners = listRunners(w.brain.store, w.owner, 50) as { items: Array<Record<string, unknown>> };
    expect(runners.items).toHaveLength(1);
    expect(runners.items[0]!.connectivity).toBe("offline");
    expect((runners.items[0]!.observedFree as { slots: number }).slots).toBe(4);
    expect(getRunner(w.brain.store, w.owner, "runner-1")).toBeTruthy();
    expect(() => getRunner(w.brain.store, w.owner, "nope")).toThrowError(BrainDomainError);

    w.brain.close();
  });
});

describe("governance module read surface", () => {
  it("lists and gates approvals and reads own command receipts", () => {
    const w = setupWorld();
    seedApproval(w, "apr-1");
    const items = (listApprovals(w.brain.store, w.owner, [w.workspaceId], 50) as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.approvalId).toBe("apr-1");
    expect((getApproval(w.brain.store, w.owner, [w.workspaceId], "apr-1") as Record<string, unknown>).state).toBe("pending");
    expect(() => getApproval(w.brain.store, w.owner, ["other-ws"], "apr-1")).toThrowError(/not found/);

    w.brain.store.control.prepare(`INSERT INTO command_idempotency(organization_id,actor_id,command_type,idempotency_key,request_digest,command_id,receipt_json,created_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run(w.org, "owner-1", "workItem.transition", "k-1", `sha256:${"f".repeat(64)}`, "cmd-1", '{"ok":true}', w.brain.store.now());
    expect((commandReceipt(w.brain.store, w.owner, "cmd-1") as Record<string, unknown>).state).toBe("applied");
    const stranger = w.actor("stranger-1", w.workspaceId);
    expect(() => commandReceipt(w.brain.store, stranger, "cmd-1")).toThrowError(BrainDomainError);

    w.brain.close();
  });
});

describe("operations module read surface", () => {
  it("summarizes workspaces, explains context and lands live.status", () => {
    const w = setupWorld();
    seedApproval(w, "apr-1");
    seedJob(w, "job-1", "blocked");
    const summary = workspaceSummary(w.brain.store, w.org, w.workspaceId);
    expect(summary.pendingApprovals).toBe(1);
    expect(summary.blockedJobs).toBe(1);
    expect(summary.health).toBe("degraded");

    const context = workspaceContext(w.brain.store, w.owner, w.workspaceId) as Record<string, unknown>;
    expect((context.release as Record<string, unknown>).configDigest).toBe(activeRelease(w.brain.store, w.org)!.digest);
    expect((context.ui as Record<string, unknown>).foundation).toBe("newui");
    expect((context.workspace as Record<string, unknown>).blockedJobs).toBe(1);

    const live = liveStatus(w.brain.store, w.owner, w.workspaceId) as Record<string, unknown>;
    expect(live.pendingApprovals).toBe(1);
    expect(live.needsAttention).toBe(true);
    expect(live.defaultRoute).toBe("today"); // no active sessions/runs

    const health = platformHealth(w.brain.store, { status: "disabled", detail: "local store", checkedAt: "" }) as Record<string, unknown>;
    expect(health.status).toBe("healthy");
    w.brain.close();
  });
});

describe("packs module read surface", () => {
  it("maps ticket/incident/delivery views and sums SLA intervals", () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const now = w.brain.store.now();
    ws.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,version,priority,created_at_ms) VALUES ('tkt-1','gitlab','1','open','Fix login',?,'v1',?,1,'normal',?)")
      .run(`sha256:${"1".repeat(64)}`, now, now);
    ws.prepare("INSERT INTO sla_intervals(id,ticket_id,event_id,responsibility,started_at_ms,ended_at_ms,calendar_digest) VALUES ('sla-1','tkt-1','ev-1','keyrus',?,?,?)")
      .run(now - 120_000, now, `sha256:${"2".repeat(64)}`);

    const items = (listPack(w.brain.store, w.owner, "tickets.list", w.workspaceId) as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("tkt-1");
    expect(items[0]!.evidenceReady).toBe(false);

    const detail = getPack(w.brain.store, w.owner, "ticket.get", w.workspaceId, "tkt-1") as Record<string, unknown>;
    expect(detail.id).toBe("tkt-1");
    expect(detail.body).toBeDefined();

    const summary = slaSummary(w.brain.store, w.owner, w.workspaceId, now - 3_600_000, now) as Record<string, unknown>;
    expect(summary.sampleCount).toBe(1);
    expect(summary.keyrusMs).toBe(120_000);
    expect(summary.hubWaitMs).toBe(0);
    w.brain.close();
  });
});

describe("work module read surface", () => {
  it("surfaces approvals and unknown outcomes on today, and summarizes on bridge", () => {
    const w = setupWorld();
    seedApproval(w, "apr-1");
    seedJob(w, "job-1", "outcome_unknown");
    const items = (today(w.brain.store, w.owner, [w.workspaceId], 50) as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.type)).toContain("approval");
    expect(items.map((i) => i.type)).toContain("job");
    const bridgeItems = (bridge(w.brain.store, w.owner, [w.workspaceId]) as { items: Array<Record<string, unknown>> }).items;
    expect(bridgeItems[0]!.workspaceId).toBe(w.workspaceId);
    w.brain.close();
  });
});

describe("evidence module read surface", () => {
  it("lists artifacts, verifies bytes and reads history through the module", () => {
    const w = setupWorld();
    const bytes = Buffer.from("left text\nshared\n", "utf8");
    const digest = sha256Digest(bytes);
    const casFile = casFilePath(w.brain.store, digest);
    mkdirSync(join(casFile, ".."), { recursive: true });
    writeFileSync(casFile, bytes);
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    ws.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES ('art-1',?,?,'text/plain','internal','verified',?)")
      .run(digest, bytes.length, w.brain.store.now());
    w.brain.store.control.prepare("INSERT INTO artifact_associations(artifact_id,organization_id,workspace_id,digest,owner_kind,owner_id,classification,verified_at_ms) VALUES ('art-1',?,?,?,'job','job-1',?,?)")
      .run(w.org, w.workspaceId, digest, "internal", w.brain.store.now());

    const listed = listArtifacts(w.brain.store, w.owner, w.workspaceId, {}) as { items: Array<Record<string, unknown>> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.digest).toBe(digest);

    expect(Buffer.from(readArtifactBytes(w.brain.store, w.owner, "art-1"))).toEqual(bytes);
    const history = artifactHistory(w.brain.store, w.owner, { artifactId: "art-1" }) as Record<string, unknown>;
    expect(history.digest).toBe(digest);
    expect(history.producer).toEqual({ jobId: "job-1" });
    w.brain.close();
  });
});

describe("configuration module read surface", () => {
  it("exposes release definitions, config explain and release search", () => {
    const w = setupWorld();
    const workflows = releaseDefinitions(w.brain.store, w.org, "workflows") as { items: Array<{ release: { id: string } }> };
    expect(workflows.items.length).toBeGreaterThan(0);
    const one = releaseDefinitions(w.brain.store, w.org, "workflows", "fixture-workflow") as Record<string, unknown>;
    expect((one.release as Record<string, unknown>).id).toBe("fixture-workflow");

    const explained = configExplain(w.brain.store, w.org, "/workflows/fixture-workflow") as Record<string, unknown>;
    expect(explained.effective).not.toBeNull();
    expect((explained.sources as Array<Record<string, unknown>>)[0]!.rule).toBe("declared-in-active-release");

    const docs = searchReleaseDocuments(w.brain.store, w.org, w.workspaceId, textMatcher("fixture"), w.brain.store.nowIso());
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.map((d) => d.category)).toContain("workflow");
    w.brain.close();
  });
});

describe("sessions module search helper", () => {
  it("matches sessions by task, id, agent or state", () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    ws.prepare("INSERT INTO sessions(id,engine_id,adapter_digest,agent_id,task,state,created_at_ms,updated_at_ms) VALUES ('ses-1','pi','sha256:00','planner','triage the incident report','running',?,?)")
      .run(w.brain.store.now(), w.brain.store.now());
    const hits = searchSessions(w.brain.store, w.org, w.workspaceId, textMatcher("triage"));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.category).toBe("session");
    w.brain.close();
  });
});
