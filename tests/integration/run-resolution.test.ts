import { describe, expect, it } from "vitest";
import type { ActorContext, AttentionItem, BrainSession, CommandReceipt, JobSnapshot, PlanTask, Run } from "@brain/contracts";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const query = async <T>(w: World, queryType: string, resourceId?: string) =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [] });

async function mission(w: World, key: string): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
  const version = (await query<{ version: number }>(w, "missions.get", id)).version;
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, version);
  return id;
}

function seedJob(w: World, id: string, runId: string, state: string): void {
  const digest = w.brain.activeRelease(w.org)!.digest;
  const now = w.brain.store.now();
  w.brain.store.control.prepare(`INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,version,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms)
    VALUES (?,?,?,?,?,'respond',?,1,?,?,?,'read',?,?,?)`)
    .run(id, w.org, w.workspaceId, `exec-${id}`, runId, state, digest, JSON.stringify({ resources: { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 }, all: [] }), `sha256:${"d".repeat(64)}`, now, now, now + 60_000);
}

describe("run resolution: Runs 'Needs intervention' and Today's Needs-you agree", () => {
  it("a failed attempt of a task that later succeeded or whose mission closed is history; unresolved parked work stays", async () => {
    const w = setupWorld();
    try {
      const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
      const healed = await mission(w, "healed");
      const stuck = await mission(w, "stuck");
      const closed = await mission(w, "closed");
      const items = (await workView(w)).items;
      const itemOf = (missionId: string) => items.find((entry) => entry.missionId === missionId)!;
      // healed: attempt 1 failed, attempt 2 succeeded, the task is done.
      w.brain.missions.linkExecution(w.owner, w.workspaceId, itemOf(healed).workItemId, "run-h1");
      seedJob(w, "job-h1", "run-h1", "failed");
      w.brain.missions.linkExecution(w.owner, w.workspaceId, itemOf(healed).workItemId, "run-h2");
      seedJob(w, "job-h2", "run-h2", "succeeded");
      db.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"a".repeat(64)}`, itemOf(healed).workItemId);
      // stuck: three failed attempts, the task is parked and waits for a person.
      for (const runId of ["run-s1", "run-s2", "run-s3"]) {
        w.brain.missions.linkExecution(w.owner, w.workspaceId, itemOf(stuck).workItemId, runId);
        seedJob(w, `job-${runId}`, runId, "failed");
        w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `tests failed in ${runId}`);
      }
      // closed: a failed attempt, then the mission ended.
      w.brain.missions.linkExecution(w.owner, w.workspaceId, itemOf(closed).workItemId, "run-c1");
      seedJob(w, "job-c1", "run-c1", "failed");
      db.prepare("UPDATE missions SET state='closed', outcome='ended' WHERE id=?").run(closed);
      // a standalone failed dispatch has no task behind it: judged by its own state.
      seedJob(w, "job-solo", "run-solo", "failed");

      const jobs = (await query<{ items: JobSnapshot[] }>(w, "jobs.list")).items;
      const byId = new Map(jobs.map((entry) => [entry.jobId, entry]));
      expect(byId.get("job-h1")).toMatchObject({ needsYou: false, context: { workItemTitle: "Task a", missionTitle: "healed", resolution: "retried-and-succeeded" } });
      expect(byId.get("job-c1")).toMatchObject({ needsYou: false, context: { resolution: "mission-closed" } });
      expect(byId.get("job-solo")).toMatchObject({ needsYou: true });
      expect(byId.get("job-solo")?.context).toBeUndefined();
      // Only the newest failed attempt of the parked task asks for a person; the earlier ones were superseded by it.
      expect(byId.get("job-run-s3")).toMatchObject({ needsYou: true, context: { missionTitle: "stuck" } });
      expect(byId.get("job-run-s3")?.context?.resolution).toBeUndefined();
      expect(byId.get("job-run-s1")).toMatchObject({ needsYou: false, context: { resolution: "retried" } });

      // Today's queue names the same unresolved task and none of the settled ones.
      const attention = (await query<{ items: AttentionItem[] }>(w, "attention.list")).items;
      const missionsNeedingYou = new Set(attention.filter((entry) => entry.kind !== "result-ready").map((entry) => entry.missionId));
      const missionsWithStuckRuns = new Set(jobs.filter((entry) => entry.needsYou && entry.context).map((entry) => entry.context!.missionId));
      expect([...missionsWithStuckRuns]).toEqual([stuck]);
      expect(missionsNeedingYou.has(stuck)).toBe(true);
      expect(missionsNeedingYou.has(healed)).toBe(false);
      expect(missionsNeedingYou.has(closed)).toBe(false);
    } finally { w.brain.close(); }
  });

  it("an outcome-unknown run settled by a later attempt leaves Today and the Runs view together", async () => {
    const w = setupWorld();
    try {
      const id = await mission(w, "unknown");
      const item = (await workView(w)).items.find((entry) => entry.missionId === id)!;
      w.brain.missions.linkExecution(w.owner, w.workspaceId, item.workItemId, "run-u1");
      seedJob(w, "job-u1", "run-u1", "outcome_unknown");
      w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"a".repeat(64)}`, item.workItemId);
      const jobs = (await query<{ items: JobSnapshot[] }>(w, "jobs.list")).items;
      expect(jobs.find((entry) => entry.jobId === "job-u1")?.needsYou).toBe(false);
      expect((await query<{ items: AttentionItem[] }>(w, "attention.list")).items.some((entry) => entry.kind === "outcome-unknown")).toBe(false);
    } finally { w.brain.close(); }
  });
});

describe("run.get", () => {
  it("returns the first-class Run DTO with its mission and task links, and refuses an unknown run", async () => {
    const w = setupWorld();
    try {
      const id = await mission(w, "rundto");
      const item = (await workView(w)).items.find((entry) => entry.missionId === id)!;
      const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
      const digest = w.brain.activeRelease(w.org)!.digest;
      db.prepare("INSERT INTO workflow_runs(id,execution_key,config_digest,workflow_digest,adapter_digest,engine_run_id,state,version,input_digest,created_at_ms) VALUES ('run-dto','exec-run-dto',?,?,?,'engine-run-dto','running',1,?,?)")
        .run(digest, `sha256:${"e".repeat(64)}`, `sha256:${"d".repeat(64)}`, `sha256:${"f".repeat(64)}`, w.brain.store.now());
      db.prepare("INSERT INTO run_inputs(run_id,input_json,workflow_json,actor_id) VALUES ('run-dto','{}',?,'owner')").run(JSON.stringify({ metadata: { id: "weekly-digest" } }));
      w.brain.missions.linkExecution(w.owner, w.workspaceId, item.workItemId, "run-dto");
      const run = await query<Run>(w, "run.get", "run-dto");
      expect(run).toMatchObject({ runId: "run-dto", workspaceId: w.workspaceId, state: "running", release: { id: "weekly-digest" }, missionId: id, workItemId: item.workItemId });
      await expect(query<Run>(w, "run.get", "run-missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { w.brain.close(); }
  });
});

describe("Runs search", () => {
  it("matches task titles, mission titles, workflow names, states and ids, every word at once", async () => {
    const w = setupWorld();
    try {
      const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
      const quarterly = await mission(w, "quarterly-report");
      const item = (await workView(w)).items.find((entry) => entry.missionId === quarterly)!;
      w.brain.missions.linkExecution(w.owner, w.workspaceId, item.workItemId, "run-q1");
      seedJob(w, "job-q1", "run-q1", "failed");
      seedJob(w, "job-other", "run-other", "queued");
      const workflow = JSON.stringify({ metadata: { id: "weekly-digest" }, spec: { presentation: { title: "Weekly digest" } } });
      db.prepare("INSERT INTO run_inputs(run_id,input_json,workflow_json,actor_id) VALUES ('run-other','{}',?,'owner')").run(workflow);
      const search = async (text: string) => {
        const page = (await w.brain.executeQuery(w.owner, { queryType: "jobs.list", workspaceId: w.workspaceId, search: text } as never)) as unknown as { snapshot: { items: JobSnapshot[]; totalEstimate: number } };
        return page.snapshot.items.map((entry) => entry.jobId).sort();
      };
      expect(await search("QUARTERLY")).toEqual(["job-q1"]);
      expect(await search("task a")).toEqual(["job-q1"]);
      expect(await search("weekly digest")).toEqual(["job-other"]);
      expect(await search("queued")).toEqual(["job-other"]);
      expect(await search("failed quarterly")).toEqual(["job-q1"]);
      expect(await search("job-q1")).toEqual(["job-q1"]);
      expect(await search("nothing like this")).toEqual([]);
    } finally { w.brain.close(); }
  });
});

describe("session activity for the doing-now sentence", () => {
  it("counts reading tool calls of the session's attempt and names the last tool", async () => {
    const w = setupWorld();
    try {
      const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
      db.prepare(`INSERT INTO sessions(id,job_id,attempt_id,engine_id,adapter_digest,state,created_at_ms,updated_at_ms) VALUES ('ses-act','job-act','att-act','fixture',?, 'running',1,2)`).run(`sha256:${"b".repeat(64)}`);
      const call = (proposal: string, tool: string, at: string, done: boolean) => w.brain.store.control.prepare(
        "INSERT INTO tool_calls(attempt_id,proposal_id,organization_id,workspace_id,run_id,tool_id,proposed_at,finished_at) VALUES ('att-act',?,?,?,'run-act',?,?,?)")
        .run(proposal, w.org, w.workspaceId, tool, at, done ? at : null);
      call("p1", "web.fetch", "2026-11-11T10:00:00Z", true);
      call("p2", "knowledge.search", "2026-11-11T10:00:05Z", true);
      call("p3", "web.fetch", "2026-11-11T10:00:09Z", false);
      call("p4", "bash", "2026-11-11T10:00:01Z", true);
      const sessions = (await query<{ items: BrainSession[] }>(w, "sessions.list")).items;
      expect(sessions.find((entry) => entry.sessionId === "ses-act")?.activity).toEqual({ toolCalls: 4, sourcesRead: 3, lastTool: "web.fetch", lastToolDone: false });
    } finally { w.brain.close(); }
  });
});
