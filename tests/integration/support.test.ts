import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { computeSlaMinutes } from "../../apps/governor/src/modules/packs/sla";
import { approvalSubjectDigest, type JsonValue } from "@brain/contracts";
import { setupWorld, DIGEST_A } from "../helpers";

// T42 packet acceptance (local slice): deterministic SLA accounting from
// immutable responsibility intervals, and ticket evidence readiness that
// only counts *approved* drafts — unapproved drafts never mark a ticket
// ready to publish.
describe("support SLA and draft gates (T42)", () => {
  it("sla minutes sum reopened intervals per responsibility; others pause the clock", () => {
    const t0 = Date.UTC(2026, 0, 1, 0, 0);
    const intervals = [
      { responsibility: "keyrus", startedAtMs: t0, endedAtMs: t0 + 30 * 60_000 },
      { responsibility: "client", startedAtMs: t0 + 30 * 60_000, endedAtMs: t0 + 90 * 60_000 },
      { responsibility: "keyrus", startedAtMs: t0 + 90 * 60_000, endedAtMs: null },
    ];
    expect(computeSlaMinutes(intervals, "keyrus", t0 + 120 * 60_000)).toBe(60);
    expect(computeSlaMinutes(intervals, "client", t0 + 120 * 60_000)).toBe(60);
    expect(computeSlaMinutes(intervals, "hub", t0 + 120 * 60_000)).toBe(0);
    expect(computeSlaMinutes([], "keyrus", t0)).toBe(0);
  });

  it("evidenceReady requires an approved draft; sla.summary aggregates stored intervals", () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const now = w.brain.store.now();
    ws.prepare("INSERT INTO tickets(id, connector_id, remote_id, state, title, body_digest, source_version, observed_at_ms, created_at_ms) VALUES ('tkt-s','gitlab','9','open','Cannot login',?,'v1',?,?)").run(DIGEST_A, now, now);
    ws.prepare("INSERT INTO support_drafts(id, ticket_id, version, content_digest, source_fingerprint, evidence_digest, author_principal_id, approval_id, created_at_ms) VALUES ('dr-1','tkt-s',1,?,?,?,'owner-1',NULL,?)").run(DIGEST_A, DIGEST_A, DIGEST_A, now);
    const ticketList = () => (w.brain.executeQuery(w.owner, { queryType: "tickets.list", workspaceId: w.workspaceId }) as unknown as { snapshot: { items: Array<{ id: string; evidenceReady: boolean }> } }).snapshot.items;
    expect(ticketList().find((t) => t.id === "tkt-s")?.evidenceReady).toBe(false);
    ws.prepare("UPDATE support_drafts SET approval_id='apr-1' WHERE id='dr-1'").run();
    expect(ticketList().find((t) => t.id === "tkt-s")?.evidenceReady).toBe(true);

    ws.prepare("INSERT INTO sla_intervals(id, ticket_id, event_id, responsibility, started_at_ms, ended_at_ms, calendar_digest) VALUES ('si-1','tkt-s','ev-1','keyrus',?,?,?)").run(now - 3600_000, now - 1800_000, DIGEST_A);
    ws.prepare("INSERT INTO sla_intervals(id, ticket_id, event_id, responsibility, started_at_ms, ended_at_ms, calendar_digest) VALUES ('si-2','tkt-s','ev-2','client',?,?,?)").run(now - 1800_000, now - 600_000, DIGEST_A);
    const sla = (w.brain.executeQuery(w.owner, {
      queryType: "sla.summary", workspaceId: w.workspaceId,
      periodStart: new Date(now - 7200_000).toISOString(), periodEnd: new Date(now + 60_000).toISOString(),
    }) as unknown as { snapshot: { keyrusMs: number; clientWaitMs: number; sampleCount: number; calendarDigest: string } }).snapshot;
    expect(sla.keyrusMs).toBe(1800_000);
    expect(sla.clientWaitMs).toBe(1200_000);
    expect(sla.sampleCount).toBe(2);
    expect(sla.calendarDigest).toBe(DIGEST_A);
    w.brain.close();
  });
});

describe("support draft lifecycle (T42)", () => {
  it("dedupes by fingerprint, gates on approval, publishes exact CAS text once", async () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const now = w.brain.store.now();
    ws.prepare("INSERT INTO tickets(id, connector_id, remote_id, state, title, body_digest, source_version, observed_at_ms, created_at_ms) VALUES ('tkt-gl-3','gitlab','3','open','Cannot login',?,'v1',?,?)").run(DIGEST_A, now, now);
    const upload = (text: string) => {
      const bytes = Buffer.from(text, "utf8");
      const digest = sha256Digest(bytes);
      const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
      return w.brain.putUpload(w.owner, up.uploadId, bytes) as unknown as { digest: string };
    };
    const content = upload("We traced this to the SSO callback. A fix is deployed; please retry.");
    const evidence = upload("evidence: callback log excerpt");
    const first = w.brain.createSupportDraft({ actor: w.owner, workspaceId: w.workspaceId, ticketId: "tkt-gl-3", contentDigest: content.digest, sourceFingerprint: "diag-sso-callback", evidenceDigest: evidence.digest });
    const dupe = w.brain.createSupportDraft({ actor: w.owner, workspaceId: w.workspaceId, ticketId: "tkt-gl-3", contentDigest: content.digest, sourceFingerprint: "diag-sso-callback", evidenceDigest: evidence.digest });
    expect(first.created).toBe(true);
    expect(dupe).toEqual({ draftId: first.draftId, created: false });

    // Local GitLab mock that records note writes.
    const notes: Array<{ body: string }> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c as Buffer)));
      req.on("end", () => {
        if (req.method === "GET" && req.url?.includes("/notes")) { res.end(JSON.stringify(notes)); return; }
        if (req.method === "POST" && req.url === "/api/v4/projects/7/issues/3/notes") {
          notes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { body: string });
          res.statusCode = 201; res.end("{}"); return;
        }
        res.statusCode = 404; res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(w.brain.publishSupportDraft({ actor: w.owner, workspaceId: w.workspaceId, draftId: first.draftId, baseUrl: base, projectId: 7, token: "t" })).rejects.toThrow(/unapproved/);
      // Approval must be a real approved request.
      const subject = {
        organizationId: w.org, workspaceId: w.workspaceId, operation: "support.publish",
        tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
        target: { targetId: "tkt-gl-3", environmentId: "prod", preconditionDigest: DIGEST_A },
        artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
        effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: "sup-n1",
      };
      w.brain.store.control.prepare("INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms) VALUES ('apr-sup-1', ?, ?, 'owner-1', ?, ?, 'approved', ?, ?)")
        .run(w.org, w.workspaceId, approvalSubjectDigest(subject as unknown as JsonValue), JSON.stringify(subject), Date.now() + 3600000, Date.now());
      w.brain.approveSupportDraft({ actor: w.owner, workspaceId: w.workspaceId, draftId: first.draftId, approvalId: "apr-sup-1" });
      expect(() => w.brain.approveSupportDraft({ actor: w.owner, workspaceId: w.workspaceId, draftId: first.draftId, approvalId: "apr-sup-1" })).toThrow(/already approved/);

      const published = await w.brain.publishSupportDraft({ actor: w.owner, workspaceId: w.workspaceId, draftId: first.draftId, baseUrl: base, projectId: 7, token: "t" });
      expect(published.outcome).toBe("applied");
      expect(notes.map((n) => n.body)).toEqual(["We traced this to the SSO callback. A fix is deployed; please retry."]);
      const again = await w.brain.publishSupportDraft({ actor: w.owner, workspaceId: w.workspaceId, draftId: first.draftId, baseUrl: base, projectId: 7, token: "t" });
      expect(again.outcome).toBe("already-applied");
      expect(notes).toHaveLength(1);
    } finally {
      await new Promise((r) => server.close(r));
      w.brain.close();
    }
  }, 120_000);
});
