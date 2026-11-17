import type { Task } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { fail, getTask, makeWorkspace, pass, step, testClock } from "./work";

/** A goal waiting for a person is closed when a newer identical one has a result (docs/model.md, "When a newer identical task made a waiting one useless"). */
const clock = testClock();
const HOUR = 3_600_000;
const reviewed = 'title = "Reviewed"\n[inputs.what]\ntype = "string"\nrequired = true\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "{{what}}"\n[[step]]\nid = "then"\nagent = "dev"\nafter = ["do"]\ngoal = "Then."\n';
const plain = 'title = "Plain"\n[inputs.what]\ntype = "string"\nrequired = true\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "{{what}}"\n';
const agents = { dev: {}, "workspace-healer": { tools: ["task.ask"] } };

let harness: Harness;
let driver: Driver;
let member: Client;
let seen = 0;
let devRuns = 0;
/** What the dev does: fail while a test says so. */
let devFails = false;
/** While set, the checker refuses, so a task ends up asking a person for the check. */
let strict = false;

async function workspace(brain = ""): Promise<string> {
  seen += 1;
  const { workspaceId } = await makeWorkspace(harness, `Cleanup ${seen}`, { brain, agents, plays: { reviewed, plain } });
  member = await harness.member(workspaceId, `kim${seen}@example.com`, "member");
  return workspaceId;
}
const start = async (workspaceId: string, play: string, what = "Summarise"): Promise<Task> => getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play, inputs: { what } })).taskId);
const state = async (workspaceId: string, task: { id: string }): Promise<string> => (await getTask(member, workspaceId, task.id)).state;
const events = (type: string): Array<{ subject: string; payload: Record<string, unknown> }> =>
  (harness.governor.gov.db.prepare("SELECT subject, payload_json FROM events WHERE type=? ORDER BY seq").all(type) as Array<{ subject: string; payload_json: string }>).map((row) => ({ subject: row.subject, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));

beforeAll(async () => {
  harness = await createHarness({ clock });
  driver = await enrolRunner(harness, {
    checker: () => (strict ? fail("Not good enough.") : pass()),
    dev: () => { devRuns += 1; return devFails ? { outcome: "failed" as const, result: "", failure: { reason: "limit" as const, detail: "Out of turns", infrastructure: false } } : "Done."; },
    "workspace-healer": async (turn) => { await turn.brain("task.ask", { question: "What now?" }); return "I asked."; },
  });
});
afterAll(() => harness.close());

describe("a goal waiting for a person and a newer identical one", () => {
  it("is closed, with the audit chain saying why, once the newer one asks for a check; not while it only runs, and not for other inputs", async () => {
    const workspaceId = await workspace();
    strict = true;
    const old = await start(workspaceId, "reviewed");
    await driver.drain();
    expect(step(await getTask(member, workspaceId, old.id), "do")).toMatchObject({ state: "needs_you", needs: { kind: "check" } });

    clock.advance(25 * HOUR);
    const other = await start(workspaceId, "reviewed", "Something else");
    await driver.drain();
    expect(step(await getTask(member, workspaceId, other.id), "do").state).toBe("needs_you");
    expect(await state(workspaceId, old)).toBe("running");
    // A newer identical goal that has only been started does not count.
    const fresh = await start(workspaceId, "reviewed");
    expect(await state(workspaceId, old)).toBe("running");
    await driver.drain();

    const closed = await getTask(member, workspaceId, old.id);
    expect(closed.state).toBe("stopped");
    expect(step(closed, "do").state).toBe("stopped");
    const newer = step(await getTask(member, workspaceId, fresh.id), "do");
    expect(newer).toMatchObject({ state: "needs_you", needs: { kind: "check" } });
    expect(closed.supersededBy).toMatchObject({ taskId: newer.id, rootId: fresh.id, state: "check", hours: 25 });
    expect((await member.query("tasks.list", { workspaceId, rootsOnly: true, limit: 10 })).tasks.find((task) => task.id === old.id)?.supersededBy).toMatchObject({ taskId: newer.id });
    expect((await member.query("today", { workspaceId })).needsYou.some((task) => task.rootId === old.id)).toBe(false);
    expect(events("task.superseded").filter((event) => event.subject === `task:${old.id}`)).toEqual([{ subject: `task:${old.id}`, payload: { title: closed.title, by: newer.id, byRoot: fresh.id, byState: "check", hours: 25 } }]);
    // The newer goal and the one with other inputs keep waiting for their person.
    expect(await state(workspaceId, fresh)).toBe("running");
    expect(await state(workspaceId, other)).toBe("running");
    strict = false;
  });

  it("is not closed before it has waited the threshold, and is closed at the first change after it when the newer one is done", async () => {
    const workspaceId = await workspace();
    strict = true;
    const old = await start(workspaceId, "reviewed");
    await driver.drain();
    clock.advance(HOUR);
    strict = false;
    const newer = await start(workspaceId, "reviewed");
    await driver.drain();
    expect(await state(workspaceId, newer)).toBe("done");
    expect(await state(workspaceId, old)).toBe("running");
    clock.advance(24 * HOUR);
    await start(workspaceId, "plain", "Anything");
    const closed = await getTask(member, workspaceId, old.id);
    expect(closed.state).toBe("stopped");
    expect(closed.supersededBy).toMatchObject({ rootId: newer.id, state: "done", hours: 25 });
    expect(events("task.superseded").some((event) => event.subject === `task:${old.id}` && event.payload["byState"] === "done" && event.payload["byRoot"] === newer.id)).toBe(true);
    await driver.drain();
  });

  it("is not closed when the threshold is 0", async () => {
    const workspaceId = await workspace("[cleanup]\nsuperseded_after_hours = 0\n");
    strict = true;
    const old = await start(workspaceId, "reviewed");
    await driver.drain();
    clock.advance(200 * HOUR);
    strict = false;
    const newer = await start(workspaceId, "reviewed");
    await driver.drain();
    expect(await state(workspaceId, newer)).toBe("done");
    expect(await state(workspaceId, old)).toBe("running");
    expect(step(await getTask(member, workspaceId, old.id), "do")).toMatchObject({ state: "needs_you", needs: { kind: "check" } });
  });

  it("is closed when the newer one is done, with the heal task of its failed sub-task", async () => {
    const workspaceId = await workspace();
    strict = false;
    devFails = true;
    const old = await start(workspaceId, "plain");
    await driver.drain();
    devFails = false;
    const failed = step(await getTask(member, workspaceId, old.id), "do");
    expect(failed.state).toBe("failed");
    const heal = (await member.query("tasks.list", { workspaceId, rootsOnly: true, limit: 10 })).tasks.find((task) => task.heals?.id === failed.id);
    expect(heal).toMatchObject({ state: "needs_you", needs: { kind: "answer" } });
    expect(await state(workspaceId, old)).toBe("needs_you");

    clock.advance(30 * HOUR);
    const newer = await start(workspaceId, "plain");
    await driver.drain();
    expect(await state(workspaceId, newer)).toBe("done");
    expect(await state(workspaceId, old)).toBe("stopped");
    expect(await state(workspaceId, heal as { id: string })).toBe("stopped");
    expect(events("task.superseded").some((event) => event.subject === `task:${(heal as { id: string }).id}` && event.payload["by"] !== undefined && event.payload["byRoot"] === newer.id)).toBe(true);
    expect(devRuns).toBeGreaterThan(0);
  });
});
