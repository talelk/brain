import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forgetEnded, RETENTION_MS } from "../../apps/governor/src/trust/retention";
import { casPath } from "../../apps/governor/src/trust/artifacts";
import type { Store } from "../../apps/store/src/store";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { startCoreStore } from "./store";
import { getTask, makeWorkspace, pass, testClock } from "./work";

/** Retention (docs/model.md, "How long Brain keeps what is large"): a goal that ended more than a week ago forgets its bytes, and keeps its record. */
const clock = testClock();
const asked: string[] = [];
let harness: Harness;
let store: Store & { readonly port: number };
let driver: Driver;
let member: Client;
let workspaceId: string;
let blocked = false;

beforeAll(async () => {
  store = await startCoreStore(() => harness);
  harness = await createHarness({
    clock, storeUrl: `http://127.0.0.1:${store.port}`,
    fetch: (input, init) => { asked.push(`${init?.method ?? "GET"} ${String(input)}`); return blocked ? Promise.reject(new Error("the store is down")) : fetch(input, init); },
  });
  ({ workspaceId } = await makeWorkspace(harness, "Keep", { agents: { dev: {} }, plays: { one: 'title = "One"\n[[step]]\nid = "work"\nagent = "dev"\ngoal = "Write the report."\n' } }));
  member = await harness.member(workspaceId, "ann@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass(), dev: async (turn) => { await turn.event({ kind: "text", channel: "assistant", text: "Writing the report." }); return { result: "Wrote the report.", files: { "report.md": "# Report\n" }, patch: "diff --git a/x b/x\n" }; } });
});
afterAll(async () => {
  harness.close();
  await store.close();
});

const count = (sql: string, ...values: unknown[]): number => (harness.governor.gov.db.prepare(sql).get(...values) as { n: number }).n;

describe("retention", () => {
  it("forgets the bytes of a goal a week after it ended, and keeps its tasks, results, approvals and the audit chain; a goal that has not ended is never touched", async () => {
    const { taskId } = await member.command("task.create", { workspaceId, play: "one" });
    await driver.drain();
    const done = await getTask(member, workspaceId, taskId);
    expect(done.state).toBe("done");
    const links = () => count("SELECT COUNT(*) AS n FROM artifact_links WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?)", taskId);
    const events = () => count("SELECT COUNT(*) AS n FROM attempt_events WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.root_id=?)", taskId);
    const digests = (harness.governor.gov.db.prepare("SELECT DISTINCT digest FROM artifact_links WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?)").all(taskId) as Array<{ digest: `sha256:${string}` }>).map((row) => row.digest);
    expect([links() > 0, events() > 0, digests.length > 0, digests.every((digest) => existsSync(casPath(harness.governor.gov.dataDir, digest)))]).toEqual([true, true, true, true]);

    // Not yet a week: nothing is forgotten.
    clock.advance(RETENTION_MS - 60_000);
    expect(await forgetEnded(harness.governor.gov)).toBe(0);
    expect(links()).toBeGreaterThan(0);

    // A goal still open a week later is never touched.
    const open = (await member.command("task.create", { workspaceId, play: "one" })).taskId;
    clock.advance(120_000);
    // The git store is down: nothing is half forgotten, and the goal is tried again.
    blocked = true;
    expect(await forgetEnded(harness.governor.gov)).toBe(0);
    expect(links()).toBeGreaterThan(0);
    blocked = false;
    expect(await forgetEnded(harness.governor.gov)).toBe(1);
    expect(asked.filter((line) => line.startsWith("DELETE ")).at(-1)).toBe(`DELETE http://127.0.0.1:${store.port}/${workspaceId}/_goals/${taskId}`);
    expect([links(), events(), digests.some((digest) => existsSync(casPath(harness.governor.gov.dataDir, digest)))]).toEqual([0, 0, false]);
    expect(count("SELECT COUNT(*) AS n FROM attempts WHERE working_copy IS NOT NULL AND task_id IN (SELECT id FROM tasks WHERE root_id=?)", taskId)).toBe(0);
    // The record stays: the tasks and their results, the checks, and one event that says what was forgotten.
    const kept = await getTask(member, workspaceId, taskId);
    expect([kept.state, kept.result, kept.checks.length > 0, kept.artifacts]).toEqual(["done", done.result, true, []]);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE type='retention.forgot' AND subject=?", `task:${taskId}`)).toBe(1);
    // Forgotten once: the next look finds nothing more.
    expect(await forgetEnded(harness.governor.gov)).toBe(0);
    expect((await getTask(member, workspaceId, open)).state).not.toBe("done");
    await driver.drain();
  });
});
