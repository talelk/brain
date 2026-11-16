import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Mission, PlanTask } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { runCli } from "../../apps/cli/src/client";
import { seedHuman, setupWorld, workView, type TestWorld } from "../helpers";
import { totpCode } from "../support/totp";
import { confirmedMission, register, stageStarter, type Offer } from "../support/machine-session";
import { DIGEST_A } from "../helpers";

// Spec #90, ticket #140: the CLI operates missions, sessions and approvals as a client of the HTTP API only. A real Governor runs in-process;
// every state the CLI reads or changes is reached through commands and queries (the one sign-off fixture write is the established one in
// mission-signoff.test.ts: a task cannot be Done without a full run-and-evidence chain).
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(twoFactor = false) {
  const root = mkdtempSync(join(tmpdir(), "brain-cli-operate-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true, ...(twoFactor ? { runtime: { requireTwoFactor: true, memoryUiUrl: null } } : {}) });
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const w: TestWorld = setupWorld(app.brain);
  stageStarter(w);
  let output = ""; let errors = "";
  const as = (token: string, extra: Record<string, string> = {}) => async (args: string[], ask?: (label: string) => Promise<string>) => {
    output = ""; errors = "";
    const env: NodeJS.ProcessEnv = { BRAIN_GOVERNOR_URL: "http://127.0.0.1:3000", BRAIN_CLI_STATE_DIR: join(root, "state"), BRAIN_TOKEN: token, BRAIN_WORKSPACE: w.workspaceId, ...extra };
    return runCli(args, { env, fetch: async (request) => app.fetch(request), stdout: (t) => { output += t; }, stderr: (t) => { errors += t; }, ...(ask ? { prompt: ask } : {}) });
  };
  const owner = as(w.ownerToken);
  const json = async <T>(run: typeof owner, args: string[]): Promise<T> => { expect(await run([...args, "--json"]), errors).toBe(0); return JSON.parse(output) as T; };
  return { app, w, as, owner, json, out: () => output, err: () => errors };
}

const getMission = async (w: TestWorld, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: Mission }).snapshot;

describe("CLI missions", () => {
  it("lists Plays, creates a mission from one, shows it, pauses, resumes and transfers its owner", async () => {
    const x = await fixture();
    expect(await x.owner(["play", "list"])).toBe(0);
    expect(x.out().split("\n")[0]).toMatch(/^PLAY\s+TITLE\s+TASKS\s+AUTONOMY$/);
    const plays = await x.json<{ snapshot: { items: Array<{ playId: string }> } }>(x.owner, ["play", "list"]);
    const playId = plays.snapshot.items[0]!.playId;

    const created = await x.json<{ outcome: string; resourceId: string }>(x.owner, ["mission", "create", "--play", playId, "--title", "From the CLI"]);
    const id = created.resourceId; expect(id).toBeTruthy();
    expect(await getMission(x.w, id)).toMatchObject({ title: "From the CLI" });

    expect(await x.owner(["mission", "list"])).toBe(0);
    expect(x.out()).toMatch(/^MISSION\s+STATE\s+TITLE/);
    expect(x.out()).toContain(id); expect(x.out()).toContain("From the CLI");
    expect(await x.owner(["mission", "show", id])).toBe(0);
    expect(x.out()).toContain("From the CLI"); expect(x.out()).toContain(`id: ${id}`);

    // A mission that is still being planned is a draft; give it a confirmed plan through commands so it can run, pause and resume.
    const running = await confirmedMission(x.w);
    expect(await x.owner(["mission", "pause", running.missionId])).toBe(0);
    expect(x.out()).toContain("mission.pause: ");
    expect((await getMission(x.w, running.missionId)).state).toBe("paused");
    expect(await x.owner(["mission", "resume", running.missionId])).toBe(0);
    expect((await getMission(x.w, running.missionId)).state).toBe("active");

    const reviewer = await x.w.grantApprover("reviewer-1");
    expect(await x.owner(["mission", "owner", "transfer", running.missionId, "--to", reviewer.actor.actorId])).toBe(0);
    expect((await getMission(x.w, running.missionId)).ownerId).toBe(reviewer.actor.actorId);
  });

  it("refuses unusable input before any request and explains a Governor refusal in plain words", async () => {
    const x = await fixture();
    expect(await x.owner(["mission", "create", "--title", "No intent"])).toBe(2);
    expect(x.err()).toContain("--intent");
    expect(await x.owner(["mission", "verdict", "m1", "--outcome", "maybe"])).toBe(2);
    expect(await x.owner(["mission", "show", "does-not-exist"])).toBe(1);
    expect(x.err().length).toBeGreaterThan(0);
    expect(await x.owner(["mission", "pause", "does-not-exist"])).toBe(1);
    expect(await x.owner(["mission", "frobnicate"])).toBe(2);
    expect(x.err()).toContain("usage:");
  });

  it("records a sign-off verdict on the mission's latest evidence bundle", async () => {
    const x = await fixture();
    const missionId = (await x.json<{ resourceId: string }>(x.owner, ["mission", "create", "--title", "Sign off", "--intent", "Deliver it", "--criterion", "delivered"])).resourceId;
    const task: PlanTask = { id: "only", title: "Only task", criteria: ["only-done"], dependsOn: [] };
    const run = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) =>
      (await x.w.brain.executeCommand(x.w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: x.w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
    const planId = (await run("plan.propose", "p", { missionId, origin: "manual", tasks: [task] })).resourceId ?? "";
    await run("plan.confirm", "c", { planVersionId: planId }, (await getMission(x.w, missionId)).version);
    const item = (await workView(x.w)).items.find((entry) => entry.missionId === missionId)!;
    x.w.brain.store.workspaceDb(x.w.workspaceId, x.w.org).prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, item.workItemId);

    // Nothing to sign off yet: the CLI says so instead of guessing a bundle.
    expect(await x.owner(["mission", "verdict", missionId, "--outcome", "verified"])).toBe(1);
    expect(x.err()).toContain("no evidence bundle");

    await run("mission.proposeCompletion", "done", { missionId }, (await getMission(x.w, missionId)).version);
    expect((await getMission(x.w, missionId)).state).toBe("verifying");
    expect(await x.owner(["mission", "verdict", missionId, "--outcome", "verified"])).toBe(0);
    expect(x.out()).toContain("mission.verdict.record: ");
    const bundle = ((await x.w.brain.executeQuery(x.w.owner, { queryType: "missionBundles.latest", workspaceId: x.w.workspaceId, resourceId: missionId } as never)) as unknown as { snapshot: { state: string } }).snapshot;
    expect(bundle.state).toBe("verified");
  });
});

describe("CLI sessions", () => {
  it("lists, shows, steers, pauses, continues and stops a running session", async () => {
    const x = await fixture();
    const runner = register(x.w, "runner-cli");
    const { missionId } = await confirmedMission(x.w);
    const offer = x.w.brain.jobProtocol.claim(runner, "claim-cli") as unknown as Offer;
    x.w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "pi", adapterDigest: DIGEST_A, features: ["sessions", "steer", "pause"] } });
    expect(await x.owner(["session", "list"])).toBe(0);
    expect(x.out()).toMatch(/^SESSION\s+STATE\s+AGENT\s+TASK/);
    const list = await x.json<{ snapshot: { items: Array<{ sessionId: string; attemptId: string; missionId?: string }> } }>(x.owner, ["session", "list"]);
    const session = list.snapshot.items.find((s) => s.attemptId === offer.attemptId)!;
    expect(session.missionId ?? missionId).toBe(missionId);
    expect(await x.owner(["session", "show", session.sessionId])).toBe(0);
    expect(x.out()).toContain(`id: ${session.sessionId}`);

    expect(await x.owner(["session", "steer", session.sessionId, "--message", "Focus on the failing test first"])).toBe(0);
    expect(x.out()).toContain("session.steer: ");
    expect(await x.owner(["session", "steer", session.sessionId])).toBe(2);

    const state = async () => ((await x.w.brain.executeQuery(x.w.owner, { queryType: "session.get", workspaceId: x.w.workspaceId, resourceId: session.sessionId } as never)) as unknown as { snapshot: { state: string; pause?: { state: string } } }).snapshot;
    expect(await x.owner(["session", "pause", session.sessionId])).toBe(0);
    expect((await state()).pause?.state).toBe("pausing");
    expect(await x.owner(["session", "continue", session.sessionId])).toBe(0);
    expect(await x.owner(["session", "stop", session.sessionId, "--reason", "enough"])).toBe(0);
    expect(x.out()).toContain("session.stop: ");
    // The runner learns of the stop on its next heartbeat.
    const told = x.w.brain.jobProtocol.heartbeat(runner, { sequence: 1, health: "healthy" }).commands as Array<{ type: string; attemptId?: string }>;
    expect(told.filter((command) => command.attemptId === offer.attemptId).map((command) => command.type)).toContain("stop-attempt");
    // Without membership in the workspace, the Governor's refusal reaches the person and the exit code is 1.
    const outsider = x.as(seedHuman(x.w.brain, x.w.org, "outsider-1").token);
    expect(await outsider(["session", "steer", session.sessionId, "--message", "hello"])).toBe(1);
  });
});

describe("CLI approvals with step-up", () => {
  async function pending(twoFactor = true) {
    const x = await fixture(twoFactor);
    const approver = await x.w.grantApprover("approver-cli");
    const subject = { organizationId: x.w.org, workspaceId: x.w.workspaceId, operation: "fixture.publish", tool: { id: "fixture.echo", digest: `sha256:${"a".repeat(64)}` }, inputDigest: `sha256:${"a".repeat(64)}`, target: { targetId: "target-1", environmentId: "local", preconditionDigest: `sha256:${"a".repeat(64)}` }, artifactDigest: `sha256:${"a".repeat(64)}`, policyDigest: `sha256:${"a".repeat(64)}`, configDigest: `sha256:${"a".repeat(64)}`, effectBounds: {}, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), nonce: `cli-${Math.random()}` };
    const receipt = (await x.w.brain.executeCommand(x.w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${subject.nonce}`, commandType: "approval.request", workspaceId: x.w.workspaceId, idempotencyKey: subject.nonce, payload: { subject } } as never, subject.nonce)).receipt;
    return { x, approver, approvalId: receipt.resourceId! };
  }
  const stateOf = async (x: Awaited<ReturnType<typeof fixture>>, id: string) => ((await x.w.brain.executeQuery(x.w.owner, { queryType: "approval.get", workspaceId: x.w.workspaceId, resourceId: id } as never)) as unknown as { snapshot: { state: string } }).snapshot.state;

  it("lists and shows pending approvals, then decides one with a fresh authenticator code", async () => {
    const { x, approver, approvalId } = await pending();
    const run = x.as(approver.token);
    expect(await run(["approval", "list"])).toBe(0);
    expect(x.out()).toMatch(/^APPROVAL\s+STATE\s+OPERATION\s+CREATED/);
    expect(x.out()).toContain(approvalId); expect(x.out()).toContain("fixture.publish");
    expect(await run(["approval", "show", approvalId])).toBe(0);
    expect(x.out()).toContain("[pending]");

    // No code given and no terminal answer: the command asks for the authenticator code the way the app does, and the decision is recorded.
    const asked: string[] = [];
    expect(await run(["approval", "decide", approvalId, "--decision", "approve", "--note", "checked"], async (label) => { asked.push(label); return totpCode(approver.totp, Date.now()); })).toBe(0);
    expect(asked).toEqual(["Authenticator code"]);
    expect(x.out()).toContain("approved");
    expect(await stateOf(x, approvalId)).toBe("approved");
    expect(x.app.brain.store.control.prepare("SELECT note FROM approval_decisions WHERE approval_id=?").get(approvalId)).toEqual({ note: "checked" });
    // A decided approval is not decided again.
    expect(await run(["approval", "decide", approvalId, "--decision", "reject"])).toBe(1);
  });

  it("without a required authenticator the step-up is the signed-in session itself and needs no code", async () => {
    const { x, approver, approvalId } = await pending(false);
    expect(await x.as(approver.token)(["approval", "decide", approvalId, "--decision", "request-changes", "--note", "needs the export"])).toBe(0);
    expect(await stateOf(x, approvalId)).not.toBe("pending");
    expect(x.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM step_up_evidence").get()).toEqual({ n: 1 });
  });

  it("never bypasses step-up: a wrong code is refused, no evidence or decision is recorded, and --json never prompts", async () => {
    const { x, approver, approvalId } = await pending();
    const run = x.as(approver.token);
    expect(await run(["approval", "decide", approvalId, "--decision", "approve", "--code", "000000"])).toBe(1);
    expect(await stateOf(x, approvalId)).toBe("pending");
    expect(x.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM step_up_evidence").get()).toEqual({ n: 0 });
    // The raw command path stays closed to approval decisions.
    expect(await run(["command", JSON.stringify({ commandType: "approval.decision" })])).toBe(2);
    expect(x.err()).toContain("brain approval decide");
    // A person without the approver scope cannot even obtain a challenge.
    expect(await x.owner(["approval", "decide", approvalId, "--decision", "approve", "--code", totpCode(approver.totp, Date.now())])).toBe(1);
    expect(await stateOf(x, approvalId)).toBe("pending");
    const code = totpCode(approver.totp, Date.now());
    expect(await run(["approval", "decide", approvalId, "--decision", "reject", "--code", code, "--json"])).toBe(0);
    expect(JSON.parse(x.out())).toMatchObject({ state: "rejected" });
  });
});

describe("served OpenAPI", () => {
  it("is read metadata: a signed-in credential gets exactly the generated document, an anonymous caller is refused", async () => {
    const x = await fixture();
    const served = await x.app.fetch(new Request("http://127.0.0.1:3000/v1/openapi.json", { headers: { authorization: `Bearer ${x.w.ownerToken}` } }));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/json");
    expect(await served.text()).toBe(readFileSync(join(import.meta.dirname, "../../contracts/v1/openapi.json"), "utf8"));
    const anonymous = await x.app.fetch(new Request("http://127.0.0.1:3000/v1/openapi.json"));
    expect(anonymous.status).toBe(401);
  });
});
