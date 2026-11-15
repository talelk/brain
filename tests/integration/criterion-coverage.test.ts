import { afterEach, describe, expect, it } from "vitest";
import type { Handoff, MissionEvidenceBundle, PlanTask } from "@brain/contracts";
import { domainDigest, sha256Digest } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { command, getMission } from "../support/reuse";
import { finishTask } from "../support/finish-task";

// ADR 0034 (coverage rule), ticket #94: the mission evidence bundle records, per success criterion, the work items serving it and the
// verified checks that NAME it. A workflow's checks passing as a whole never cover a free-text criterion. Everything below reaches state
// through commands and queries; the exception is the verified evidence of a finished task, seeded as rows (see tests/support/finish-task.ts).
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const query = async <T>(w: TestWorld, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const latestBundle = (w: TestWorld, id: string) => query<MissionEvidenceBundle>(w, "missionBundles.latest", id);
const task = (id: string, serves: string[], dependsOn: string[] = [], criteria = [`${id}-done`]): PlanTask => ({ id, title: `Task ${id}`, criteria, dependsOn, ...(serves.length ? { criterionIds: serves } : {}) });
const upload = (w: TestWorld, text: string): string => {
  const bytes = Buffer.from(text, "utf8");
  const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: sha256Digest(bytes), expectedBytes: bytes.length }) as unknown as { uploadId: string };
  return (w.brain.putUpload(w.owner, up.uploadId, bytes) as unknown as { digest: string }).digest;
};

async function missionWithPlan(w: TestWorld, key: string, tasks: PlanTask[]): Promise<string> {
  const id = (await command(w, w.owner, "mission.create", `${key}-create`, { title: `Mission ${key}`, intent: `Deliver ${key}`, successCriteria: ["Facts are listed", "A recommendation is made", "Risks are named"], autoStart: false })).resourceId ?? "";
  const planId = (await command(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await command(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await getMission(w, id)).version);
  return id;
}
const complete = async (w: TestWorld, id: string, key: string) => {
  await command(w, w.owner, "mission.proposeCompletion", key, { missionId: id }, (await getMission(w, id)).version);
  return latestBundle(w, id);
};
/** The criteria a task finished with, as the Done rule sees them: this check passes the task's own criterion, the workflow-style ones do not name anything of the mission's. */
const workflowChecks = [{ criterionId: "structure", checkId: "structure", status: "passed" as const }, { criterionId: "safety", checkId: "safety", status: "passed" as const }];

describe("per-criterion coverage in the mission evidence bundle (ADR 0034)", () => {
  it("records the serving work items and only the checks that name a criterion; a blanket pass covers nothing", async () => {
    world = setupWorld();
    const w = world;
    const id = await missionWithPlan(w, "cover", [
      task("a", ["c1"]), // its evidence has a check that names c1
      task("b", ["c2"], [], ["A recommendation is written"]), // free-text criterion; only workflow-vocabulary checks, all passed
      task("d", [], ["b"]), // serves nothing; depends on b, so it receives b's handoff facts
    ]);
    await finishTask(w, id, "a", "a", [{ criterionId: "a-done", checkId: "a-done", status: "passed" }, { criterionId: "c1", checkId: "facts-listed", status: "passed" }]);
    await finishTask(w, id, "b", "b", workflowChecks);

    // The dependent is told the workflow passed as a whole, not that the free-text criterion passed.
    const [received] = (await query<{ items: Handoff[] }>(w, "handoffs.forWorkItem", ((await query<{ items: Array<{ workItemId: string; planTaskId: string; missionId: string }> }>(w, "workItems.list")).items.find((item) => item.missionId === id && item.planTaskId === "d")!).workItemId)).items;
    expect(received?.facts?.criteria).toEqual([{ criterionId: "A recommendation is written", status: "unlinked" }]);
    await finishTask(w, id, "d", "d");

    const bundle = await complete(w, id, "cover-finish");
    expect(bundle).toMatchObject({ state: "submitted", complete: true });
    const byId = (criterionId: string) => bundle.coverage.find((entry) => entry.criterionId === criterionId)!;
    expect(bundle.coverage.map((entry) => entry.criterionId)).toEqual(["c1", "c2", "c3"]);
    expect(byId("c1")).toMatchObject({ text: "Facts are listed", workItems: [{ title: "Task a", state: "done" }], checks: [{ name: "facts-listed", outcome: "passed", evidenceDigest: `sha256:${"a".repeat(64)}` }], advisory: [] });
    // c2: the work is done and every check of its verified evidence passed, but none names the criterion, so it is not linked.
    expect(byId("c2")).toMatchObject({ workItems: [{ title: "Task b", state: "done" }], checks: [], advisory: [] });
    // c3: no task serves it at all.
    expect(byId("c3")).toMatchObject({ workItems: [], checks: [] });
    // The mission page still reads "covered" for c2 (its serving work is Done); the proof is a separate question.
    expect((await getMission(w, id)).successCriteria.map((criterion) => `${criterion.criterionId}:${criterion.state}`)).toEqual(["c1:covered", "c2:covered", "c3:not-covered"]);
  });

  it("is part of the digest: the digest recomputes from the manifest's coverage and changes with it", async () => {
    world = setupWorld();
    const w = world;
    const id = await missionWithPlan(w, "digest", [task("a", ["c1"]), task("b", ["c2"])]);
    await finishTask(w, id, "a", "a", [{ criterionId: "c1", checkId: "facts-listed", status: "passed" }, { criterionId: "a-done", checkId: "a-done", status: "passed" }]);
    await finishTask(w, id, "b", "b");
    const bundle = await complete(w, id, "digest-finish");
    const manifest = {
      missionId: bundle.missionId, briefVersion: bundle.briefVersion, outputVersions: bundle.outputVersions, complete: bundle.complete, items: bundle.items,
      coverage: bundle.coverage.map(({ advisory: _advisory, ...entry }) => entry), assembledAt: Date.parse(bundle.createdAt),
    };
    const digestOf = (value: typeof manifest) => domainDigest("brain:mission-evidence:v1", value as never);
    expect(digestOf(manifest)).toBe(bundle.digest);
    // Same assembly time, one criterion linked differently: another digest.
    const unlinked = { ...manifest, coverage: manifest.coverage.map((entry) => entry.criterionId === "c1" ? { ...entry, checks: [] } : entry) };
    expect(digestOf(unlinked)).not.toBe(bundle.digest);
  });

  it("a rejected and resubmitted mission records coverage again, and a replanned task serves what the confirmed plan says", async () => {
    world = setupWorld();
    const w = world;
    const id = await missionWithPlan(w, "again", [task("a", ["c1"])]);
    await finishTask(w, id, "a", "a");
    const first = await complete(w, id, "again-finish-1");
    expect(first.coverage[0]).toMatchObject({ criterionId: "c1", workItems: [{ title: "Task a" }], checks: [] });
    await command(w, w.owner, "mission.verdict.record", "again-reject", { missionId: id, bundleDigest: first.digest, outcome: "rejected", findings: ["The facts need a source"] });
    // The coordinator relinks the finished task to c2 as well (allowed on started work, ADR 0034 §4).
    const planId = (await command(w, w.owner, "plan.propose", "again-plan-2", { missionId: id, origin: "manual", tasks: [task("a", ["c1", "c2"])] })).resourceId ?? "";
    await command(w, w.owner, "plan.confirm", "again-confirm-2", { planVersionId: planId }, (await getMission(w, id)).version);
    const second = await complete(w, id, "again-finish-2");
    expect(second.digest).not.toBe(first.digest);
    expect(second.coverage.map((entry) => [entry.criterionId, entry.workItems.length])).toEqual([["c1", 1], ["c2", 1], ["c3", 0]]);
  });

  it("evaluator checks recorded on the submitted bundle that name a criterion link it; a model's advisory check is carried apart and never links", async () => {
    world = setupWorld();
    const w = world;
    const id = await missionWithPlan(w, "mission-checks", [task("a", ["c1", "c2"])]);
    await finishTask(w, id, "a", "a");
    const bundle = await complete(w, id, "mission-checks-finish");
    expect(bundle.coverage.map((entry) => entry.checks.length)).toEqual([0, 0, 0]);
    const evidence = upload(w, "Reviewer notes: the recommendation follows from the findings table.");
    w.brain.recordBundleCheck({ actor: w.owner, workspaceId: w.workspaceId, missionId: id, criterionId: "c1", evaluator: "reviewer-1", outcome: "passed", evidenceDigest: evidence });
    w.brain.recordBundleCheck({ actor: w.owner, workspaceId: w.workspaceId, missionId: id, criterionId: "c2", evaluator: "judge:model-x", outcome: "passed", evidenceDigest: evidence, advisory: true });
    const after = await latestBundle(w, id);
    expect(after.digest).toBe(bundle.digest);
    expect(after.coverage[0]).toMatchObject({ criterionId: "c1", checks: [{ name: "reviewer-1", outcome: "passed", evidenceDigest: evidence }], advisory: [] });
    expect(after.coverage[1]).toMatchObject({ criterionId: "c2", checks: [], advisory: [{ name: "judge:model-x", outcome: "passed" }] });
  });
});
