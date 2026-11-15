import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, AttentionItem, CommandReceipt, EvidenceBundle, Mission, PlanTask, VerificationVerdict } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { notifyAttention, type Sender } from "../../apps/governor/src/modules/operations/index";
import { goldenDocs, seedHuman, setupWorld, workView, type TestWorld } from "../helpers";
import { attestDomain, bundleForAttempt } from "../support/evidence";

// Spec #90, ticket #157: an eval step of independence L3 waits for a person, who attests as its evaluator.
// State is reached through commands and the runner/evidence protocol; the only direct writes arrange who holds which role.
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const CHECKS = ["echo-message", "echo-bytes"];

/** The golden fixture with its eval step raised to independence L3 and, optionally, a declared set of attesters. */
function l3Docs(attesters = ""): Array<{ path: string; text: string }> {
  return goldenDocs().map((doc) => doc.path.endsWith("fixture-workflow.yaml") ? { ...doc, text: doc.text.replace("      independence: L2", `      independence: L3${attesters}`) } : doc);
}

async function world(options: { attesters?: string } = {}) {
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-l3-")), allowTestActor: true });
  const w = setupWorld(app.brain);
  const owned = w.owner;
  const stage = w.brain.stageRelease(owned, l3Docs(options.attesters), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  w.brain.activateRelease(owned, stage.digest);
  const transport: typeof fetch = async (input, init) => app!.fetch(new Request(input, init));
  const config = (runnerId: string): RunnerConfig => ({ runnerId, governorUrl: "http://127.0.0.1:3000", stateDir: join(w.dir, runnerId), transport,
    capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "trust:domain:self-asserted"] });
  const authorConfig = config("author-runner");
  const session = await enrollAndHello(authorConfig, w.brain.jobProtocol.issueEnrollment(w.owner, "fixture-tools").token);
  const author = { runnerId: authorConfig.runnerId, epoch: session.epoch, organizationId: w.org };
  return { ...w, author, digest: stage.digest };
}
type World = Awaited<ReturnType<typeof world>>;

/** A person who may do mission work in the workspace. */
function person(w: TestWorld, id: string, role: "operator" | "workspace-lead" | "viewer" = "operator"): ActorContext {
  seedHuman(w.brain, w.org, id);
  w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, ?, ?, 1, 'owner-1', ?)").run(w.workspaceId, w.org, id, role, w.brain.store.now());
  return w.actor(id, w.workspaceId);
}

const run = async (w: TestWorld, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> =>
  (await w.brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
const query = async <T>(w: TestWorld, actor: ActorContext, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(actor, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const fails = async (fn: () => Promise<unknown>, pattern: RegExp) => await expect(Promise.resolve().then(fn)).rejects.toThrow(pattern);

type Attestation = { attestationId: string; state: string; independence: string; canAttest: boolean; cannotAttestReason?: string; bundleDigests: string[]; requiredChecks: Array<{ checkId: string; criterionId: string }>; verdict?: { outcome: string; attestedBy: string; independence: string }; missionId?: string };
const items = async (w: TestWorld): Promise<AttentionItem[]> => (await query<{ items: AttentionItem[] }>(w, w.owner, "attention.list")).items.filter((item) => item.kind === "attestation");

/** Dispatches the fixture workflow, lets its author finish and submits the author's evidence: the eval step is now admitted. */
async function submitted(w: World, by: ActorContext = w.owner, workItemId?: string): Promise<{ runId: string; bundle: EvidenceBundle; digest: string }> {
  const key = `dispatch-${workItemId ?? "plain"}`;
  await run(w, by, "workflow.dispatch", key, { workflow: { id: "fixture-workflow", digest: w.digest }, input: { message: "Brain fixture" }, ...(workItemId ? { workItemId } : {}) });
  const offer = w.brain.jobProtocol.claim(w.author, `author-claim-${key}`) as unknown as { attemptId: string; leaseId: string; jobFence: number };
  w.brain.jobProtocol.ack(w.author, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  w.brain.jobProtocol.complete(w.author, offer.attemptId, { result: "succeeded", output: { message: "Brain fixture", bytes: 13 }, jobFence: offer.jobFence, cleanupConfirmed: true });
  const bundle = bundleForAttempt(w.brain, w.org, w.workspaceId, offer.attemptId, `bundle-${key}`);
  const { digest } = w.brain.submitEvidence(w.author, bundle) as { digest: string };
  return { runId: bundle.workflowRunId, bundle, digest };
}

const passAll = CHECKS.map((checkId) => ({ checkId, status: "passed", detail: "Read the output and compared it with the brief" }));
const attest = (w: World, actor: ActorContext, key: string, attestationId: string, digests: string[], outcome: string, checks: Array<{ checkId: string; status: string; detail: string }> = passAll) =>
  run(w, actor, "evaluation.attest", key, { attestationId, bundleDigests: digests, outcome, checks });
const wsDb = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const runState = (w: World, runId: string) => (wsDb(w).prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state;

describe("an L3 evaluator is a person (#157)", () => {
  it("an eval step of independence L3 suspends its run and raises one blocking item that links to the attestation, with no evaluator job", async () => {
    const w = await world();
    const { runId, digest } = await submitted(w);
    expect(runState(w, runId)).toBe("suspended");
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
    expect(wsDb(w).prepare("SELECT state FROM workflow_steps WHERE run_id=? AND step_id='verify'").get(runId)).toEqual({ state: "waiting" });

    const [item] = await items(w);
    expect(item).toMatchObject({ kind: "attestation", tier: 3, title: "Attest the evidence for fixture-workflow" });
    const reviewer = person(w, "reviewer-1");
    const request = await query<Attestation>(w, reviewer, "attestations.get", item!.resourceId);
    expect(request).toMatchObject({ state: "open", independence: "L3", canAttest: true, bundleDigests: [digest], requiredChecks: CHECKS.map((checkId) => ({ checkId, criterionId: checkId })) });
    // A runner can never claim the evaluation: an eval at L3 is not runner work.
    const evaluator = { runnerId: "evaluator-runner", epoch: 1, organizationId: w.org };
    expect(() => w.brain.jobProtocol.claim(evaluator, "no-claim")).toThrow();
  });

  it("the person who started the work is refused, however the command arrives, and nothing changes", async () => {
    const w = await world();
    const { runId, digest } = await submitted(w);
    const [item] = await items(w);
    const own = await query<Attestation>(w, w.owner, "attestations.get", item!.resourceId);
    expect(own).toMatchObject({ canAttest: false, cannotAttestReason: expect.stringMatching(/started or own this work/) });
    await fails(() => attest(w, w.owner, "author-attests", item!.resourceId, [digest], "verified"), /cannot be its independent evaluator/);
    for (const kind of ["agent", "workflow", "service"] as const) await fails(() => attest(w, { ...w.owner, kind }, `kind-${kind}`, item!.resourceId, [digest], "verified"), /cannot run/);
    expect(wsDb(w).prepare("SELECT COUNT(*) AS n FROM verification_verdicts").get()).toEqual({ n: 0 });
    expect(runState(w, runId)).toBe("suspended");
    expect(await items(w)).toHaveLength(1);
  });

  it("the owner of the mission the work serves is refused even when someone else started the run, and a viewer is refused too", async () => {
    const w = await world();
    const id = (await run(w, w.owner, "mission.create", "m-create", { title: "Graded mission", intent: "Deliver it", successCriteria: ["delivered"] })).resourceId ?? "";
    const task: PlanTask = { id: "only", title: "Graded task", criteria: ["only-done"], dependsOn: [] };
    const planId = (await run(w, w.owner, "plan.propose", "m-plan", { missionId: id, origin: "manual", tasks: [task] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "m-confirm", { planVersionId: planId }, (await query<Mission>(w, w.owner, "missions.get", id)).version);
    const item0 = ((await workView(w)).items as Array<{ missionId: string; workItemId: string }>).find((entry) => entry.missionId === id)!;
    const starter = person(w, "starter-1");
    const reviewer = person(w, "reviewer-2");
    const viewer = person(w, "viewer-1", "viewer");
    const { digest } = await submitted(w, starter, item0.workItemId);
    const [open] = await items(w);
    expect(open).toMatchObject({ missionId: id, title: "Attest the evidence for Graded task" });
    // The mission's owner did not start the run, and still may not judge the work done for their mission.
    await fails(() => attest(w, w.owner, "owner-attests", open!.resourceId, [digest], "verified"), /cannot be its independent evaluator/);
    await fails(() => attest(w, starter, "starter-attests", open!.resourceId, [digest], "verified"), /cannot be its independent evaluator/);
    await fails(() => attest(w, viewer, "viewer-attests", open!.resourceId, [digest], "verified"), /./);
    await attest(w, reviewer, "reviewer-attests", open!.resourceId, [digest], "verified");
    expect(await query<Attestation>(w, reviewer, "attestations.get", open!.resourceId)).toMatchObject({ state: "attested", missionId: id });
  });

  it("a verified attestation is recorded as the evaluator at L3, binds the bundle and completes the step and the run", async () => {
    const w = await world();
    const { runId, digest, bundle } = await submitted(w);
    const [item] = await items(w);
    const reviewer = person(w, "reviewer-1");
    const receipt = await attest(w, reviewer, "verify-it", item!.resourceId, [digest], "verified");
    expect(receipt).toMatchObject({ accepted: true, resourceId: item!.resourceId });

    const verdictRow = wsDb(w).prepare("SELECT outcome, manifest_json, finalized_at_ms FROM verification_verdicts WHERE bundle_digest=?").get(digest) as { outcome: string; manifest_json: string; finalized_at_ms: number | null };
    const verdict = JSON.parse(verdictRow.manifest_json) as VerificationVerdict;
    expect(verdictRow).toMatchObject({ outcome: "verified" });
    expect(verdictRow.finalized_at_ms).not.toBeNull();
    expect(verdict).toMatchObject({ independence: "L3", acceptedBy: "reviewer-1", bundleDigest: digest, evaluatorAttemptId: item!.resourceId, outcome: "verified" });
    expect(verdict.checks.map((check) => [check.checkId, check.status, check.oracleDigest])).toEqual(CHECKS.map((checkId) => [checkId, "passed", verdict.evaluatorRelease.digest]));
    expect(wsDb(w).prepare("SELECT state FROM evidence_bundles WHERE digest=?").get(digest)).toEqual({ state: "verified" });
    expect(runState(w, runId)).toBe("succeeded");
    expect(w.brain.store.control.prepare("SELECT state FROM jobs WHERE id=?").get(bundle.jobId)).toEqual({ state: "succeeded" });
    expect(await items(w)).toEqual([]);
    const evidence = await query<{ verdict?: VerificationVerdict }>(w, reviewer, "evidence.get", digest);
    expect(evidence.verdict).toMatchObject({ independence: "L3", acceptedBy: "reviewer-1" });
    expect(await query<Attestation>(w, reviewer, "attestations.get", item!.resourceId)).toMatchObject({ state: "attested", verdict: { outcome: "verified", attestedBy: "reviewer-1", independence: "L3" } });
    // The same attestation sent again finishes nothing twice; a different one is refused.
    expect(await attest(w, reviewer, "verify-it-again", item!.resourceId, [digest], "verified")).toMatchObject({ accepted: true });
    await fails(() => attest(w, reviewer, "change-mind", item!.resourceId, [digest], "rejected", passAll.map((check) => ({ ...check, status: "failed" }))), /already has an immutable verdict/);
  });

  it("a rejection fails the author's step and the run, and sends the work back", async () => {
    const w = await world();
    const { runId, digest, bundle } = await submitted(w);
    const [item] = await items(w);
    const reviewer = person(w, "reviewer-1");
    const checks = [{ checkId: "echo-message", status: "failed", detail: "The message is not the one in the brief" }, { checkId: "echo-bytes", status: "passed", detail: "Length matches" }];
    await attest(w, reviewer, "reject-it", item!.resourceId, [digest], "rejected", checks);
    expect(wsDb(w).prepare("SELECT state FROM evidence_bundles WHERE digest=?").get(digest)).toEqual({ state: "rejected" });
    expect(runState(w, runId)).toBe("failed");
    expect(w.brain.store.control.prepare("SELECT state FROM jobs WHERE id=?").get(bundle.jobId)).toEqual({ state: "failed" });
    expect(wsDb(w).prepare("SELECT state FROM workflow_steps WHERE run_id=? ORDER BY step_id").all(runId)).toEqual([{ state: "failed" }, { state: "failed" }]);
    expect(await items(w)).toEqual([]);
    expect(await query<Attestation>(w, reviewer, "attestations.get", item!.resourceId)).toMatchObject({ state: "attested", verdict: { outcome: "rejected" } });
  });

  it("an incomplete attestation counts as not verified: the run ends and the work is sent back", async () => {
    const w = await world();
    const { runId, digest } = await submitted(w);
    const [item] = await items(w);
    await attest(w, person(w, "reviewer-1"), "incomplete-it", item!.resourceId, [digest], "incomplete", [{ checkId: "echo-message", status: "missing", detail: "No output attached" }, { checkId: "echo-bytes", status: "passed", detail: "ok" }]);
    expect(wsDb(w).prepare("SELECT state FROM evidence_bundles WHERE digest=?").get(digest)).toEqual({ state: "incomplete" });
    expect(runState(w, runId)).toBe("failed");
  });

  it("the verdict's contradiction rules apply to a person: verified needs every check passed, and every pinned check once", async () => {
    const w = await world();
    const { runId, digest } = await submitted(w);
    const [item] = await items(w);
    const reviewer = person(w, "reviewer-1");
    const failedOne = passAll.map((check, index) => (index === 0 ? { ...check, status: "failed" } : check));
    await fails(() => attest(w, reviewer, "contradiction-1", item!.resourceId, [digest], "verified", failedOne), /contradicts its checks/);
    await fails(() => attest(w, reviewer, "contradiction-2", item!.resourceId, [digest], "rejected"), /contradicts its checks/);
    await fails(() => attest(w, reviewer, "contradiction-3", item!.resourceId, [digest], "incomplete"), /contradicts its checks/);
    await fails(() => attest(w, reviewer, "missing-check", item!.resourceId, [digest], "verified", passAll.slice(0, 1)), /every pinned check exactly once/);
    await fails(() => attest(w, reviewer, "unknown-check", item!.resourceId, [digest], "verified", [passAll[0]!, { checkId: "invented", status: "passed", detail: "x" }]), /every pinned check exactly once/);
    await fails(() => attest(w, reviewer, "wrong-evidence", item!.resourceId, [`sha256:${"e".repeat(64)}`], "verified"), /evidence changed/);
    expect(wsDb(w).prepare("SELECT COUNT(*) AS n FROM verification_verdicts").get()).toEqual({ n: 0 });
    expect(runState(w, runId)).toBe("suspended");
  });

  it("a step may name who attests: people or a role; others are refused, and the push goes to the ones who may answer", async () => {
    const w = await world({ attesters: "\n      attesters:\n        people:\n        - named-1" });
    const { digest } = await submitted(w);
    const [item] = await items(w);
    const named = person(w, "named-1");
    const other = person(w, "other-1");
    await fails(() => attest(w, other, "other-attests", item!.resourceId, [digest], "verified"), /names who may attest/);
    expect(await query<Attestation>(w, other, "attestations.get", item!.resourceId)).toMatchObject({ canAttest: false });
    const sent: Array<{ principal: string; url: string; kind: string }> = [];
    const send: Sender = async (_org, principal, message) => { sent.push({ principal, url: message.url, kind: message.kind }); return 1; };
    expect(notifyAttention(w.brain.store, send)).toBe(1);
    expect(notifyAttention(w.brain.store, send)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([{ principal: "named-1", url: `/attestations/${item!.resourceId}?w=${w.workspaceId}`, kind: "attestation" }]);
    await attest(w, named, "named-attests", item!.resourceId, [digest], "verified");
  });

  it("a cancelled run leaves no open request, and nothing can be attested after it", async () => {
    const w = await world();
    const { runId, digest } = await submitted(w);
    const [item] = await items(w);
    await run(w, w.owner, "workflow.cancel", "cancel-it", { runId, reason: "Stop evaluation" });
    expect(await items(w)).toEqual([]);
    expect(await query<Attestation>(w, person(w, "reviewer-1"), "attestations.get", item!.resourceId)).toMatchObject({ state: "closed", canAttest: false });
    await fails(() => attest(w, person(w, "reviewer-2"), "late-attest", item!.resourceId, [digest], "verified"), /terminal workflow/);
  });

  it("the trust read counts what a person attested as human, never as a tool's check", async () => {
    const w = await world();
    attestDomain(w.brain, w.author.runnerId, "author-host");
    const { digest } = await submitted(w);
    const [item] = await items(w);
    await attest(w, person(w, "reviewer-1"), "trust-it", item!.resourceId, [digest], "verified");
    const trust = await query<{ trust?: { human: number; deterministic: number; signedOffBy?: string } }>(w, w.owner, "evidence.get", digest);
    expect(trust.trust).toMatchObject({ human: 2, deterministic: 0, signedOffBy: "reviewer-1" });
  });
});
