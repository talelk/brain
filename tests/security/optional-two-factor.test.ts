import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { approvalSubjectDigest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { approvalCurrentlyUsable } from "../../apps/governor/src/modules/governance/approval-authority";
import { readRuntimeConfig } from "../../apps/governor/src/runtime-config";
import { setupWorld, seedHuman, DIGEST_A } from "../helpers";

describe("optional and required two-factor approval policy", () => {
  it("issues one-use session evidence for one exact approval, and required policy refuses it after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-optional-factor-"));
    let app = await createApp({ dataDir: root, runtime: readRuntimeConfig({ BRAIN_MEMORY_UI_URL: "https://memory.example.test/" }) });
    try {
      const w = setupWorld(app.brain);
      const session = seedHuman(w.brain, w.org, "optional-reviewer");
      w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,'approver',1,?,?)").run(w.workspaceId,w.org,"optional-reviewer",w.owner.actorId,Date.now());
      const headers = new Headers({ authorization: `Bearer ${session.token}` });
      const identity = await w.brain.resolveActor(headers, w.workspaceId);
      const view = await (await app.fetch(new Request("http://127.0.0.1:3000/v1/identity",{headers}))).json() as {integrations:{memoryUiUrl:string}};
      expect(view.integrations.memoryUiUrl).toBe("https://memory.example.test/");
      expect(view.integrations).not.toHaveProperty("betterAuthAdminUiUrl");
      const subject = { organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish", tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
        target: { targetId: "target-optional", environmentId: "prod", preconditionDigest: DIGEST_A }, artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
        effectBounds: {}, expiresAt: new Date(Date.now()+3600000).toISOString(), nonce: "optional" };
      const subjectDigest = approvalSubjectDigest(subject);
      const request = (id: string) => w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandType: "approval.request", commandId: id, idempotencyKey: id, workspaceId: w.workspaceId, payload: { subject } }, id).receipt.resourceId!;
      const first = request("optional-1");
      const second = w.brain.createApprovalForGate({ organizationId: w.org, workspaceId: w.workspaceId, runId: "test-run", stepId: "test-gate", subject, expiresAtMs: Date.now()+3600000, requestedBy: w.owner.actorId });
      const challenge = w.brain.stepUp.createChallenge(identity, first, subjectDigest);
      const { evidenceId } = await w.brain.stepUp.verify(identity, challenge.challengeId, "", headers);
      const decision = { contractVersion: "brain.approval-decision/v1" as const, idempotencyKey: "optional-decision", decision: "approve" as const, subjectDigest, expectedVersion: 1, note: "reviewed", stepUpEvidenceId: evidenceId };
      expect(() => w.brain.decideApproval(identity, second, decision)).toThrow(/step-up evidence/);
      expect(w.brain.decideApproval(identity, first, decision).state).toBe("approved");
      await expect(w.brain.stepUp.verify(identity, challenge.challengeId, "", headers)).rejects.toThrow(/already verified/);
      const bound = { approvalId: first, organizationId: w.org, workspaceId: w.workspaceId, subjectDigest };
      expect(approvalCurrentlyUsable(w.brain.store,w.brain.auth,bound)).toBe(true);
      await app.close();
      app = await createApp({ dataDir: root, runtime: readRuntimeConfig({ BRAIN_AUTH_REQUIRE_2FA: "true" }) });
      expect(approvalCurrentlyUsable(app.brain.store,app.brain.auth,bound)).toBe(false);
      const nextIdentity = await app.brain.resolveActor(headers, w.workspaceId);
      expect(() => app.brain.stepUp.createChallenge(nextIdentity,second,subjectDigest)).toThrow(/TOTP/);
    } finally { await app.close(); rmSync(root,{recursive:true,force:true}); }
  });

  it("validates identity policy and credential-free external links", () => {
    expect(readRuntimeConfig({}).requireTwoFactor).toBe(false);
    expect(() => readRuntimeConfig({ BRAIN_AUTH_REQUIRE_2FA: "yes" })).toThrow();
    expect(() => readRuntimeConfig({ BRAIN_MEMORY_UI_URL: "javascript:alert(1)" })).toThrow();
    expect(readRuntimeConfig({ BRAIN_MEMORY_UI_URL: "https://memory.example.test/" }).memoryUiUrl).toBe("https://memory.example.test/");
  });
});
