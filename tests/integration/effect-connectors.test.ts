import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { sendWebhook, webhookBody, webhookTarget } from "../../apps/governor/src/modules/operations/index";
import { WebhookMessageAdapter, WebhookTicketAdapter } from "../../apps/governor/src/modules/operations/connectors";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { setupWorld } from "../helpers";
import { scaled } from "../support/timing";

const tmp = process.env["TMPDIR"] ?? "/tmp";
const keys = ["BRAIN_NOTIFY_WEBHOOK_URL", "BRAIN_NOTIFY_WEBHOOK_FORMAT", "BRAIN_NOTIFY_WEBHOOK_SECRET", "BRAIN_BASE_URL", "BRAIN_INBOUND_WEBHOOK_SECRET", "BRAIN_NOTIFY_SMTP_URL", "BRAIN_NOTIFY_FROM"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const servers: Server[] = [];
const smtp: FakeSmtp[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const relay of smtp.splice(0)) await relay.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

interface Capture { url: string; bodies: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> }
async function capture(status = 200, answer: unknown = {}): Promise<Capture> {
  const bodies: Capture["bodies"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { bodies.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, bodies };
}
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

describe("team chat out: Slack and Teams bodies, signed", () => {
  it("posts what each product accepts, with a link to the one decision", async () => {
    const sink = await capture();
    for (const [format, check] of [
      ["slack", (body: Record<string, unknown>) => expect(String(body["text"])).toContain("<https://brain.example.test/approvals/apr_1|Open in Brain>")],
      ["teams", (body: Record<string, unknown>) => expect(JSON.stringify(body)).toContain("Action.OpenUrl")],
      ["generic", (body: Record<string, unknown>) => expect(body["type"]).toBe("brain.notification")],
    ] as const) {
      process.env["BRAIN_NOTIFY_WEBHOOK_URL"] = sink.url;
      process.env["BRAIN_NOTIFY_WEBHOOK_FORMAT"] = format;
      process.env["BRAIN_NOTIFY_WEBHOOK_SECRET"] = "chat-secret-0123456789";
      const target = webhookTarget()!;
      expect(await sendWebhook(target, webhookBody({ kind: "approval", link: "https://brain.example.test/approvals/apr_1" }))).toBe(true);
      const sent = sink.bodies.at(-1)!;
      check(JSON.parse(sent.body) as Record<string, unknown>);
      expect(sent.headers["x-brain-signature"]).toBe(`sha256=${createHmac("sha256", "chat-secret-0123456789").update(sent.body).digest("hex")}`);
    }
  });

  it("the message and ticket adapters sign, bound the answer and fail plainly", async () => {
    const chat = await capture();
    expect(await new WebhookMessageAdapter({ url: chat.url, secret: "s".repeat(20) }, "slack").send("demo-app was restarted")).toEqual({ delivered: true });
    expect(JSON.parse(chat.bodies[0]!.body)).toEqual({ text: "demo-app was restarted" });
    const tickets = await capture(200, { key: "OPS-7", url: "https://tickets.example/OPS-7", internal: "dropped" });
    expect(await new WebhookTicketAdapter({ url: tickets.url, token: "t".repeat(20), secret: "s".repeat(20) }).create({ title: "Disk", description: "full", priority: "high" })).toEqual({ id: "OPS-7", url: "https://tickets.example/OPS-7" });
    expect(tickets.bodies[0]!.headers["authorization"]).toBe(`Bearer ${"t".repeat(20)}`);
    const failing = await capture(503);
    await expect(new WebhookTicketAdapter({ url: failing.url }).create({ title: "x", description: "", priority: "low" })).rejects.toThrow(/answered 503/);
  });
});

describe("team chat in: a signed command that lists, denies and never approves", () => {
  async function hookWorld() {
    const root = mkdtempSync(join(tmp, "brain-hook-")); roots.push(root);
    const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    const w = setupWorld(app.brain);
    process.env["BRAIN_INBOUND_WEBHOOK_SECRET"] = "inbound-secret-0123456789";
    process.env["BRAIN_BASE_URL"] = "https://brain.example.test";
    const store = w.brain.store;
    const subject = { operation: "effect.host.restart", effectBounds: { summary: "Restart the container \"demo-app\" on the demos host" } };
    store.control.prepare("INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms) VALUES ('apr_hook1', ?, ?, 'system:effect-call', ?, ?, 'pending', ?, ?)")
      .run(w.org, w.workspaceId, `sha256:${"1".repeat(64)}`, JSON.stringify(subject), Date.now() + 3600_000, Date.now());
    const post = async (text: string, options: { secret?: string; ageSeconds?: number; id?: string } = {}) => {
      const timestamp = Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0);
      const body = JSON.stringify({ id: options.id ?? `evt-${Math.random()}`, user: "ana", text });
      const signature = `sha256=${createHmac("sha256", options.secret ?? "inbound-secret-0123456789").update(`${timestamp}.${body}`).digest("hex")}`;
      const response = await app.fetch(new Request("http://x/hooks/chat", { method: "POST", headers: { "content-type": "application/json", "x-brain-timestamp": String(timestamp), "x-brain-signature": signature }, body }));
      return { status: response.status, json: await response.json() as { text?: string; error?: string } };
    };
    return { w, post, state: () => (store.control.prepare("SELECT state FROM approval_requests WHERE id='apr_hook1'").get() as { state: string }).state };
  }

  it("refuses a bad signature, a stale request and a server with no secret", async () => {
    const { post } = await hookWorld();
    expect((await post("approvals", { secret: "another-secret-0123456789" })).status).toBe(401);
    expect((await post("approvals", { ageSeconds: 3600 })).status).toBe(401);
    delete process.env["BRAIN_INBOUND_WEBHOOK_SECRET"];
    expect((await post("approvals")).status).toBe(503);
  }, scaled(60_000));

  it("lists what waits with a link to each decision, gives only a link for approve, and denies on request", async () => {
    const { post, state } = await hookWorld();
    expect((await post("approvals")).json.text).toContain("Restart the container \"demo-app\" on the demos host: https://brain.example.test/approvals/apr_hook1");
    const approve = await post("approve apr_hook1");
    expect(approve.json.text).toContain("signed in");
    expect(state()).toBe("pending");
    const same = await post("deny apr_hook1", { id: "evt-deny" });
    expect(same.json.text).toContain("Denied");
    expect(state()).toBe("rejected");
    // The same signed event again is acknowledged, not repeated.
    expect((await post("deny apr_hook1", { id: "evt-deny" })).json.text).toBe("Already handled.");
    expect((await post("approvals")).json.text).toContain("Nothing waits");
  }, scaled(60_000));
});

describe("approvals reach the owner's phone as a link to that decision", () => {
  it("notifies the approvers of an effect call with a deep link, on the chat webhook", async () => {
    const sink = await capture();
    process.env["BRAIN_NOTIFY_WEBHOOK_URL"] = sink.url;
    process.env["BRAIN_NOTIFY_WEBHOOK_FORMAT"] = "slack";
    process.env["BRAIN_BASE_URL"] = "https://brain.example.test";
    const world: EffectsWorld = await effectsWorld();
    roots.push(world.root);
    const approver = await world.w.grantApprover("owner-phone");
    world.w.brain.setNotificationPreferences(approver.actor, { webhook: true, push: false });
    await world.dispatch("phone-1");
    const running = world.run();
    const approval = await world.pendingApproval();
    await until(() => sink.bodies.length > 0);
    expect((JSON.parse(sink.bodies[0]!.body) as { text: string }).text).toContain(`https://brain.example.test/approvals/${approval.id}`);
    // The message is a generic sentence and a link: no container name, no arguments.
    expect(sink.bodies[0]!.body).not.toContain("demo-app");
    await world.decide(approval, "reject");
    await running;
  }, scaled(120_000));
});

describe("email on a real relay: configurable, testable, visible in Health", () => {
  const health = async (w: ReturnType<typeof setupWorld>) => ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { services: Array<{ id: string; status: string; detail: string }> } }).snapshot.services.find((service) => service.id === "email")!;

  it("says it is off, sends a test email, and turns degraded with the relay's reason when the relay refuses", async () => {
    const w = setupWorld();
    for (const key of ["BRAIN_NOTIFY_SMTP_URL", "BRAIN_NOTIFY_FROM"] as const) delete process.env[key];
    expect(await health(w)).toMatchObject({ status: "disabled", detail: expect.stringContaining("BRAIN_NOTIFY_SMTP_URL") });
    await expect(w.brain.sendTestEmail(w.owner)).rejects.toThrow(/not configured/);
    const relay = await startFakeSmtp(); smtp.push(relay);
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://127.0.0.1:${relay.port}`;
    process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
    expect(await health(w)).toMatchObject({ status: "healthy", detail: expect.stringContaining("no email has been sent yet") });
    expect(await w.brain.sendTestEmail(w.owner)).toEqual({ sent: true, reason: "" });
    expect(relay.messages).toHaveLength(1);
    expect(relay.messages[0]!.data).toContain("test email from Brain");
    expect(await health(w)).toMatchObject({ status: "healthy", detail: "The mail relay accepted the last email." });
    const refusing = await startFakeSmtp({ rcptReply: "550 mailbox unavailable" }); smtp.push(refusing);
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://127.0.0.1:${refusing.port}`;
    expect(await w.brain.sendTestEmail(w.owner)).toMatchObject({ sent: false, reason: expect.stringContaining("550") });
    expect(await health(w)).toMatchObject({ status: "degraded", detail: expect.stringContaining("550") });
    w.brain.close();
  }, scaled(60_000));
});
