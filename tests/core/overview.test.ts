import type { Overview, OverviewWorkspace } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step, testClock } from "./work";

/** The Overview: what every workspace the caller belongs to is doing, and never a workspace the caller is not in. */
const clock = testClock();
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const plays = {
  signed: 'title = "Signed"\n[[step]]\nid = "write"\nagent = "writer"\napprove = true\ngoal = "Write."\n',
  operate: 'title = "Operate"\n[[step]]\nid = "restart"\nagent = "operator"\ngoal = "Restart."\n',
};
const agents = { writer: {}, planner: {}, operator: { tools: ["deploy.restart"] } };
const microUsd = (n: number) => ({ result: "Written.", usage: { microUsd: n } });
const failing = { outcome: "failed" as const, result: "", failure: { reason: "limit" as const, detail: "Out of turns", infrastructure: false } };

let harness: Harness;
let alpha: { workspaceId: string };
let beta: { workspaceId: string };
let ann: Client;
let bob: Client;
let driver: Driver;
/** How many times the writer ran, by workspace: each run costs 2.5 dollars. */
const writes = new Map<string, number>();

/** A goal started from a Play, run to its first rest and, when `signOff`, signed off by `by`. */
async function goal(by: Client, workspaceId: string, play: string, signOff = false): Promise<string> {
  const { taskId } = await by.command("task.create", { workspaceId, play, inputs: {} });
  await driver.drain();
  if (signOff) await by.command("task.check", { workspaceId, taskId: step(await getTask(by, workspaceId, taskId), "write").id, pass: true });
  return taskId;
}
const day = (offset = 0): string => new Date(clock.now + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  harness = await createHarness({ clock });
  alpha = await makeWorkspace(harness, "Alpha", { agents, tools: { "deploy.restart": restart }, plays, brain: '[limits]\ndaily_spend_usd = 20\n[[project]]\nname = "shop"\nrepo = "https://example.com/shop.git"\n' });
  beta = await makeWorkspace(harness, "Beta", { agents, tools: { "deploy.restart": restart }, plays });
  ann = await harness.member(alpha.workspaceId, "ann@example.com", "member");
  bob = await harness.member(beta.workspaceId, "bob@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass(), writer: ({ offer }) => { writes.set(offer.workspaceId, (writes.get(offer.workspaceId) ?? 0) + 1); return microUsd(2_500_000); }, planner: () => failing, operator: ({ tool }) => tool("deploy.restart", { container: "db" }).then(() => ({ outcome: "held" as const, result: "Waiting." })) });
});
afterAll(() => harness.close());

describe("overview", () => {
  it("refuses nobody signed in, and an empty instance has no workspaces, no work and, for an admin, a health strip", async () => {
    await expect(harness.anonymous.query("overview", {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const empty = await createHarness();
    try {
      const view = await empty.admin.query("overview", {});
      expect(view).toMatchObject({ workspaces: [], needsYou: [], running: [], health: { runnersOnline: 0, runnersTotal: 0, modelsTotal: 0, auditProblem: null } });
    } finally { empty.close(); }
  });

  it("shows a person only the workspaces they belong to, and the health strip only to an instance admin", async () => {
    await goal(ann, alpha.workspaceId, "signed");
    await goal(bob, beta.workspaceId, "signed");
    const mineA = await ann.query("overview", {});
    const mineB = await bob.query("overview", {});
    expect(mineA.workspaces.map((workspace) => workspace.name)).toEqual(["Alpha"]);
    expect(mineB.workspaces.map((workspace) => workspace.name)).toEqual(["Beta"]);
    expect(mineA.needsYou.map((need) => [need.workspaceId, need.workspaceName, need.workspaceSlug])).toEqual([[alpha.workspaceId, "Alpha", expect.any(String)]]);
    expect(mineB.needsYou.every((need) => need.workspaceId === beta.workspaceId)).toBe(true);
    expect(mineA.health).toBeNull();
    expect((await harness.admin.query("overview", {})).workspaces.map((workspace) => workspace.name)).toEqual(["Alpha", "Beta"]);
    expect((await harness.admin.query("overview", {})).health).toMatchObject({ runnersOnline: 1, runnersTotal: 1, auditProblem: null });
    await harness.admin.command("member.set", { workspaceId: beta.workspaceId, email: "ann@example.com", role: "viewer" });
    expect((await ann.query("overview", {})).workspaces.map((workspace) => [workspace.name, workspace.role])).toEqual([["Alpha", "member"], ["Beta", "viewer"]]);
    await harness.admin.command("member.remove", { workspaceId: beta.workspaceId, userId: (await harness.admin.query("members.list", { workspaceId: beta.workspaceId })).members.find((member) => member.email === "ann@example.com")?.userId ?? "" });
  });

  it("counts what needs a person, what runs, what finished and what failed, with the project names and the spend against the cap", async () => {
    await goal(ann, alpha.workspaceId, "signed", true);
    // A goal typed in words is planned first; when the plan cannot be made the goal fails.
    const failed = (await ann.command("task.create", { workspaceId: alpha.workspaceId, goal: "Plan the year" })).taskId;
    await driver.drain();
    expect(await getTask(ann, alpha.workspaceId, failed)).toMatchObject({ state: "failed" });
    const operate = await goal(ann, alpha.workspaceId, "operate");
    // A started goal that nothing waits for is running, even while it only waits for a runner.
    const { taskId: queued } = await ann.command("task.create", { workspaceId: alpha.workspaceId, play: "signed", inputs: {} });

    const view = await ann.query("overview", {});
    const workspace = view.workspaces[0];
    expect(workspace).toMatchObject({ name: "Alpha", role: "member", projects: ["shop"], doneToday: 1, failedToday: 1, running: 1, spend: { capMicroUsd: 20_000_000 } });
    // The sign-off left from the earlier test and the held call need a person; the queued goal is the one that runs.
    expect(workspace?.needsYou).toBe(2);
    expect(workspace?.spend.todayMicroUsd).toBeGreaterThanOrEqual(2_500_000);
    expect(workspace?.lastActivityAt).toBe(clock.now);
    expect(view.needsYou.map((need) => need.needs?.kind).sort()).toEqual(["approval", "sign-off"]);
    const call = view.needsYou.find((need) => need.needs?.kind === "approval");
    expect(call).toMatchObject({ rootId: operate, goalTitle: "Operate", workspaceName: "Alpha", approval: { tool: "deploy.restart", state: "pending", subject: { input: { container: "db" } } } });
    expect(view.needsYou.find((need) => need.needs?.kind === "sign-off")?.approval).toBeNull();
    expect(queued).not.toBe(operate);
    await ann.command("task.stop", { workspaceId: alpha.workspaceId, taskId: queued });
  });

  it("lists a call as soon as it waits, and the attempts running now with their agent, step and age", async () => {
    let seen: Overview | undefined;
    driver.script({ operator: async ({ tool }) => { await tool("deploy.restart", { container: "web" }); seen = await ann.query("overview", {}); return { outcome: "held" as const, result: "Waiting." }; } });
    await goal(ann, alpha.workspaceId, "operate");
    const view = seen as Overview;
    // While the runner still waits for the answer, the call is already something to approve.
    const waiting = view.needsYou.filter((need) => need.approval?.subject.input && JSON.stringify(need.approval.subject.input).includes("web"));
    expect(waiting).toMatchObject([{ needs: { kind: "approval" }, state: "needs_you", goalTitle: "Operate", workspaceName: "Alpha" }]);
    expect(view.running).toMatchObject([{ agent: "operator", kind: "work", workspaceName: "Alpha", goalTitle: "Operate", stepId: "restart", microUsd: 0, startedAt: clock.now }]);
    expect((await ann.query("overview", {})).running).toEqual([]);
  });

  it("keeps 14 whole days with the day a goal finished and what it cost, cut at midnight UTC, and drops what leaves the window", async () => {
    const before = (writes.get(alpha.workspaceId) ?? 0) * 2_500_000;
    clock.now = Date.UTC(2026, 10, 20, 23, 59, 0);
    await goal(ann, alpha.workspaceId, "signed", true);
    clock.advance(2 * 60_000);
    await goal(ann, alpha.workspaceId, "signed", true);
    expect(day()).toBe("2026-11-21");
    const { days, doneToday, spend } = (await ann.query("overview", {})).workspaces[0] as OverviewWorkspace;
    expect(days).toHaveLength(14);
    expect(days.map((entry) => entry.day)).toEqual(Array.from({ length: 14 }, (_, index) => day(index - 13)));
    expect(days.at(-1)).toEqual({ day: "2026-11-21", done: 1, microUsd: 2_500_000 });
    expect(days.at(-2)).toEqual({ day: "2026-11-20", done: 1, microUsd: 2_500_000 });
    // The first goals of the week (the 16th) are still inside the window and have their own day.
    expect(days.find((entry) => entry.day === "2026-11-16")).toMatchObject({ done: 1, microUsd: before });
    expect(doneToday).toBe(1);
    expect(spend.todayMicroUsd).toBe(2_500_000);
    clock.advance(20 * 86_400_000);
    const later = (await ann.query("overview", {})).workspaces[0];
    expect(later).toMatchObject({ doneToday: 0, failedToday: 0, spend: { todayMicroUsd: 0 } });
    expect(later?.days.every((entry) => entry.done === 0 && entry.microUsd === 0)).toBe(true);
  });
});
