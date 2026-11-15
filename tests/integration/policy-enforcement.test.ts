import { afterEach, describe, expect, it } from "vitest";
import { dispatchFixture, jobRow, runStateOf, seedRunner, startAttempt, stepStatesOf, attemptsOf, type World } from "../support/step-policy";
import { compileRelease } from "../../apps/governor/src/modules/configuration/compiler";
import { inspected, policyDocs as policyWorldDocs, policyWorld, type PolicyWorldOptions } from "../support/policy-world";

// The policy a release carries is stored with it and enforced while work runs (#147, ADR 0067), at the Governor boundary: releases are
// staged and activated as an organization would, work is dispatched by command, a runner claims through the runner protocol, and time
// moves only when the test moves the Governor's clock.
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });
const start = (options: PolicyWorldOptions = {}) => { const world = policyWorld(options); worlds.push(world.w); return world; };
const jobOf = (w: World, runId: string) => (w.brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=?").get(runId) as { id: string }).id;
const snapshotOf = async (w: World, jobId: string) => ((await w.brain.executeQuery(w.owner, { queryType: "job.get", workspaceId: w.workspaceId, resourceId: jobId })) as unknown as { snapshot: { state: string; policyRefusal?: { layer: string; field: string; message: string }; runOutputs: Record<string, { error?: string; code?: string; policy?: { layer: string; field: string } }>; placement: { isolation: string } } }).snapshot;

describe("the merged policy floor is stored with the release", () => {
  it("keeps the floor of a single policy as the release's effective policy, with the layer behind each value", () => {
    const { w, digest } = start();
    const stored = inspected(w, digest).manifest.effectivePolicy!;
    expect(stored.layers).toEqual(["config/fixture-policy.yaml"]);
    expect(stored.effective).toMatchObject({ allowedOperations: ["fixture.echo", "fixture.verify"], deniedOperations: [], maxRuntimeSeconds: 120, minimumIsolation: "ephemeral-container", separationOfDuties: true, productionHumanApproval: "required" });
    expect(stored.provenance).toMatchObject({ allowedOperations: "config/fixture-policy.yaml", maxRuntimeSeconds: "config/fixture-policy.yaml", minimumIsolation: "config/fixture-policy.yaml" });
  });

  it("merges later layers restrictively and names the layer that decided each field", () => {
    const { w, digest } = start({ layers: [{ id: "workspace-limits", spec: { maxRuntimeSeconds: 20, deniedOperations: ["shell.exec"], minimumIsolation: "dedicated-vm" } }] });
    const stored = inspected(w, digest).manifest.effectivePolicy!;
    expect(stored.layers).toEqual(["config/fixture-policy.yaml", "config/workspace-limits.yaml"]);
    expect(stored.effective).toMatchObject({ maxRuntimeSeconds: 20, deniedOperations: ["shell.exec"], minimumIsolation: "dedicated-vm" });
    expect(stored.provenance).toMatchObject({ maxRuntimeSeconds: "config/workspace-limits.yaml", minimumIsolation: "config/workspace-limits.yaml", deniedOperations: "config/workspace-limits.yaml" });
  });

  it("pins the policy with the release: the same documents with another cap are another release", () => {
    const a = start().digest;
    const b = start({ floor: (spec) => { spec["maxRuntimeSeconds"] = 60; } }).digest;
    expect(b).not.toBe(a);
  });

  it("still rejects a release whose layer broadens the floor", () => {
    const { w } = start();
    for (const spec of [{ productionHumanApproval: "optional" }, { defaultEffect: "allow" }]) {
      expect(() => w.brain.stageRelease(w.owner, policyWorldDocs({ layers: [{ id: "broaden", spec }] }), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4")).toThrow(/broaden|turn off/);
    }
  });
});

describe("work the policy refuses is refused at admission, naming the layer", () => {
  it("refuses a step whose operation a layer denies: the run fails, the job is recorded failed, no runner can take it", async () => {
    const { w } = start({ layers: [{ id: "no-echo", spec: { deniedOperations: ["fixture.echo"] } }] });
    const runner = seedRunner(w, "runner-policy");
    const runId = await dispatchFixture(w, "denied");
    const jobId = jobOf(w, runId);
    expect(jobRow(w, jobId).state).toBe("failed");
    expect(startAttempt(w, runner, "req-1")).toBeNull();
    expect(attemptsOf(w.brain, jobId)).toEqual([]);
    expect(stepStatesOf(w.brain, w, runId)).toEqual({ echo: "failed" });
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
    const snapshot = await snapshotOf(w, jobId);
    expect(snapshot.policyRefusal).toMatchObject({ layer: "config/no-echo.yaml", field: "deniedOperations" });
    expect(snapshot.policyRefusal!.message).toMatch(/fixture\.echo/);
    expect(snapshot.runOutputs["echo"]).toMatchObject({ code: "POLICY_REFUSED", policy: { layer: "config/no-echo.yaml", field: "deniedOperations" } });
  });

  it("refuses an operation a non-empty allow-list leaves out, naming the first layer whose list excludes it", async () => {
    const { w } = start({ layers: [{ id: "verify-only", spec: { allowedOperations: ["fixture.verify"] } }] });
    const runId = await dispatchFixture(w, "not-allowed");
    const snapshot = await snapshotOf(w, jobOf(w, runId));
    expect(snapshot.state).toBe("failed");
    expect(snapshot.policyRefusal).toMatchObject({ layer: "config/verify-only.yaml", field: "allowedOperations" });
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
  });

  it("takes an operation both the allow-list and the deny-list leave alone, and an empty allow-list states no allow-list", async () => {
    const { w } = start({ floor: (spec) => { spec["allowedOperations"] = []; }, layers: [{ id: "other-denied", spec: { deniedOperations: ["shell.exec"] } }] });
    const runner = seedRunner(w, "runner-policy");
    await dispatchFixture(w, "allowed");
    const offer = startAttempt(w, runner, "req-1");
    expect(offer).not.toBeNull();
    const stored = inspected(w, w.brain.activeRelease(w.org)!.digest).manifest.effectivePolicy!;
    expect(stored.effective["allowedOperations"]).toBeNull();
  });

  it("a release without a Policy document has no effective policy, and nothing is invented for it", () => {
    const compiled = compileRelease([{ path: "config/pack.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Pack\nmetadata: {id: pack}\nspec: {}\n" }], "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
    expect((compiled.manifest as { effectivePolicy: unknown }).effectivePolicy).toBeNull();
  });
});

describe("a policy's maximum runtime only ever cuts an attempt's time down", () => {
  it("cuts a step's longer timeout down to the cap, and says which layer set it", async () => {
    const { w, time } = start({ timeoutSeconds: 30, layers: [{ id: "short", spec: { maxRuntimeSeconds: 10 } }] });
    const runner = seedRunner(w, "runner-policy");
    const runId = await dispatchFixture(w, "cap-cuts");
    const attempt = startAttempt(w, runner, "req-1")!;
    time.advance(9_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    time.advance(1_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(1);
    expect(attemptsOf(w.brain, attempt.jobId)[0]!.reason).toBe("The step timed out after 10 seconds (the longest runtime policy config/short.yaml allows).");
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
  });

  it("never lengthens a step's own shorter timeout", async () => {
    const { w, time } = start({ timeoutSeconds: 5, layers: [{ id: "long", spec: { maxRuntimeSeconds: 100 } }] });
    const runner = seedRunner(w, "runner-policy");
    await dispatchFixture(w, "cap-keeps");
    const attempt = startAttempt(w, runner, "req-1")!;
    time.advance(5_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(1);
    expect(attemptsOf(w.brain, attempt.jobId)[0]!.reason).toBe("The step timed out after 5 seconds.");
  });

  it("gives a step that declares no timeout the policy's cap as its deadline", async () => {
    const { w, time } = start({ timeoutSeconds: null, floor: (spec) => { spec["maxRuntimeSeconds"] = 60; } });
    const runner = seedRunner(w, "runner-policy");
    await dispatchFixture(w, "cap-fills");
    const attempt = startAttempt(w, runner, "req-1")!;
    time.advance(59_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    time.advance(1_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(1);
    expect(attemptsOf(w.brain, attempt.jobId)[0]!.reason).toContain("60 seconds (the longest runtime policy config/fixture-policy.yaml allows)");
  });
});

describe("minimum isolation is an ordered level", () => {
  it("raises a step that asks for less than the policy's minimum, so a weaker statement is never offered it", async () => {
    const { w } = start({ isolation: "trusted-local" });
    const runner = seedRunner(w, "runner-policy");
    const runId = await dispatchFixture(w, "isolation-raised");
    // The step declared trusted-local; the policy's minimum is ephemeral-container, and that is what is placed.
    expect((await snapshotOf(w, jobOf(w, runId))).placement.isolation).toBe("ephemeral-container");
    expect(startAttempt(w, runner, "req-1")).not.toBeNull();
  });

  it("does not place a job on a runner that states a level below the policy's minimum", async () => {
    const { w } = start({ layers: [{ id: "vm-only", spec: { minimumIsolation: "dedicated-vm" } }] });
    const runner = seedRunner(w, "runner-policy");
    const runId = await dispatchFixture(w, "isolation-vm");
    const jobId = jobOf(w, runId);
    expect((await snapshotOf(w, jobId)).placement.isolation).toBe("dedicated-vm");
    // The runner's sandboxes state ephemeral-container: below the minimum, so the job waits and the explanation says why.
    expect(startAttempt(w, runner, "req-1")).toBeNull();
    expect(jobRow(w, jobId).state).toBe("queued");
    const explained = (await w.brain.executeQuery(w.owner, { queryType: "job.explain", workspaceId: w.workspaceId, resourceId: jobId })) as unknown as { snapshot: { runners: Array<{ eligible: boolean; reasons: string[] }> } };
    expect(explained.snapshot.runners.some((entry) => entry.reasons.includes("isolation-mismatch"))).toBe(true);
  });
});
