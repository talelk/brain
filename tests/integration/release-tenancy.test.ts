import { describe, expect, it } from "vitest";
import type { ActorContext } from "@brain/contracts";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { goldenDocs, seedOrganization, setupWorld } from "../helpers";

const REVISION = "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4";

// A release is content-addressed but owned per organization: two
// organizations staging identical documents each own, activate and read it.
describe("release tenancy", () => {
  it("lets a second organization stage, activate and run a release identical to another organization's", async () => {
    const w = setupWorld();
    const brain = w.brain;
    seedOrganization(brain, { organizationId: "org-other", ownerId: "owner-2" });
    const owner2 = (workspaceId?: string): ActorContext => ({
      kind: "human", actorId: "owner-2", organizationId: "org-other", ...(workspaceId ? { workspaceId } : {}),
      scopes: scopesForPrincipal(brain.store, "owner-2", "org-other", workspaceId), authMethod: "session", authGeneration: 1,
    });
    brain.createWorkspace(owner2(), { workspaceId: "ws-other", slug: "other" });
    const { digest } = brain.stageRelease(owner2("ws-other"), goldenDocs(), REVISION);
    expect(digest).toBe(brain.activeRelease(w.org)!.digest);
    brain.activateRelease(owner2("ws-other"), digest);
    expect(brain.activeRelease("org-other")?.digest).toBe(digest);
    expect(brain.activeRelease(w.org)?.digest).toBe(digest);
    const out = await brain.executeCommand(owner2("ws-other"), {
      contractVersion: "brain.command/v1", commandId: "cmd-other-dispatch", commandType: "workflow.dispatch", workspaceId: "ws-other", idempotencyKey: "other-dispatch",
      payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "other org" } },
    }, "other-dispatch");
    const runId = (out.receipt as { resourceId: string }).resourceId;
    const job = brain.store.control.prepare("SELECT organization_id, config_digest FROM jobs WHERE workflow_run_id=?").get(runId);
    expect(job).toEqual({ organization_id: "org-other", config_digest: digest });
    expect(brain.store.control.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
