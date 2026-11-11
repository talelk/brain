import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { sendMail, smtpTarget } from "../../apps/governor/src/modules/operations/index";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
const servers: FakeSmtp[] = [];
const keys = ["BRAIN_NOTIFY_SMTP_URL", "BRAIN_NOTIFY_FROM", "BRAIN_BASE_URL", "BRAIN_NOTIFY_EMAIL_PER_HOUR", "BRAIN_NOTIFY_WEBHOOK_URL"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const w of worlds.splice(0)) w.brain.close();
  for (const s of servers.splice(0)) await s.close();
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

async function configure(server: FakeSmtp, credentials = "user:p%40ss"): Promise<void> {
  servers.push(server);
  process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://${credentials}@127.0.0.1:${server.port}`;
  process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
  process.env["BRAIN_BASE_URL"] = "https://brain.example.test";
  delete process.env["BRAIN_NOTIFY_WEBHOOK_URL"];
}
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

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
const park = async (w: World, missionId: string, planTaskId: string) => {
  const parked = (await workView(w)).items.find((entry: WorkItem) => entry.missionId === missionId && entry.planTaskId === planTaskId)!;
  for (const runId of [`${planTaskId}1`, `${planTaskId}2`, `${planTaskId}3`]) {
    w.brain.missions.linkExecution(w.owner, w.workspaceId, parked.workItemId, runId);
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `tests failed in ${runId}`);
  }
};

describe("email transport for notifications (ADR 0011 amendment)", () => {
  it("is a no-op when unset: the preferences say it is not configured and it cannot be switched on", async () => {
    const w = setupWorld(); worlds.push(w);
    for (const key of keys) delete process.env[key];
    expect(smtpTarget()).toBeUndefined();
    expect(w.brain.notificationPreferences(w.owner)).toMatchObject({ preferences: { email: false }, available: { email: false } });
    expect(() => w.brain.setNotificationPreferences(w.owner, { email: true })).toThrow(/Email is not configured on this server/u);
    process.env["BRAIN_NOTIFY_SMTP_URL"] = "smtp://127.0.0.1:2525";
    expect(smtpTarget()).toBeUndefined(); // no sender address
    process.env["BRAIN_NOTIFY_FROM"] = "not an address";
    expect(smtpTarget()).toBeUndefined();
    process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
    process.env["BRAIN_NOTIFY_SMTP_URL"] = "http://127.0.0.1:2525";
    expect(smtpTarget()).toBeUndefined();
    const id = await mission(w, "noop", [task("a")]);
    await finish(w, id, "a");
    expect(w.brain.notifyAttention()).toBe(1);
    expect(w.brain.notificationPreferences(w.owner).emailDeliveries).toEqual([]);
  });

  it("sends a blocking item at once to a person who opted in, and a result only in the daily digest when that is on", async () => {
    const w = setupWorld(); worlds.push(w);
    const smtp = await startFakeSmtp({ auth: "plain", user: "user", password: "p@ss" });
    await configure(smtp);
    w.brain.setNotificationPreferences(w.owner, { email: true, push: false, digest: true });
    expect(w.brain.notificationPreferences(w.owner)).toMatchObject({ preferences: { email: true, digest: true }, available: { email: true } });
    const id = await mission(w, "mail", [task("a"), task("c")]);
    await finish(w, id, "a");
    expect(w.brain.notifyAttention()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(smtp.messages).toEqual([]); // the result waits for the digest
    await park(w, id, "c");
    expect(w.brain.notifyAttention()).toBe(1);
    await until(() => smtp.messages.length === 1);
    const blocking = smtp.messages[0]!;
    expect(blocking).toMatchObject({ from: "brain@example.test", to: "owner-1@fixture.test", authenticated: true });
    expect(blocking.data).toContain("Subject: Brain: something needs you");
    expect(blocking.data).toMatch(/https:\/\/brain\.example\.test\/missions\/.+\/live\?w=ws-test/u);
    w.brain.store.control.prepare("UPDATE notification_preferences SET digest_last_ms=digest_last_ms-?").run(25 * 3_600_000);
    expect(w.brain.notifyDigests()).toBe(1);
    await until(() => smtp.messages.length === 2);
    expect(smtp.messages[1]!.data).toContain("Subject: Brain: results are ready");
    expect(smtp.messages[1]!.data).toContain("1 result is ready.");
    expect(smtp.messages[1]!.data).toContain("https://brain.example.test/w/ws-test/today");
    await until(() => w.brain.notificationPreferences(w.owner).emailDeliveries.length === 2);
    expect(w.brain.notificationPreferences(w.owner).emailDeliveries.map((d) => [d.kind, d.status]).sort()).toEqual([["digest", "sent"], ["needs-attention", "sent"]]);
    // Nothing a person typed and no credential is in any mail (security: also covered in tests/security).
    for (const message of smtp.messages) expect(message.data).not.toMatch(/Confidential|Secret plan|p@ss|p%40ss|sha256:|token/iu);
    expect(smtp.commands.join("\n")).not.toContain("p@ss");
  });

  it("without the opt-in nothing is sent, and a person's address is not needed to switch it off", async () => {
    const w = setupWorld(); worlds.push(w);
    const smtp = await startFakeSmtp();
    await configure(smtp, "");
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://127.0.0.1:${smtp.port}`;
    const id = await mission(w, "optout", [task("a")]);
    await finish(w, id, "a");
    expect(w.brain.notifyAttention()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(smtp.connections()).toBe(0);
  });

  it("records a refusal by the mail server as failed with the reason, and the in-app record stays", async () => {
    const w = setupWorld(); worlds.push(w);
    const smtp = await startFakeSmtp({ rcptReply: "550 5.1.1 mailbox unavailable" });
    await configure(smtp, "");
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://127.0.0.1:${smtp.port}`;
    w.brain.setNotificationPreferences(w.owner, { email: true, push: false });
    const id = await mission(w, "fail", [task("a")]);
    await finish(w, id, "a");
    expect(w.brain.notifyAttention()).toBe(1);
    await until(() => w.brain.notificationPreferences(w.owner).emailDeliveries.length === 1);
    const [delivery] = w.brain.notificationPreferences(w.owner).emailDeliveries;
    expect(delivery).toMatchObject({ kind: "result-ready", status: "failed" });
    expect(delivery!.reason).toMatch(/recipient refused: 550/u);
    expect(smtp.messages).toEqual([]);
    const inbox = ((await w.brain.executeQuery(w.owner, { queryType: "notifications.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: unknown[] } }).snapshot.items;
    expect(inbox).toHaveLength(1);
  });

  it("an unreachable mail server is a recorded failure, not a crash", async () => {
    const w = setupWorld(); worlds.push(w);
    const smtp = await startFakeSmtp();
    const port = smtp.port;
    await smtp.close();
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://127.0.0.1:${port}`;
    process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
    w.brain.setNotificationPreferences(w.owner, { email: true, push: false });
    const id = await mission(w, "down", [task("a")]);
    await finish(w, id, "a");
    expect(w.brain.notifyAttention()).toBe(1);
    await until(() => w.brain.notificationPreferences(w.owner).emailDeliveries.length === 1);
    expect(w.brain.notificationPreferences(w.owner).emailDeliveries[0]).toMatchObject({ status: "failed" });
  });

  it("rate limits a person per hour, records the refusal, and sends again once the hour has passed", async () => {
    const w = setupWorld(); worlds.push(w);
    const smtp = await startFakeSmtp();
    await configure(smtp, "");
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://127.0.0.1:${smtp.port}`;
    process.env["BRAIN_NOTIFY_EMAIL_PER_HOUR"] = "2";
    w.brain.setNotificationPreferences(w.owner, { email: true, push: false });
    const approve = () => (w.brain as unknown as { notifyApprovers(input: { organizationId: string; workspaceId: string }): void }).notifyApprovers({ organizationId: w.org, workspaceId: w.workspaceId });
    for (let i = 0; i < 4; i++) { approve(); await new Promise((resolve) => setTimeout(resolve, 80)); }
    await until(() => w.brain.notificationPreferences(w.owner).emailDeliveries.length === 4);
    expect(smtp.messages).toHaveLength(2);
    const view = w.brain.notificationPreferences(w.owner).emailDeliveries;
    expect(view.filter((d) => d.status === "failed").map((d) => d.reason)).toEqual([expect.stringMatching(/^rate limited/u), expect.stringMatching(/^rate limited/u)]);
    w.brain.store.control.prepare("UPDATE email_deliveries SET at_ms=at_ms-?").run(2 * 3_600_000);
    approve();
    await until(() => smtp.messages.length === 3);
  });
});

describe("the SMTP client", () => {
  const target = (smtp: FakeSmtp, extra: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port: smtp.port, implicitTls: false, from: "brain@example.test", ca: smtp.ca, ...extra });
  const mail = { to: "person@example.test", subject: "Hello", text: "line one\n.dot line\nlast" };

  it("upgrades with STARTTLS before it sends credentials, and dot-stuffs the body", async () => {
    const smtp = await startFakeSmtp({ starttls: true, auth: "plain", user: "u", password: "pw" }); servers.push(smtp);
    await sendMail(target(smtp, { user: "u", password: "pw" }), mail);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toMatchObject({ encrypted: true, authenticated: true, to: "person@example.test" });
    expect(smtp.messages[0]!.data).toContain("\r\n.dot line\r\n");
    expect(smtp.commands.indexOf("STARTTLS")).toBeLessThan(smtp.commands.indexOf("AUTH PLAIN <redacted>"));
  });

  it("speaks implicit TLS (smtps) and AUTH LOGIN", async () => {
    const smtp = await startFakeSmtp({ implicitTls: true, auth: "login", user: "u", password: "pw" }); servers.push(smtp);
    await sendMail(target(smtp, { implicitTls: true, user: "u", password: "pw" }), mail);
    expect(smtp.messages[0]).toMatchObject({ encrypted: true, authenticated: true });
  });

  it("reports a bad login without sending the message", async () => {
    const smtp = await startFakeSmtp({ auth: "plain", user: "u", password: "pw" }); servers.push(smtp);
    await expect(sendMail(target(smtp, { user: "u", password: "wrong" }), mail)).rejects.toThrow(/authentication refused: 535/u);
    expect(smtp.messages).toEqual([]);
  });

  it("gives up on a server that never greets", async () => {
    const smtp = await startFakeSmtp({ stall: true }); servers.push(smtp);
    await expect(sendMail(target(smtp), mail, { timeoutMs: 300 })).rejects.toThrow();
  });
});
