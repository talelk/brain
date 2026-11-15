import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { scaled } from "../support/timing";

// Spec #90 ticket #123: `start <play>` in the signed chat hook starts a mission as the member the chat identity is linked to. The
// link is made by an administrator through a command; the mission goes through the ordinary mission.create funnel (role, queue limit,
// budget admission), is idempotent per chat message, and chat never confirms the plan. State is reached through commands only.
const tmp = process.env["TMPDIR"] ?? "/tmp";
const SECRET = "inbound-secret-0123456789";
const keys = ["BRAIN_INBOUND_WEBHOOK_SECRET", "BRAIN_BASE_URL"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const apps: Array<{ brain: { close(): void } }> = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.brain.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

async function run(w: TestWorld, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, opts: { workspaceId?: string; expectedVersion?: number } = {}): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: opts.workspaceId ?? w.workspaceId, idempotencyKey: key,
    ...(opts.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id} is written up`], dependsOn: [] });

async function chatWorld() {
  const root = mkdtempSync(join(tmp, "brain-chat-start-")); roots.push(root);
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  apps.push(app);
  const w = setupWorld(app.brain);
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  process.env["BRAIN_INBOUND_WEBHOOK_SECRET"] = SECRET;
  process.env["BRAIN_BASE_URL"] = "https://brain.example.test";
  const store = w.brain.store;
  const member = (principalId: string, role: string) => {
    seedHuman(w.brain, w.org, principalId);
    store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, ?, ?, 1, 'owner-1', ?)").run(w.workspaceId, w.org, principalId, role, store.now());
    return principalId;
  };
  const link = (provider: string, chatUserId: string, principalId: string) => run(w, w.owner, "chatIdentity.set", `link-${provider}-${chatUserId}-${principalId}`, { provider, chatUserId, principalId });
  const post = async (text: string, options: { secret?: string; ageSeconds?: number; id?: string; user?: string } = {}) => {
    const timestamp = Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0);
    const body = JSON.stringify({ id: options.id ?? `evt-${Math.random()}`, user: options.user ?? "U-ana", text });
    const signature = `sha256=${createHmac("sha256", options.secret ?? SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
    const response = await app.fetch(new Request("http://x/hooks/chat", { method: "POST", headers: { "content-type": "application/json", "x-brain-timestamp": String(timestamp), "x-brain-signature": signature }, body }));
    return { status: response.status, json: await response.json() as { text?: string; error?: string } };
  };
  const slack = async (text: string, userId: string, triggerId: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({ text, user_id: userId, user_name: "ana.display", trigger_id: triggerId }).toString();
    const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const response = await app.fetch(new Request("http://x/hooks/chat", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signature }, body }));
    return { status: response.status, json: await response.json() as { text?: string } };
  };
  const missions = async () => ((await w.brain.executeQuery(w.owner, { queryType: "missions.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Mission[] } }).snapshot.items;
  const queued = () => (store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id=? AND state='queued'").get(w.workspaceId) as { n: number }).n;
  return { w, post, slack, link, member, missions, queued };
}

describe("start a mission from chat (spec #90, ticket #123)", () => {
  it("refuses a chat user nobody linked, with a clear reply, and creates nothing", async () => {
    const { post, missions } = await chatWorld();
    const answer = await post("start research-and-write");
    expect(answer.status).toBe(200);
    expect(answer.json.text).toContain("not linked to a Brain member");
    expect(answer.json.text).toContain("U-ana");
    expect(await missions()).toHaveLength(0);
  }, scaled(60_000));

  it("starts the mission as the linked member, links to it, and leaves the plan waiting in Needs you", async () => {
    const { w, post, link, member, missions } = await chatWorld();
    const ana = member("ana", "operator");
    expect((await link("brain", "U-ana", ana)).accepted).toBe(true);
    const answer = await post("start research-and-write Compare two vendors", { id: "evt-start-1" });
    expect(answer.status).toBe(200);
    const [mission] = await missions();
    expect(mission).toBeDefined();
    expect(answer.json.text).toContain(`https://brain.example.test/missions/${mission!.missionId}/plan?w=${w.workspaceId}`);
    expect(answer.json.text).toContain("waits for you in Needs you");
    expect(mission!.title).toBe("Compare two vendors");
    // The member owns it: the mission carries the person's authority, not the hook's.
    expect(mission!.ownerId).toBe(ana);
    expect(mission!.pendingPlanVersionId).toBeDefined();
    expect(mission!.activePlanVersionId).toBeUndefined();
    // Chat confirmed nothing: the plan is only proposed, and it is on ana's Needs you list.
    const attention = (await w.brain.executeQuery(w.actor(ana, w.workspaceId), { queryType: "attention.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Array<{ kind: string; missionId?: string }> } };
    expect(attention.snapshot.items.some((item) => item.kind === "plan-proposal" && item.missionId === mission!.missionId)).toBe(true);
    expect((await post(`approve apr_none`)).json.text).toContain("No pending approval");
  }, scaled(60_000));

  it("answers a Slack slash command through the linked Slack user id, and a repeated message starts nothing twice", async () => {
    const { w, slack, link, member, missions } = await chatWorld();
    const ana = member("ana", "operator");
    await link("slack", "U024ANA", ana);
    // A Brain-scheme identity of the same name is a different identity: the link is per provider.
    const first = await slack("start research-and-write", "U024ANA", "trigger-1");
    expect(first.json.text).toContain("Started");
    const again = await slack("start research-and-write", "U024ANA", "trigger-1");
    expect(again.json.text).toBe(first.json.text);
    expect(await missions()).toHaveLength(1);
    // A new message is a new mission.
    await slack("start research-and-write", "U024ANA", "trigger-2");
    expect(await missions()).toHaveLength(2);
    expect((await slack("start research-and-write", "U024OTHER", "trigger-3")).json.text).toContain("not linked");
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM chat_identities").get()).toEqual({ n: 1 });
  }, scaled(60_000));

  it("repeats the same Brain-scheme message to the same single mission", async () => {
    const { post, link, member, missions } = await chatWorld();
    await link("brain", "U-ana", member("ana", "operator"));
    const first = await post("start research-and-write", { id: "evt-same" });
    const second = await post("start research-and-write", { id: "evt-same" });
    expect(second.json.text).toBe(first.json.text);
    expect(await missions()).toHaveLength(1);
  }, scaled(60_000));

  it("is refused by the workspace queue limit like any person's start, and by the member's role", async () => {
    const { w, post, link, member, missions, queued } = await chatWorld();
    await link("brain", "U-ana", member("ana", "operator"));
    await link("brain", "U-vic", member("vic", "viewer"));
    // The same queue limit that refuses a person's Start: one task already waits for a runner.
    expect((await run(w, w.owner, "workspace.queueLimit.set", "limit-1", { maxQueued: 1 })).accepted).toBe(true);
    const queuedMission = (await run(w, w.owner, "mission.create", "m1-create", { title: "Queued", intent: "Deliver", successCriteria: ["delivered"] })).resourceId ?? "";
    const planId = (await run(w, w.owner, "plan.propose", "m1-plan", { missionId: queuedMission, origin: "manual", tasks: [task("t")] })).resourceId ?? "";
    const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: queuedMission })) as unknown as { snapshot: Mission }).snapshot.version;
    await run(w, w.owner, "plan.confirm", "m1-confirm", { planVersionId: planId }, { expectedVersion: version });
    const deadline = Date.now() + 15_000;
    while (queued() < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const before = (await missions()).length;
    const refused = await post("start research-and-write");
    expect(refused.json.text).toMatch(/Nothing was started: .*queue limit \(1\)/su);
    expect((await missions()).length).toBe(before);
    // A viewer cannot start missions in any workspace, whatever the queue.
    expect((await post("start research-and-write", { user: "U-vic" })).json.text).toContain("cannot start missions in any workspace");
    expect((await missions()).length).toBe(before);
  }, scaled(60_000));

  it("names the Plays when the Play is missing or unknown, and the workspace when it is ambiguous", async () => {
    const { w, post, link, member } = await chatWorld();
    const ana = member("ana", "operator");
    await link("brain", "U-ana", ana);
    expect((await post("start")).json.text).toMatch(/Say which Play.*research-and-write/su);
    expect((await post("start no-such-play")).json.text).toContain('No Play is named "no-such-play"');
    expect((await post("start research-and-write in elsewhere")).json.text).toContain('cannot start missions in "elsewhere"');
    expect((await post("start research-and-write in test Weekly numbers")).json.text).toContain('Started "Weekly numbers"');
    expect(w.brain.store.control.prepare("SELECT slug FROM workspaces WHERE id=?").get(w.workspaceId)).toEqual({ slug: "test" });
  }, scaled(60_000));

  it("keeps the signature and replay rules: a bad signature, a stale request and a changed body start nothing", async () => {
    const { post, link, member, missions } = await chatWorld();
    await link("brain", "U-ana", member("ana", "operator"));
    expect((await post("start research-and-write", { secret: "another-secret-0123456789" })).status).toBe(401);
    expect((await post("start research-and-write", { ageSeconds: 3600 })).status).toBe(401);
    expect(await missions()).toHaveLength(0);
  }, scaled(60_000));

  it("lets only an identity administrator link people, only to real members, and an unlinked or suspended member loses chat", async () => {
    const { w, post, link, member, missions } = await chatWorld();
    const ana = member("ana", "operator");
    const own = await w.brain.executeCommand(w.actor(ana, w.workspaceId), { contractVersion: "brain.command/v1", commandId: "c-self", commandType: "chatIdentity.set", workspaceId: w.workspaceId, idempotencyKey: "self", payload: { provider: "brain", chatUserId: "U-ana", principalId: ana } } as never, "self").catch((error: unknown) => error);
    expect(own).toMatchObject({ code: "FORBIDDEN" });
    await expect(link("brain", "U-ghost", "nobody-here")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await link("brain", "U-ana", ana)).accepted).toBe(true);
    const listed = (await w.brain.executeQuery(w.owner, { queryType: "chatIdentities.list" })) as unknown as { snapshot: { identities: Array<{ provider: string; chatUserId: string; principalId: string; active: boolean }> } };
    expect(listed.snapshot.identities).toMatchObject([{ provider: "brain", chatUserId: "U-ana", principalId: ana, active: true }]);
    await expect(w.brain.executeQuery(w.actor(ana), { queryType: "chatIdentities.list" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Suspending the member (an organization command) ends what chat may do for them, though the link stays listed.
    w.brain.store.control.prepare("UPDATE principals SET disabled_at_ms=? WHERE id=? AND organization_id=?").run(w.brain.store.now(), ana, w.org);
    expect((await post("start research-and-write")).json.text).toContain("not linked");
    w.brain.store.control.prepare("UPDATE principals SET disabled_at_ms=NULL WHERE id=? AND organization_id=?").run(ana, w.org);
    expect((await post("start research-and-write", { id: "evt-after" })).json.text).toContain("Started");
    expect((await run(w, w.owner, "chatIdentity.remove", "unlink", { provider: "brain", chatUserId: "U-ana" })).accepted).toBe(true);
    expect((await post("start research-and-write")).json.text).toContain("not linked");
    expect(await missions()).toHaveLength(1);
  }, scaled(60_000));
});
