import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A } from "../helpers";
import { approvalSubjectDigest, type JsonValue } from "@brain/contracts";

// T43 packet acceptance (local slice): observation ingestion is debounced
// and collision-safe, and incident views are freshness-aware (latest
// observation wins). Remediation stays proposal-only — nothing here can
// execute an effect.
describe("sre observations and incident freshness (T43)", () => {
  it("duplicate observations are stable; id collisions park without touching the accepted record", () => {
    const w = setupWorld();
    const first = w.brain.ingestObservation({
      organizationId: w.org, workspaceId: w.workspaceId, sourceId: "probe-1",
      externalId: "obs-1", cursor: "c1", payload: { status: "up", latencyMs: 12 },
    }) as unknown as { outcome: string; payloadDigest: string };
    expect(first.outcome).toBe("accepted");
    const dup = w.brain.ingestObservation({
      organizationId: w.org, workspaceId: w.workspaceId, sourceId: "probe-1",
      externalId: "obs-1", cursor: "c2", payload: { status: "up", latencyMs: 12 },
    }) as unknown as { outcome: string };
    expect(dup.outcome).toBe("duplicate");
    const collision = w.brain.ingestObservation({
      organizationId: w.org, workspaceId: w.workspaceId, sourceId: "probe-1",
      externalId: "obs-1", cursor: "c3", payload: { status: "down", latencyMs: 999 },
    }) as unknown as { outcome: string };
    expect(collision.outcome).toBe("parked");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const accepted = ws.prepare("SELECT payload_json FROM source_observations WHERE source_id='probe-1' AND external_id='obs-1'").get() as { payload_json: string };
    expect(JSON.parse(accepted.payload_json)).toEqual({ status: "up", latencyMs: 12 });
    expect((ws.prepare("SELECT COUNT(*) AS c FROM parked_observations").get() as { c: number }).c).toBe(1);
    w.brain.close();
  });

  it("incident detail reports the freshest observation window", async () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const t0 = Date.now() - 7200_000;
    ws.prepare("INSERT INTO incidents(id, target_key, severity, title, state, version, opened_at_ms) VALUES ('inc-9','api','critical','API down','investigating',3,?)").run(t0);
    ws.prepare("INSERT INTO observations(id, connector_id, target_key, incident_id, observation_digest, source_event_id, observed_at_ms, expires_at_ms) VALUES ('o1','probe','api','inc-9',?,'e1',?,?)").run(DIGEST_A, t0 + 1000, t0 + 2000);
    ws.prepare("INSERT INTO observations(id, connector_id, target_key, incident_id, observation_digest, source_event_id, observed_at_ms, expires_at_ms) VALUES ('o2','probe','api','inc-9',?,'e2',?,?)").run(DIGEST_A, t0 + 5000, t0 + 9000);
    const res = w.brain.executeQuery(w.owner, { queryType: "incident.get", workspaceId: w.workspaceId, resourceId: "inc-9" }) as unknown as {
      snapshot: { observedAt: string; expiresAt: string; state: string; severity: string };
    };
    expect(res.snapshot.observedAt).toBe(new Date(t0 + 5000).toISOString());
    expect(res.snapshot.expiresAt).toBe(new Date(t0 + 9000).toISOString());
    expect(res.snapshot.state).toBe("investigating");
    w.brain.close();
  });
});

describe("remediation proposal lifecycle (T43)", () => {
  it("requires fresh observation, refuses unapproved and production-gated decisions", () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const now = w.brain.store.now();
    ws.prepare("INSERT INTO incidents(id, target_key, severity, title, state, version, opened_at_ms) VALUES ('inc-1','svc-api','high','API down','open',1,?)").run(now);
    // Stale observation only: refuse to propose.
    ws.prepare("INSERT INTO observations(id, connector_id, target_key, incident_id, observation_digest, source_event_id, observed_at_ms, expires_at_ms) VALUES ('obs-old','health','svc-api','inc-1',?,'e-old',?,?)").run(DIGEST_A, now - 7_200_000, now - 3_600_000);
    expect(() => w.brain.proposeRemediation({ actor: w.owner, workspaceId: w.workspaceId, incidentId: "inc-1", kind: "restart-service", detail: "restart api" })).toThrow(/fresh \(unexpired\) observation/);
    ws.prepare("INSERT INTO observations(id, connector_id, target_key, incident_id, observation_digest, source_event_id, observed_at_ms, expires_at_ms) VALUES ('obs-new','health','svc-api','inc-1',?,'e-new',?,?)").run(DIGEST_A, now - 60_000, now + 3_600_000);
    const { proposalId } = w.brain.proposeRemediation({ actor: w.owner, workspaceId: w.workspaceId, incidentId: "inc-1", kind: "restart-service", detail: "restart api" });
    expect(proposalId).toBeTruthy();
    // Decision requires a real approved approval.
    expect(() => w.brain.decideRemediation({ actor: w.owner, workspaceId: w.workspaceId, proposalId, approvalId: "apr-missing" })).toThrow(/requires an approved approval request/);
    const subject = {
      organizationId: w.org, workspaceId: w.workspaceId, operation: "remediation",
      tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
      target: { targetId: "svc-api", environmentId: "prod", preconditionDigest: DIGEST_A },
      artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
      effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: "sre-n1",
    };
    w.brain.store.control.prepare("INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms) VALUES ('apr-sre-1', ?, ?, 'owner-1', ?, ?, 'pending', ?, ?)")
      .run(w.org, w.workspaceId, approvalSubjectDigest(subject as unknown as JsonValue), JSON.stringify(subject), Date.now() + 3600000, Date.now());
    w.brain.store.control.prepare("UPDATE approval_requests SET state='approved' WHERE id='apr-sre-1'").run();
    w.brain.decideRemediation({ actor: w.owner, workspaceId: w.workspaceId, proposalId, approvalId: "apr-sre-1" });
    const decided = ws.prepare("SELECT state, approval_id FROM remediation_proposals WHERE id=?").get(proposalId) as Record<string, unknown>;
    expect(decided).toEqual({ state: "approved", approval_id: "apr-sre-1" });
    // Decided proposals cannot be re-decided; approval is terminal for the proposal.
    expect(() => w.brain.decideRemediation({ actor: w.owner, workspaceId: w.workspaceId, proposalId, approvalId: "apr-sre-1" })).toThrow(/already decided/);
    w.brain.close();
  }, 120_000);
});
