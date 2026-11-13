import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { fixtureGate } from "../../apps/runner/src/engines/fixture";
import { WebhookTicketAdapter } from "../../apps/governor/src/modules/operations/connectors";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { fixtureStarter } from "../support/starter";
import { scaled } from "../support/timing";

/**
 * Effect permits (ADR 0024): a permit is bound to ONE approved call. Replays, other arguments, other workspaces, other runner groups and
 * a credential that must stay inside the Governor are the cases that would turn an approval into general authority.
 */
let world: EffectsWorld | undefined;
afterEach(() => { delete fixtureGate.hold; });
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

const toolDigest = (id: string): string => sha256Digest(new TextEncoder().encode(fixtureStarter().documents.find((doc) => doc.path === `config/${id}.yaml`)!.text));

/** Starts an attempt that does nothing and stays alive, so a test can speak to the Governor as that attempt's runner. */
async function liveAttempt(w: EffectsWorld, key: string): Promise<{ attemptId: string; finish: () => Promise<void> }> {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let entered!: (attemptId: string) => void;
  const enteredAttempt = new Promise<string>((resolve) => { entered = resolve; });
  fixtureGate.hold = async (attemptId) => { entered(attemptId); await opened; };
  await w.dispatch(key, []);
  const running = w.run();
  const attemptId = await enteredAttempt;
  return { attemptId, finish: async () => { open(); await running; } };
}

const call = (container: string, id = "host.restart", input: Record<string, unknown> = { container }) => ({ proposalId: `proposal-${container}-${id}`, tool: { id, digest: toolDigest(id) }, input });

describe("a permit belongs to one call", () => {
  it("cannot be replayed, restarted at the launcher, or used with other arguments", async () => {
    world = await effectsWorld({ containers: ["demo-app", "other-app"] });
    const w = world;
    const attempt = await liveAttempt(w, "sec-1");
    const proposed = w.w.brain.requestEffect(w.runner, attempt.attemptId, call("demo-app")) as unknown as { approvalId: string; state: string };
    expect(proposed.state).toBe("pending");
    // Asking again for the same proposal gives the same approval, not a second one.
    expect((w.w.brain.requestEffect(w.runner, attempt.attemptId, call("demo-app")) as unknown as { approvalId: string }).approvalId).toBe(proposed.approvalId);
    // No permit while the owner has not decided.
    expect(() => w.w.brain.issueEffectPermit(w.runner, attempt.attemptId, call("demo-app"))).toThrow(/pending/);
    const approval = w.store.control.prepare("SELECT id, subject_digest, version FROM approval_requests WHERE id=?").get(proposed.approvalId) as { id: string; subject_digest: string; version: number };
    await w.decide(approval, "approve");
    // The approval names these arguments: another container gets no permit and consumes nothing.
    expect(() => w.w.brain.issueEffectPermit(w.runner, attempt.attemptId, { ...call("demo-app"), input: { container: "other-app" } })).toThrow(/arguments differ/);
    expect(() => w.w.brain.issueEffectPermit(w.runner, attempt.attemptId, { ...call("demo-app"), tool: { id: "host.reload", digest: toolDigest("host.reload") } })).toThrow();
    expect(w.permits()).toEqual([]);
    const permit = w.w.brain.issueEffectPermit(w.runner, attempt.attemptId, call("demo-app")) as unknown as { token: string; invocationId: string };
    // Starting with other arguments is refused too, and leaves the permit unused.
    expect(() => w.w.brain.startEffect(w.runner, attempt.attemptId, { ...call("demo-app"), input: { container: "other-app" }, token: permit.token })).toThrow(/arguments differ/);
    expect(() => w.w.brain.startEffect(w.runner, attempt.attemptId, { ...call("demo-app"), token: "forged" })).toThrow();
    expect(w.permits()[0]!.state).toBe("issued");
    w.w.brain.startEffect(w.runner, attempt.attemptId, { ...call("demo-app"), token: permit.token });
    // The permit is spent: starting again, asking for it again, or presenting it for another call all fail.
    expect(() => w.w.brain.startEffect(w.runner, attempt.attemptId, { ...call("demo-app"), token: permit.token })).toThrow(/already used/);
    expect(() => w.w.brain.issueEffectPermit(w.runner, attempt.attemptId, call("demo-app"))).toThrow(/already used/);
    expect(w.w.brain.validatePermit(permit.token, "inv-someone-else")).toBe(false);
    // The launcher itself runs a privileged invocation once, even if the runner (or an attacker with the socket token) asks again.
    const { LauncherClient } = await import("../../apps/runner/src/launcher-client");
    const launcher = new LauncherClient(w.socket);
    await launcher.hostCommand("docker.restart", { container: "demo-app" }, "privileged", permit.invocationId);
    await expect(launcher.hostCommand("docker.restart", { container: "demo-app" }, "privileged", permit.invocationId)).rejects.toThrow(/already ran/);
    await expect(launcher.hostCommand("docker.restart", { container: "demo-app" }, "privileged")).rejects.toThrow(/invocationId/);
    expect(w.restarts()).toEqual(["restarted demo-app"]);
    await attempt.finish();
  }, scaled(120_000));

  it("is refused for a container the owner did not allow, before anyone is asked", async () => {
    const w = world!;
    const attempt = await liveAttempt(w, "sec-2");
    const approvalsBefore = (w.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() as { n: number }).n;
    expect(() => w.w.brain.requestEffect(w.runner, attempt.attemptId, call("secrets-vault"))).toThrow(/allow-list/);
    expect(() => w.w.brain.requestEffect(w.runner, attempt.attemptId, call("../etc", "host.restart", { container: "../etc" }))).toThrow(/container name/);
    expect(() => w.w.brain.requestEffect(w.runner, attempt.attemptId, call("demo-app", "host.restart", { container: "demo-app; rm -rf /" }))).toThrow();
    // A tool the agent was not given, or the wrong digest of one it was given, gets nothing either.
    expect(() => w.w.brain.requestEffect(w.runner, attempt.attemptId, { ...call("demo-app"), tool: { id: "host.restart", digest: toolDigest("host.reload") } })).toThrow(/does not allow/);
    expect(() => w.w.brain.requestEffect(w.runner, attempt.attemptId, { proposalId: "p-read", tool: { id: "host.exec", digest: toolDigest("host.exec") }, input: { command: "docker.ps" } })).toThrow(/not an effect tool/);
    expect((w.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() as { n: number }).n).toBe(approvalsBefore);
    await attempt.finish();
  }, scaled(120_000));

  it("works for another attempt of the same job only through its own approval", async () => {
    const w = world!;
    const first = await liveAttempt(w, "sec-3");
    const proposed = w.w.brain.requestEffect(w.runner, first.attemptId, call("demo-app")) as unknown as { approvalId: string };
    const approval = w.store.control.prepare("SELECT id, subject_digest, version FROM approval_requests WHERE id=?").get(proposed.approvalId) as { id: string; subject_digest: string; version: number };
    await w.decide(approval, "approve");
    await first.finish();
    // A later attempt cannot use the earlier attempt's approval, even naming the same proposal.
    const second = await liveAttempt(w, "sec-4");
    expect(() => w.w.brain.issueEffectPermit(w.runner, second.attemptId, call("demo-app"))).toThrow(/never proposed/);
    await second.finish();
  }, scaled(120_000));
});

describe("host tools exist only for the workspace the owner set a runner group aside for", () => {
  it("never offers a host group's jobs to other workspaces, and refuses a host call from a runner that lost the group", async () => {
    const w = world!;
    w.w.brain.createWorkspace(w.w.owner, { workspaceId: "ws-other", slug: "other" });
    await w.command("workflow.dispatch", "other-ws", { workflow: { id: "sre-task", digest: w.release.digest }, input: { situation: "Look at the host\nAcceptance criteria:\n1. Says what was checked" } }, "ws-other");
    // The host group's runner is bound to ws-test only: the other workspace's job is never offered to it.
    expect(await w.run()).toBe(false);
    expect((w.store.control.prepare("SELECT state FROM jobs WHERE workspace_id='ws-other'").get() as { state: string }).state).toBe("queued");
    // A runner whose group stops being a host group for this workspace cannot ask for a host change.
    const attempt = await liveAttempt(w, "sec-5");
    await w.command("runnerGroup.set", "group-off", { groupId: w.group, hostTools: false, workspaceIds: [w.w.workspaceId] });
    expect(() => w.w.brain.requestEffect(w.runner, attempt.attemptId, call("demo-app"))).toThrow(/host tools run only on the runner group/);
    await attempt.finish();
  }, scaled(120_000));
});

describe("Try this tool does not bypass the host group", () => {
  it("runs a host tool only on the workspace's host group and refuses where there is none", async () => {
    const w = world!;
    await w.command("runnerGroup.set", "group-try", { groupId: w.group, hostTools: true, workspaceIds: [w.w.workspaceId] });
    const { testId } = w.w.brain.toolTests.run(w.w.owner, w.w.workspaceId, "host.exec", { command: "docker.ps" });
    const placement = JSON.parse((w.store.control.prepare("SELECT placement_json FROM jobs ORDER BY rowid DESC LIMIT 1").get() as { placement_json: string }).placement_json) as { group: string };
    expect(placement.group).toBe(w.group);
    expect(await w.run()).toBe(true);
    const view = w.w.brain.toolTests.list(w.w.owner, w.w.workspaceId, "host.exec", 5).find((entry) => entry.testId === testId)!;
    expect(view.state).toBe("succeeded");
    expect(JSON.stringify(view.output)).toContain("demo-app");
    try { w.w.brain.createWorkspace(w.w.owner, { workspaceId: "ws-other", slug: "other" }); } catch { /* created by an earlier case */ }
    expect(() => w.w.brain.toolTests.run(w.w.owner, "ws-other", "host.exec", { command: "docker.ps" })).toThrow(/runner group the owner set aside/);
  }, scaled(120_000));
});

describe("credentials stay in the Governor", () => {
  it("never reaches events, approvals, receipts or the model's answer when a ticket is created", async () => {
    const w = world!;
    await w.command("runnerGroup.set", "group-on", { groupId: w.group, hostTools: true, workspaceIds: [w.w.workspaceId] });
    const secret = "tkt-secret-token-0123456789";
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers["authorization"] ?? ""));
      req.resume();
      req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "OPS-42", url: "https://tickets.example/OPS-42", echo: secret })); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      w.w.brain.connectorsOverride = { tickets: new WebhookTicketAdapter({ url: `http://127.0.0.1:${port}/tickets`, token: secret }) };
      await w.dispatch("sec-6", [{ id: "ticket.create", input: { title: "demo-app keeps restarting", description: "Found unhealthy", priority: "high" } }]);
      const running = w.run();
      const approval = await w.pendingApproval();
      await w.decide(approval, "approve");
      expect(await running).toBe(true);
      // The adapter used the credential...
      expect(seen).toEqual([`Bearer ${secret}`]);
      // ...and nothing the model, the owner or the evidence can read contains it.
      const dump = JSON.stringify([
        w.store.control.prepare("SELECT event_json FROM attempt_events").all(), w.store.control.prepare("SELECT subject_json FROM approval_requests").all(),
        w.store.control.prepare("SELECT payload_json FROM events").all(), w.store.control.prepare("SELECT output_json FROM job_outputs").all(),
        w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT manifest_json FROM evidence_bundles").all(),
      ]);
      expect(dump).not.toContain(secret);
      expect(dump).toContain("OPS-42");
      expect(w.permits().at(-1)!.state).toBe("applied");
    } finally { server.close(); w.w.brain.connectorsOverride = undefined; }
  }, scaled(120_000));
});
