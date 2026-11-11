import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { notifyAttention, type Sender } from "../../apps/governor/src/modules/operations/index";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
let server: Server | undefined;
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
const saved = { url: process.env["BRAIN_NOTIFY_WEBHOOK_URL"], secret: process.env["BRAIN_NOTIFY_WEBHOOK_SECRET"], base: process.env["BRAIN_BASE_URL"] };

beforeEach(() => { received.length = 0; });
afterEach(async () => {
  for (const w of worlds.splice(0)) w.brain.close();
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  for (const [key, value] of [["BRAIN_NOTIFY_WEBHOOK_URL", saved.url], ["BRAIN_NOTIFY_WEBHOOK_SECRET", saved.secret], ["BRAIN_BASE_URL", saved.base]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function webhook(secret?: string): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") }); response.writeHead(204).end(); });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  process.env["BRAIN_NOTIFY_WEBHOOK_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  if (secret) process.env["BRAIN_NOTIFY_WEBHOOK_SECRET"] = secret; else delete process.env["BRAIN_NOTIFY_WEBHOOK_SECRET"];
  process.env["BRAIN_BASE_URL"] = "https://brain.example.test";
}
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
}
const task = (id: string): PlanTask => ({ id, title: `Secret plan ${id}`, criteria: [`${id}-done`], dependsOn: [] });
async function mission(w: World, key: string, tasks: PlanTask[]): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: `Confidential launch ${key}`, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: Mission }).snapshot.version;
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, version);
  return id;
}
const finish = async (w: World, missionId: string, planTaskId: string) => {
  const item = (await workView(w)).items.find((entry: WorkItem) => entry.missionId === missionId && entry.planTaskId === planTaskId)!;
  w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE work_items SET state='done', evidence_digest=?, updated_at_ms=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, w.brain.store.now(), item.workItemId);
};

describe("notification channels, preferences and digest (#53, ADR 0011)", () => {
  it("defaults keep today's behaviour: push on, no webhook, no digest, no email; a webhook cannot be switched on without server configuration", async () => {
    const w = setupWorld(); worlds.push(w);
    delete process.env["BRAIN_NOTIFY_WEBHOOK_URL"];
    expect(w.brain.notificationPreferences(w.owner)).toEqual({ preferences: { push: true, webhook: false, digest: false }, available: { inApp: true, push: true, webhook: false, email: false } });
    expect(() => w.brain.setNotificationPreferences(w.owner, { webhook: true })).toThrow(/no webhook configured/u);
    expect(() => w.brain.setNotificationPreferences(w.owner, { push: "yes" })).toThrow(/true or false/u);
    expect(() => w.brain.setNotificationPreferences({ ...w.owner, kind: "agent" }, { push: false })).toThrow(/belong to a person/u);
    const id = await mission(w, "defaults", [task("a")]);
    await finish(w, id, "a");
    const calls: Array<{ channels: { push: boolean; webhook: boolean }; kind: string }> = [];
    const spy: Sender = async (_org, _principal, message, channels) => { calls.push({ channels, kind: message.kind }); return 1; };
    expect(notifyAttention(w.brain.store, spy)).toBe(1);
    await quiet();
    expect(calls).toEqual([{ channels: { push: true, webhook: false }, kind: "result-ready" }]);
    // Switching push off keeps the in-app record and sends nothing outbound.
    w.brain.setNotificationPreferences(w.owner, { push: false });
    const other = await mission(w, "off", [task("b")]);
    await finish(w, other, "b");
    calls.length = 0;
    expect(notifyAttention(w.brain.store, spy)).toBe(1);
    await quiet();
    expect(calls).toEqual([]);
    const inbox = ((await w.brain.executeQuery(w.owner, { queryType: "notifications.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Array<{ pushed: boolean }> } }).snapshot.items;
    expect(inbox).toHaveLength(2);
    expect(inbox.map((entry) => entry.pushed).sort()).toEqual([false, true]);
  });

  it("a webhook delivers a link-only, signed body with no title, token or secret, and is a no-op when unconfigured", async () => {
    const w = setupWorld(); worlds.push(w);
    await webhook("shared-signing-secret");
    expect(w.brain.setNotificationPreferences(w.owner, { webhook: true, push: false }).preferences).toMatchObject({ webhook: true, push: false });
    const id = await mission(w, "hook", [task("a")]);
    await finish(w, id, "a");
    expect(w.brain.notifyAttention()).toBe(1);
    await until(() => received.length === 1);
    const body = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["kind", "link", "text", "type"]);
    expect(body).toMatchObject({ type: "brain.notification", kind: "result-ready" });
    expect(String(body["link"])).toMatch(/^https:\/\/brain\.example\.test\/missions\/.+\/outputs\?w=ws-test/u);
    expect(received[0]!.body).not.toMatch(/Confidential|Secret plan|Result ready:|owner-1|sha256:|token|password|secret/iu);
    expect(received[0]!.headers["x-brain-signature"]).toBe(`sha256=${createHmac("sha256", "shared-signing-secret").update(received[0]!.body).digest("hex")}`);
    expect(received[0]!.headers["authorization"]).toBeUndefined();
    expect(received[0]!.headers["cookie"]).toBeUndefined();

    // Unconfigured: the preference stays on the record but nothing is called and nothing breaks.
    delete process.env["BRAIN_NOTIFY_WEBHOOK_URL"];
    received.length = 0;
    const other = await mission(w, "nohook", [task("b")]);
    await finish(w, other, "b");
    expect(w.brain.notifyAttention()).toBe(1);
    await quiet();
    expect(received).toEqual([]);
    expect(w.brain.notificationPreferences(w.owner).available.webhook).toBe(false);
  });

  it("the digest batches only non-urgent items; a blocking item and an approval go out at once, past the throttle", async () => {
    const w = setupWorld(); worlds.push(w);
    await webhook();
    w.brain.setNotificationPreferences(w.owner, { webhook: true, push: false, digest: true });
    const id = await mission(w, "digest", [task("a"), task("b"), task("c")]);
    await finish(w, id, "a");
    expect(w.brain.notifyAttention()).toBe(1);
    await quiet();
    // The result is in the in-app inbox at once but held back from the channels.
    expect(received).toEqual([]);
    // A blocking item right after still goes out immediately (parked work).
    const parked = (await workView(w)).items.find((entry: WorkItem) => entry.missionId === id && entry.planTaskId === "c")!;
    for (const runId of ["d1", "d2", "d3"]) {
      w.brain.missions.linkExecution(w.owner, w.workspaceId, parked.workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `tests failed in ${runId}`);
    }
    expect(w.brain.notifyAttention()).toBe(1);
    await until(() => received.length === 1);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ kind: "parked" });
    // Not yet a day since the digest was switched on: nothing is sent.
    expect(w.brain.notifyDigests()).toBe(0);
    // A day later, one digest for what arrived, with a count and a link to Today and no titles.
    w.brain.store.control.prepare("UPDATE notification_preferences SET digest_last_ms=digest_last_ms-?").run(25 * 3_600_000);
    received.length = 0;
    expect(w.brain.notifyDigests()).toBe(1);
    await until(() => received.length === 1);
    const digest = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(digest).toMatchObject({ kind: "digest", count: 1, type: "brain.notification" });
    expect(String(digest["link"])).toBe("https://brain.example.test/w/ws-test/today");
    expect(received[0]!.body).not.toMatch(/Confidential|Secret plan/u);
    // Once sent, the same window is never sent twice.
    expect(w.brain.notifyDigests()).toBe(0);

    // An approval request reaches an approver at once even with the digest on, and carries only a link to the approvals list.
    const approver = await w.grantApprover("approver-1");
    w.brain.setNotificationPreferences(approver.actor, { webhook: true, push: false, digest: true });
    received.length = 0;
    (w.brain as unknown as { notifyApprovers(input: { organizationId: string; workspaceId: string }): void }).notifyApprovers({ organizationId: w.org, workspaceId: w.workspaceId });
    // Every approver with the webhook on (the workspace lead and this approver), digest or not.
    await until(() => received.length >= 2);
    for (const call of received) expect(JSON.parse(call.body)).toMatchObject({ kind: "approval", link: "https://brain.example.test/approvals" });
  });
});
