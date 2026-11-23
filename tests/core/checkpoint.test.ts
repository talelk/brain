import type { Task } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step, testClock } from "./work";

/** A goal pauses for a person as its Play says, and an unanswered checkpoint stops it (docs/model.md, "Checkpoints"). */
const clock = testClock();
const HOUR = 3_600_000;
const play = 'title = "Two"\ncheckpoint = "1 rounds"\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "One."\n[[step]]\nid = "then"\nagent = "dev"\nafter = ["do"]\ngoal = "Two."\n';
let harness: Harness;
let member: Client;
let workspaceId: string;
let drain: () => Promise<unknown>;

const start = async (): Promise<Task> => getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "two", inputs: {} })).taskId);

beforeAll(async () => {
  harness = await createHarness({ clock });
  const driver = await enrolRunner(harness, { checker: () => pass(), dev: () => "Done." });
  drain = () => driver.drain();
  workspaceId = (await makeWorkspace(harness, "Checkpoints", { agents: { dev: {} }, plays: { two: play } })).workspaceId;
  member = await harness.member(workspaceId, "kim@example.com", "member");
});
afterAll(() => harness.close());

describe("a goal with a checkpoint", () => {
  it("pauses before the next task with a summary, and goes on when a person continues with a changed goal", async () => {
    const goal = await start();
    await drain();
    const held = step(await getTask(member, workspaceId, goal.id), "then");
    expect(held).toMatchObject({ state: "needs_you", needs: { kind: "checkpoint", summary: expect.stringContaining("1 work attempt") } });
    await member.command("task.checkpoint", { workspaceId, taskId: held.id, goal: "Do it in French." });
    await drain();
    const done = await getTask(member, workspaceId, goal.id);
    expect(done.state).toBe("done");
    expect(done.notes.some((note) => note.text.includes("Do it in French."))).toBe(true);
  });

  it("stops after the timeout, and says why", async () => {
    const goal = await start();
    await drain();
    expect(step(await getTask(member, workspaceId, goal.id), "then").needs?.kind).toBe("checkpoint");
    clock.advance(25 * HOUR);
    // The Governor settles a workspace every few seconds; creating a goal does it at once.
    await start();
    await drain();
    const stopped = await getTask(member, workspaceId, goal.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.notes.some((note) => note.text.includes("nobody answered the checkpoint within 24h"))).toBe(true);
  });
});

describe("a model with no price", () => {
  it("is said on Today: a spend cap cannot count it", async () => {
    expect((await member.query("today", { workspaceId })).spend.unpriced).toBe(true);
  });
});
