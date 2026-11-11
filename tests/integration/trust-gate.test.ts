import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask, TrustRead, WorkItem } from "@brain/contracts";
import { setupWorld } from "../helpers";
import { ownBundleJob } from "../support/evidence";
import { fixtureStarter, modelOpinionStarter } from "../support/starter";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const db = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);

/** A task in review with a verified bundle and a stored verdict from the task validator, whose evaluator is deterministic or a model's opinion. */
async function reviewed(basis: "deterministic" | "model-opinion"): Promise<{ w: World; workItemId: string; digest: string }> {
  const w = setupWorld();
  worlds.push(w);
  const starter = basis === "model-opinion" ? modelOpinionStarter() : fixtureStarter();
  const release = w.brain.stageRelease(w.owner, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest;
  w.brain.activateRelease(w.owner, release);
  const evaluator = (JSON.parse(starter.documents.find((doc) => doc.path.endsWith("general-task.yaml"))!.text) as { spec: { jobs: { validate: { evaluator: { id: string; digest: string } } } } }).spec.jobs.validate.evaluator;
  const mission = (await run(w, w.owner, "mission.create", "m-create", { title: "Trust", intent: "Compare two options", successCriteria: ["delivered"] })).resourceId ?? "";
  const task: PlanTask = { id: "t", title: "Compare the options", criteria: ["structure", "safety"], dependsOn: [] };
  const plan = (await run(w, w.owner, "plan.propose", "m-plan", { missionId: mission, origin: "manual", tasks: [task] })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: mission })) as { snapshot: Mission }).snapshot.version;
  await run(w, w.owner, "plan.confirm", "m-confirm", { planVersionId: plan }, version);
  const item = db(w).prepare("SELECT id FROM work_items WHERE mission_id=?").get(mission) as { id: string };
  const digest = `sha256:${"e".repeat(64)}`;
  const checks = ["structure", "safety"].map((id) => ({ criterionId: id, checkId: id, status: "passed", oracleDigest: evaluator.digest, artifacts: [], detail: "ok" }));
  const manifest = { contractVersion: "brain.evidence/v1", bundleId: "bundle-trust", organizationId: w.org, workspaceId: w.workspaceId, workflowRunId: "run-seed", jobId: "job-trust", attemptId: "att-seed", jobFence: 1, sourceRevision: "r", configDigest: release, workflowDigest: release, primitiveVersions: {}, toolReleases: [], artifacts: [], checks, approvalIds: [], effects: [], createdAt: new Date().toISOString() };
  db(w).prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run(digest, "bundle-trust", "job-trust", "att-seed", JSON.stringify(manifest), w.brain.store.now());
  db(w).prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)")
    .run("verdict-trust", digest, "eval-seed", evaluator.digest, JSON.stringify({ contractVersion: "brain.verdict/v1", bundleDigest: digest, evaluatorRelease: evaluator, independence: "L1", outcome: "verified", checks, acceptedBy: "runner", createdAt: new Date().toISOString() }), w.brain.store.now());
  ownBundleJob(db(w), item.id, "job-trust", w.brain.store.now());
  db(w).prepare("UPDATE work_items SET state='review' WHERE id=?").run(item.id);
  return { w, workItemId: item.id, digest };
}

const done = async (w: World, actor: ActorContext, workItemId: string, digest: string, key: string): Promise<CommandReceipt> => {
  const current = ((await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: workItemId })) as { snapshot: WorkItem }).snapshot;
  return run(w, actor, "workItem.transition", key, { workItemId, state: "done", evidenceDigest: digest }, current.version);
};
const trustOf = async (w: World, digest: string): Promise<TrustRead | undefined> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "evidence.get", workspaceId: w.workspaceId, resourceId: digest })) as unknown as { snapshot: { trust?: TrustRead } }).snapshot.trust;

describe("Done and the trust line (#49)", () => {
  it("a deterministic evaluator's passed checks are checked by tests, files or hashes and need no sign-off", async () => {
    const { w, workItemId, digest } = await reviewed("deterministic");
    expect((await trustOf(w, digest))?.text).toBe("2 of 2 criteria checked by tests, files or hashes; 0 by human sign-off; 0 by model opinion.");
    const receipt = await done(w, { ...w.owner, kind: "agent" }, workItemId, digest, "d-agent");
    expect(receipt.accepted).toBe(true);
  });

  it("a criterion supported only by model opinion is Unverified: a non-person cannot make the task Done, a person's sign-off can and is recorded", async () => {
    const { w, workItemId, digest } = await reviewed("model-opinion");
    const before = await trustOf(w, digest);
    expect(before).toMatchObject({ deterministic: 0, human: 0, model: 2, unverified: ["structure", "safety"] });
    expect(before?.text).toContain("2 by model opinion");

    await expect(done(w, { ...w.owner, kind: "agent" }, workItemId, digest, "d-agent")).rejects.toThrow(/Unverified: structure, safety/);
    expect((db(w).prepare("SELECT state FROM work_items WHERE id=?").get(workItemId) as { state: string }).state).toBe("review");

    const signed = await done(w, w.owner, workItemId, digest, "d-human");
    expect(signed.accepted).toBe(true);
    expect((db(w).prepare("SELECT state FROM work_items WHERE id=?").get(workItemId) as { state: string }).state).toBe("done");
    const after = await trustOf(w, digest);
    expect(after).toMatchObject({ deterministic: 0, human: 2, model: 0, unverified: [], signedOffBy: w.owner.actorId });
    expect(after?.text).toBe("0 of 2 criteria checked by tests, files or hashes; 2 by human sign-off; 0 by model opinion.");
  });
});
