import { afterEach, describe, expect, it } from "vitest";
import { domainDigest, type ActorContext, type CapabilityCandidate } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { activeTool, captureOperation, verifiedEvidence } from "../support/capitalization";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

describe("capitalization provenance scope (E110)", () => {
  it("denies cross-workspace queries and commands without membership", () => {
    world = setupWorld();
    const w = world;
    captureOperation(w, "root-scope");
    const outsider = { ...w.actor("mallory", w.workspaceId), scopes: ["tool:propose"] };
    for (const queryType of ["knowledgeAssets.list", "capabilityCandidates.list", "capitalizationRuns.list"]) {
      expect(() => w.brain.executeQuery(outsider, { queryType, workspaceId: w.workspaceId })).toThrow(/workspace not found/);
    }
    expect(() => w.brain.executeCommand(outsider, {
      contractVersion: "brain.command/v1", commandId: "cmd-outside-run", commandType: "capitalization.run",
      workspaceId: w.workspaceId, idempotencyKey: "outside-run", payload: {},
    }, "outside-run")).toThrow(/workspace not found/);
  });

  it("does not accept evidence captured in another workspace", () => {
    world = setupWorld();
    const w = world;
    const foreignEvidence = verifiedEvidence(w, "root-foreign-evidence");
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-capitalization-other", slug: "other" });
    const release = activeTool(w);
    const parameterShape = { message: "string" };
    const signature = domainDigest("brain:operation-signature:v1", { operationId: release.id, parameterShape, effectClass: "read" });
    expect(() => w.brain.recordToolObservation({
      organizationId: w.org, workspaceId: "ws-capitalization-other", signature, rootOperationId: "root-other",
      packageDigest: release.digest, evidenceDigest: foreignEvidence, operationId: release.id, parameterShape, effectClass: "read", verified: true,
    })).toThrow(/verified evidence bundle/);
    const other = w.brain.store.workspaceDb("ws-capitalization-other", w.org);
    expect((other.prepare("SELECT COUNT(*) AS count FROM operation_observations").get() as { count: number }).count).toBe(0);
    expect(() => w.brain.recordToolObservation({
      organizationId: "org-other", workspaceId: w.workspaceId, signature, rootOperationId: "root-cross-org",
      packageDigest: release.digest, evidenceDigest: foreignEvidence, operationId: release.id, parameterShape, effectClass: "read", verified: true,
    })).toThrow(/workspace not found/);
  });

  it("denies agent review and secret-shaped operation identities", () => {
    world = setupWorld();
    const w = world;
    for (const root of ["root-agent-1", "root-agent-2", "root-agent-3"]) captureOperation(w, root);
    w.brain.runCapitalization();
    const candidate = (w.brain.executeQuery(w.owner, { queryType: "capabilityCandidates.list", workspaceId: w.workspaceId }) as unknown as { snapshot: { items: CapabilityCandidate[] } }).snapshot.items[0]!;
    w.brain.ensurePrincipal(w.org, "agent-reviewer", "agent");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,'operator',1,'owner-1',?)")
      .run(w.workspaceId, w.org, "agent-reviewer", w.brain.store.now());
    const agent: ActorContext = { kind: "agent", actorId: "agent-reviewer", organizationId: w.org, workspaceId: w.workspaceId, scopes: ["tool:propose", "tool:publish"], authMethod: "machine-credential", authGeneration: 1 };
    expect(() => w.brain.executeCommand(agent, {
      contractVersion: "brain.command/v1", commandId: "cmd-agent-review", commandType: "capability.review",
      workspaceId: w.workspaceId, idempotencyKey: "agent-review", payload: { candidateId: candidate.candidateId, decision: "approve", reason: "Forged machine review" },
    }, "agent-review")).toThrow(/actor kind agent/);
    const release = activeTool(w);
    expect(() => w.brain.recordToolObservation({
      organizationId: w.org, workspaceId: w.workspaceId, signature: domainDigest("brain:secret-operation:v1", { root: "root-secret" }),
      rootOperationId: "root-secret", packageDigest: release.digest, evidenceDigest: verifiedEvidence(w, "root-secret-evidence"),
      operationId: "client_secret: exposed", parameterShape: {}, effectClass: "read", verified: true,
    })).toThrow(/contains a secret/);
  });
});
