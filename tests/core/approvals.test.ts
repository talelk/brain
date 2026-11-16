import type { Approval, JobOffer, JsonValue } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireDue } from "../../apps/governor/src/trust/approvals";
import { enrolRunner, type Driver, type Turn } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step, testClock } from "./work";

/** Calls with an effect (docs/architecture.md section 7): approved while the runner waits, held and carried out later, declined, and covered by a standing approval. */
const clock = testClock();
const posted: Array<{ url: string; body: string }> = [];
let harness: Harness;
let member: Client;
let workspaceId: string;
let driver: Driver;

const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const play = (agent: string) => `title = "Operate"\n[inputs.what]\ntype = "string"\nrequired = true\n[[step]]\nid = "operate"\nagent = "${agent}"\ngoal = "{{what}}"\n`;
const start = async (what: string): Promise<string> => step(await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "operate", inputs: { what } })).taskId), "operate").id;
const pending = async (): Promise<readonly Approval[]> => (await member.query("approvals.list", { workspaceId, state: "pending" })).approvals;
const decide = (approval: Approval, decision: "approve" | "reject", reason = "") => member.command("approval.decide", { workspaceId, approvalId: approval.id, decision, subjectDigest: approval.subjectDigest, reason });
/** What a runner does with the approved call of an `act` attempt: run exactly that call and report it. */
const act = async ({ offer, post, ran }: Turn, output: JsonValue): Promise<string> => {
  const call = offer.act as NonNullable<JobOffer["act"]>;
  expect(await post("tool-call", { callId: call.callId, tool: call.tool, input: call.input })).toMatchObject({ state: "approved", approvalId: call.approvalId });
  await ran(call.callId, "succeeded", output);
  return "ran";
};

beforeAll(async () => {
  harness = await createHarness({ clock, fetch: (input, init) => { posted.push({ url: String(input), body: String(init?.body) }); return Promise.resolve(Response.json({ ok: true })); } });
  ({ workspaceId } = await makeWorkspace(harness, "Operations", {
    brain: '[teams]\nwebhook = "secret:teams-webhook"\n[approvals."deploy.restart"]\ntargets = ["web-1"]\nper_day = 2\nuntil = 2026-12-31\n',
    agents: { operator: { tools: ["deploy.restart", "message.send", "echo"] } }, tools: { "deploy.restart": restart }, plays: { operate: play("operator") },
  }));
  await harness.admin.command("secret.set", { workspaceId, name: "teams-webhook", value: "https://teams.example/hook" });
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass() });
});
afterAll(() => harness.close());

describe("a call with an effect", () => {
  it("waits for a person; approved while the runner waits, it runs and the attempt goes on", async () => {
    driver.script({
      operator: async ({ tool, poll, ran, offer }) => {
        expect(await tool("echo", { words: ["free"] }, { words: ["free"] })).toMatchObject({ state: "approved" });
        const asked = await tool("deploy.restart", { container: "db-1" });
        expect(asked).toMatchObject({ state: "pending", approvalId: expect.any(String) });
        expect(await poll(asked.approvalId ?? "")).toEqual({ state: "pending" });
        expect(await getTask(member, workspaceId, offer.task.id)).toMatchObject({ state: "needs_you", needs: { kind: "approval", approvalId: asked.approvalId } });
        const [approval] = await pending();
        expect(approval).toMatchObject({ tool: "deploy.restart", effect: "privileged", agent: "operator", standing: false, subject: { tool: "deploy.restart", input: { container: "db-1" }, taskId: offer.task.id, snapshotDigest: offer.snapshotDigest } });
        expect(await decide(approval as Approval, "approve", "It is stuck.")).toEqual({ state: "approved" });
        expect(await poll(asked.approvalId ?? "")).toEqual({ state: "approved", reason: "It is stuck." });
        expect((await getTask(member, workspaceId, offer.task.id)).state).toBe("running");
        await ran(asked.callId, "succeeded", { restarted: "db-1" });
        return "Restarted db-1.";
      },
    });
    const taskId = await start("Restart the database");
    const offers = await driver.drain();
    expect(offers.map((offer) => offer.kind)).toEqual(["work", "check"]);
    // The check is shown the calls that were made, with what they answered.
    expect(offers[1]?.context.review?.[0]?.toolCalls).toEqual([
      { tool: "echo", effect: "read", input: { words: ["free"] }, output: { words: ["free"] }, outcome: "succeeded" },
      { tool: "deploy.restart", effect: "privileged", input: { container: "db-1" }, output: { restarted: "db-1" }, outcome: "succeeded" },
    ]);
    const task = await getTask(member, workspaceId, taskId);
    expect(task.state).toBe("done");
    expect(task.approvals).toMatchObject([{ state: "approved", decidedBy: { name: "max" }, reason: "It is stuck." }]);
    expect(task.toolCalls.map((call) => [call.tool, call.outcome, call.approvalId !== null])).toEqual([["echo", "succeeded", false], ["deploy.restart", "succeeded", true]]);
  });

  it("is decided only on the subject the approver was shown, by a member, once", async () => {
    let approval: Approval | undefined;
    driver.script({
      operator: async ({ tool }) => {
        await tool("deploy.restart", { container: "db-2" });
        [approval] = await pending();
        return { outcome: "held", result: "Waiting for the restart to be approved." };
      },
    });
    const taskId = await start("Restart the second database");
    await driver.drain();
    const shown = approval as Approval;
    expect(await member.query("approval.get", { workspaceId, approvalId: shown.id })).toEqual(shown);
    const wrong = { workspaceId, approvalId: shown.id, decision: "approve" as const, subjectDigest: `sha256:${"0".repeat(64)}` };
    await expect(member.command("approval.decide", wrong)).rejects.toMatchObject({ code: "STALE_VERSION" });
    // What is stored was changed after the approver read it: the decision is refused, whatever digest it carries.
    const { db } = harness.governor.gov;
    db.prepare("UPDATE approvals SET subject_json=replace(subject_json, 'db-2', 'db-9') WHERE id=?").run(shown.id);
    await expect(decide(shown, "approve")).rejects.toMatchObject({ code: "STALE_VERSION" });
    db.prepare("UPDATE approvals SET subject_json=replace(subject_json, 'db-9', 'db-2') WHERE id=?").run(shown.id);
    const viewer = await harness.member(workspaceId, "vera@example.com", "viewer");
    await expect(viewer.command("approval.decide", { ...wrong, subjectDigest: shown.subjectDigest })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await harness.createWorkspace({ name: "Elsewhere", packs: ["core"] });
    const outsider = await harness.member(other.workspaceId, "omar@example.com", "admin");
    await expect(outsider.command("approval.decide", { ...wrong, subjectDigest: shown.subjectDigest })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.command("approval.decide", { ...wrong, workspaceId: other.workspaceId, subjectDigest: shown.subjectDigest })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await pending()).map((entry) => entry.id)).toEqual([shown.id]);
    expect(await decide(shown, "reject", "Not during business hours.")).toEqual({ state: "rejected" });
    await expect(decide(shown, "approve")).rejects.toMatchObject({ code: "CONFLICT" });
    await member.command("task.stop", { workspaceId, taskId });
  });

  it("not approved in time, the attempt ends held; once approved, an attempt runs exactly that call and the task is queued again with the outcome", async () => {
    let round = 0;
    driver.script({
      operator: async (turn) => {
        if (turn.offer.kind === "act") return act(turn, { restarted: "db-3" });
        round += 1;
        if (round === 1) {
          expect(await turn.tool("deploy.restart", { container: "db-3" })).toMatchObject({ state: "pending" });
          return { outcome: "held", result: "I asked to restart db-3 and stopped." };
        }
        expect(turn.offer.task.findings).toEqual(['Your earlier call to deploy.restart with {"container":"db-3"} was approved after you stopped, and it ran. Its answer: {"restarted":"db-3"}']);
        return "db-3 was restarted and answers again.";
      },
    });
    const taskId = await start("Restart the third database");
    expect((await driver.drain()).map((offer) => offer.kind)).toEqual(["work"]);
    const held = await getTask(member, workspaceId, taskId);
    expect(held).toMatchObject({ state: "needs_you", needs: { kind: "approval" } });
    expect(held.toolCalls).toMatchObject([{ tool: "deploy.restart", outcome: "held" }]);
    const [approval] = await pending();
    await decide(approval as Approval, "approve");
    const offers = await driver.drain();
    expect(offers.map((offer) => offer.kind)).toEqual(["act", "work", "check"]);
    expect(offers[0]?.act).toEqual({ callId: held.toolCalls[0]?.id, approvalId: approval?.id, tool: "deploy.restart", input: { container: "db-3" } });
    const task = await getTask(member, workspaceId, taskId);
    expect(task).toMatchObject({ state: "done", result: "db-3 was restarted and answers again." });
    expect(task.toolCalls).toMatchObject([{ tool: "deploy.restart", outcome: "succeeded", output: { restarted: "db-3" } }]);
    expect(task.attempts.map((attempt) => [attempt.kind, attempt.state])).toEqual([["work", "held"], ["act", "succeeded"], ["work", "succeeded"], ["check", "succeeded"]]);
  });

  it("declined, it does not happen: the waiting runner is told why, and a held task is queued again with the reason", async () => {
    let round = 0;
    driver.script({
      operator: async ({ tool, poll, offer }) => {
        round += 1;
        if (round === 1) {
          const asked = await tool("deploy.restart", { container: "db-4" });
          await decide((await pending())[0] as Approval, "reject", "Use the failover instead.");
          expect(await poll(asked.approvalId ?? "")).toEqual({ state: "rejected", reason: "Use the failover instead." });
          // Asking for the same call again answers the same; a new call is a new approval.
          await tool("deploy.restart", { container: "db-5" });
          return { outcome: "held", result: "Waiting." };
        }
        expect(offer.task.findings).toEqual(['Your earlier call to deploy.restart with {"container":"db-4"} did not happen (a person declined it): {"error":"A person declined this call: Use the failover instead."}. Do not repeat it.',
          'Your earlier call to deploy.restart with {"container":"db-5"} did not happen (a person declined it): {"error":"A person declined this call"}. Do not repeat it.']);
        return "Nothing was restarted; the failover is the way.";
      },
    });
    const taskId = await start("Restart the fourth database");
    await driver.drain();
    await decide((await pending())[0] as Approval, "reject");
    expect((await driver.drain()).map((offer) => offer.kind)).toEqual(["work", "check"]);
    const task = await getTask(member, workspaceId, taskId);
    expect(task.state).toBe("done");
    expect(task.toolCalls.map((call) => call.outcome)).toEqual(["rejected", "rejected"]);
  });

  it("nobody deciding in time counts as a no", async () => {
    let round = 0;
    driver.script({ operator: async ({ tool, offer }) => { round += 1; if (round === 2) return `Told: ${offer.task.findings[0]}`; await tool("deploy.restart", { container: "db-6" }); return { outcome: "held", result: "Waiting." }; } });
    const taskId = await start("Restart the sixth database");
    await driver.drain();
    const [approval] = await pending();
    clock.advance(8 * 86_400_000);
    await expect(decide(approval as Approval, "approve")).rejects.toMatchObject({ code: "CONFLICT" });
    expireDue(harness.governor.gov);
    await driver.drain();
    expect((await getTask(member, workspaceId, taskId)).result).toContain("did not happen (nobody decided in time)");
    expect((await member.query("approval.get", { workspaceId, approvalId: approval?.id ?? "" })).state).toBe("expired");
  });

  it("a standing approval covers its targets at once, up to its daily limit and its end date", async () => {
    const answers: string[] = [];
    driver.script({
      operator: async ({ tool }) => {
        for (const container of ["web-1", "web-1", "web-1"]) answers.push((await tool("deploy.restart", { container }, { restarted: container })).state);
        return { outcome: "held", result: "Two restarts ran; the third waits." };
      },
    });
    const first = await start("Restart the web server three times");
    await driver.drain();
    expect(answers).toEqual(["approved", "approved", "pending"]);
    const task = await getTask(member, workspaceId, first);
    expect(task.approvals.map((approval) => [approval.standing, approval.state, approval.decidedBy])).toEqual([[true, "approved", null], [true, "approved", null], [false, "pending", null]]);
    await member.command("task.stop", { workspaceId, taskId: first });
    expect((await getTask(member, workspaceId, first)).approvals[2]).toMatchObject({ state: "expired" });

    // The next day the count starts again; after the end date nothing is covered.
    const ask = async (): Promise<string> => {
      answers.length = 0;
      driver.script({ operator: async ({ tool }) => { answers.push((await tool("deploy.restart", { container: "web-1" }, { restarted: "web-1" })).state); return answers[0] === "approved" ? "Restarted." : { outcome: "held", result: "Waiting." }; } });
      const taskId = await start("Restart the web server");
      await driver.drain();
      if (answers[0] !== "approved") await member.command("task.stop", { workspaceId, taskId });
      return answers[0] ?? "";
    };
    clock.advance(86_400_000);
    expect(await ask()).toBe("approved");
    clock.now = Date.UTC(2026, 11, 31, 23, 0);
    expect(await ask()).toBe("approved");
    clock.now = Date.UTC(2027, 0, 1, 1, 0);
    expect(await ask()).toBe("pending");
  });

  it("applies to the tools Brain runs too: message.send posts to Teams only once approved, also after the attempt ended", async () => {
    posted.length = 0;
    let round = 0;
    driver.script({
      operator: async ({ offer, brain, post }) => {
        if (offer.kind === "act") {
          expect(await post("brain-tool", { callId: offer.act?.callId, tool: offer.act?.tool, input: offer.act?.input })).toEqual({ state: "done", output: { sent: true } });
          return "sent";
        }
        round += 1;
        if (round === 2) return "Both messages are out.";
        const asked = await brain("message.send", { text: "The database is back." });
        expect(asked).toMatchObject({ state: "pending" });
        expect(posted).toEqual([]);
        await decide((await pending())[0] as Approval, "approve");
        // The runner asks again with the same call id once the approval is in.
        expect(await post("brain-tool", { callId: "call-1", tool: "message.send", input: { text: "The database is back." } })).toEqual({ state: "done", output: { sent: true } });
        expect(await brain("message.send", { text: "A second message." })).toMatchObject({ state: "pending" });
        return { outcome: "held", result: "The second message waits." };
      },
    });
    const taskId = await start("Tell the team");
    await driver.drain();
    expect(posted.map((call) => call.url)).toEqual(["https://teams.example/hook"]);
    expect(posted[0]?.body).toContain("The database is back.");
    await decide((await pending())[0] as Approval, "approve");
    expect((await driver.drain()).map((offer) => offer.kind)).toEqual(["act", "work", "check"]);
    expect(posted.map((call) => JSON.parse(call.body).attachments[0].content.body[0].text)).toEqual(["The database is back.", "A second message."]);
    expect((await getTask(member, workspaceId, taskId)).toolCalls.map((call) => [call.tool, call.outcome])).toEqual([["message.send", "succeeded"], ["message.send", "succeeded"]]);
  });

  it("a tool the agent does not have, or an input that does not fit, is refused before anyone is asked", async () => {
    driver.script({
      operator: async ({ post, brain }) => {
        await expect(post("tool-call", { callId: "x1", tool: "deploy.restart", input: { container: 7 } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(post("tool-call", { callId: "x2", tool: "task.note", input: { text: "hi" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(post("brain-tool", { callId: "x3", tool: "task.create", input: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await brain("message.send", { text: 5 })).toMatchObject({ state: "failed", error: expect.stringContaining('"text" must be of type string') });
        return "Nothing was called.";
      },
    });
    const taskId = await start("Try what is not allowed");
    await driver.drain();
    expect(await pending()).toEqual([]);
    expect((await getTask(member, workspaceId, taskId)).toolCalls.map((call) => [call.tool, call.outcome])).toEqual([["message.send", "failed"]]);
  });
});
