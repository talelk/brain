import type { Approval, BrainToolResponse } from "@brain/contracts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSchedules } from "../../apps/governor/src/tasks/triggers";
import { bareRepository, git, writeFiles } from "../runner/git-repo";
import { enrolRunner, type Driver, type Turn } from "./driver";
import { startGitServer, type GitServer } from "./git-server";
import { createHarness, type Client, type Harness } from "./harness";
import { fail, getTask, pass, states, step, testClock } from "./work";

/** The Plays shipped in `packs/`, each run from start to a checked result by scripted agents standing in for the engines. */
const clock = testClock();
const teams: string[] = [];
const origin = bareRepository({ "src/login.js": "export const login = (user) => user.name;\n" });
let harness: Harness;
let server: GitServer;
let member: Client;
let driver: Driver;

const workspace = async (name: string, packs: string[], brain: string): Promise<string> => {
  const { workspaceId } = await harness.createWorkspace({ name, packs });
  await harness.admin.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: `name = "${name}"\npacks = ${JSON.stringify(packs)}\n${brain}\n[[model]]\nname = "main"\nprovider = "openai-compatible"\nurl = "https://model.example/v1"\nmodel = "fixture"\n` }] });
  await harness.admin.command("secret.set", { workspaceId, name: "teams-webhook", value: "https://teams.example/hook" });
  await harness.admin.command("secret.set", { workspaceId, name: "github", value: "ghp-test-token" });
  member = await harness.member(workspaceId, `max-${packs[0]}@example.com`, "member");
  return workspaceId;
};
const approvePending = async (workspaceId: string): Promise<Approval> => {
  const [approval] = (await member.query("approvals.list", { workspaceId, state: "pending" })).approvals;
  await member.command("approval.decide", { workspaceId, approvalId: approval?.id ?? "", decision: "approve", subjectDigest: approval?.subjectDigest ?? "" });
  return approval as Approval;
};
/** Calls a Brain-run tool that needs an approval the way a runner does: ask, wait for the person, ask again. */
const approved = async ({ post, offer }: Turn, tool: string, input: object): Promise<BrainToolResponse> => {
  const call = { callId: `${tool}-${offer.task.round}`, tool, input };
  const asked = await post<BrainToolResponse>("brain-tool", call);
  if (asked.state !== "pending") return asked;
  await approvePending(offer.workspaceId);
  return post<BrainToolResponse>("brain-tool", call);
};

beforeAll(async () => {
  server = await startGitServer(dirname(origin.repo));
  harness = await createHarness({
    clock, packsDir: fileURLToPath(new URL("../../packs", import.meta.url)),
    fetch: (input, init) => { if (!String(input).startsWith("https://teams.example/")) return fetch(input, init); teams.push(String(init?.body)); return Promise.resolve(new Response("1")); },
  });
  driver = await enrolRunner(harness);
});
afterAll(async () => {
  harness.close();
  await server.close();
});

describe("the shipped Plays", () => {
  it("fix-issue: investigate, change until the reviewer passes it, then open the pull request and wait for a sign-off", async () => {
    const workspaceId = await workspace("Factory", ["software-factory"], `[[project]]\nname = "shop"\nrepo = "${server.origin}/origin.git"\naccess = "write"\ncredential = "secret:github"\n`);
    writeFiles(origin.clone, { "src/login.js": "export const login = (user) => user?.name ?? null;\n" });
    const patch = `${git(origin.clone, "diff", "--binary", "--full-index", "--no-renames", "--src-prefix=a/shop/", "--dst-prefix=b/shop/", "HEAD")}\n`;
    git(origin.clone, "checkout", "--quiet", ".");
    driver.script({
      analyst: ({ offer }) => { expect(offer.task.goal).toContain("Issue: Login crashes without a user"); return "src/login.js line 1 reads user.name without a guard."; },
      checker: () => pass(),
      developer: ({ offer }) => {
        expect(offer.context.results.map((result) => result.title)).toEqual(["investigate"]);
        return { result: `Guarded the read (round ${offer.task.round}). Ran the tests: they pass.`, patch, baseCommits: { shop: origin.head() } };
      },
      reviewer: ({ offer }) => (offer.task.round === 1 ? fail("No test covers the missing user.", 0.5) : pass("The guard is tested.")),
      "release-manager": async (turn) => {
        const opened = await approved(turn, "git.open-pr", { project: "shop", title: "Guard login against a missing user", body: "Fixes the crash; the tests pass." });
        return opened.state === "done" ? `Opened ${(opened.output as { url: string }).url}` : JSON.stringify(opened);
      },
    });
    const { taskId } = await member.command("task.create", { workspaceId, play: "fix-issue", inputs: { issue: "Login crashes without a user" } });
    const offers = await driver.drain();
    expect(offers.map((offer) => `${offer.kind}:${offer.agent.name}`)).toEqual(["work:analyst", "check:checker", "work:developer", "check:reviewer", "work:developer", "check:reviewer", "work:release-manager", "check:checker"]);
    // The second round of the change continues from the first round's working copy; the release starts from the reviewed change.
    expect([offers[4]?.workingCopy?.digest, offers[6]?.inheritedPatches.length]).toEqual([offers[3]?.context.review?.[0]?.patch?.digest, 1]);
    const waiting = await getTask(member, workspaceId, taskId);
    const release = step(waiting, "release");
    expect(release).toMatchObject({ state: "needs_you", needs: { kind: "sign-off" } });
    expect(git(origin.repo, "show", `brain/${release.id}:src/login.js`)).toContain("user?.name ?? null");
    await member.command("task.check", { workspaceId, taskId: release.id, pass: true });
    const done = await getTask(member, workspaceId, taskId);
    expect(done).toMatchObject({ state: "done", result: "Opened https://github.example/origin/pull/41" });
    expect(done.pullRequests).toMatchObject([{ project: "shop", number: 41 }]);
    expect(done.checks.map((check) => `${check.by.kind}:${check.pass}`)).toEqual(["agent:true", "agent:false", "agent:true", "agent:true", "person:true"]);
  });

  it("keep-healthy: on its schedule, a healthy host ends after the check; an unhealthy one is diagnosed and remediated under a standing approval", async () => {
    const workspaceId = await workspace("Hosts", ["sre"], '[approvals."host.restart"]\ntargets = ["web"]\nper_day = 2\nuntil = 2027-12-31\n');
    let healthy = true;
    const restarts: string[] = [];
    driver.script({
      "sre-operator": async ({ offer, tool, brain }) => {
        if (offer.task.title === "check") {
          const found = await brain("memory.search", { query: "runbook services" });
          expect(found).toMatchObject({ state: "done", output: { results: expect.any(Array) } });
          return { output: healthy ? { healthy: true, unhealthy: [], summary: "All four checks passed." } : { healthy: false, unhealthy: ["web"], summary: "web is exited." } };
        }
        expect(offer.task.goal).toContain("What the check reported: web is exited.");
        restarts.push((await tool("host.restart", { container: "web" }, "web")).state);
        return "Restarted web; its check passes again.";
      },
      "incident-analyst": ({ offer }) => { expect(offer.task.goal).toContain("web is exited."); return "The container ran out of memory; a restart helps."; },
      evaluator: () => pass("The restart is recorded and the check after it passed."),
      checker: () => pass(),
    });
    const fire = async (): Promise<string> => {
      clock.advance(15 * 60_000);
      runSchedules(harness.governor.gov);
      const [root] = (await member.query("tasks.list", { workspaceId, rootsOnly: true, limit: 1 })).tasks;
      await driver.drain();
      return root?.id ?? "";
    };
    const calm = await getTask(member, workspaceId, await fire());
    expect(calm).toMatchObject({ state: "done", play: "keep-healthy", createdBy: "trigger:keep-healthy", result: '{"healthy":true,"unhealthy":[],"summary":"All four checks passed."}' });
    expect(states(calm)).toEqual({ check: "done", diagnose: "done", remediate: "done" });
    expect(calm.attempts.map((attempt) => attempt.agent)).toEqual(["sre-operator", "checker"]);
    healthy = false;
    const incident = await getTask(member, workspaceId, await fire());
    expect(incident).toMatchObject({ state: "done", result: "Restarted web; its check passes again." });
    expect(incident.attempts.map((attempt) => `${attempt.kind}:${attempt.agent}`)).toEqual(["work:sre-operator", "check:checker", "work:incident-analyst", "check:checker", "work:sre-operator", "check:evaluator"]);
    expect(restarts).toEqual(["approved"]);
    expect(incident.approvals).toMatchObject([{ tool: "host.restart", effect: "privileged", standing: true, state: "approved", subject: { input: { container: "web" } } }]);
    expect(incident.id).not.toBe(calm.id);
  });

  it("handle-request: route, draft with the matching agent until the quality score is reached, send once approved, and sign off", async () => {
    const workspaceId = await workspace("Support", ["customer-operations"], '[teams]\nwebhook = "secret:teams-webhook"\n');
    const scores = [0.6, 0.9];
    driver.script({
      router: () => ({ output: { category: "technical", urgency: "high", summary: "Cannot sign in after the password reset." } }),
      checker: () => pass(),
      "technical-agent": async ({ offer, brain }) => {
        expect(offer.task.goal).toContain("Urgency: high");
        const tone = await brain("memory.search", { query: "tone" });
        expect(tone).toMatchObject({ state: "done", output: { results: expect.arrayContaining([expect.objectContaining({ name: "tone-guide" })]) } });
        return `## Reply\nPlease reset once more (draft ${offer.task.round}).\n\n## Notes for the team\nCheck the reset mail.`;
      },
      "quality-reviewer": () => pass("Clear, but say how long it takes.", scores.shift()),
      generalist: async (turn) => {
        expect(turn.offer.context.results.map((result) => [result.title, result.result.startsWith("## Reply") || result.result === "skipped" || result.title === "route"])).toEqual([["route", true], ["billing", true], ["technical", true], ["other", true]]);
        const sent = await approved(turn, "message.send", { text: "Reply for Dana (technical, urgency high), ready to forward:\nPlease reset once more (draft 2)." });
        return `Sent: ${JSON.stringify(sent)}`;
      },
    });
    const { taskId } = await member.command("task.create", { workspaceId, play: "handle-request", inputs: { customer: "Dana", request: "I cannot sign in." } });
    await expect(member.command("task.create", { workspaceId, play: "handle-request", inputs: { customer: "Dana" } })).rejects.toMatchObject({ code: "INVALID_INPUT", problems: [{ path: "inputs", message: '"request" is required' }] });
    const offers = await driver.drain();
    expect(offers.map((offer) => `${offer.kind}:${offer.agent.name}`)).toEqual(["work:router", "check:checker", "work:technical-agent", "check:quality-reviewer", "work:technical-agent", "check:quality-reviewer", "work:generalist", "check:checker"]);
    const waiting = await getTask(member, workspaceId, taskId);
    expect(states(waiting)).toEqual({ route: "done", billing: "done", technical: "done", other: "done", send: "needs_you" });
    expect(teams).toHaveLength(1);
    expect(teams[0]).toContain("Please reset once more (draft 2).");
    await member.command("task.check", { workspaceId, taskId: step(waiting, "send").id, pass: true });
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", result: 'Sent: {"state":"done","output":{"sent":true}}' });
  });
});
