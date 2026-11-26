import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverNotifications } from "../../apps/governor/src/integrations/teams";
import { webhooksSettled } from "../../apps/governor/src/integrations/webhook";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Harness } from "./harness";
import { makeWorkspace, pass } from "./work";

/** Systems that follow work (docs/model.md): the workspace's webhook is sent signed CloudEvents from the audit log. */
let harness: Harness;
let driver: Driver;
let workspaceId: string;
const sent: Array<{ headers: Record<string, string>; body: string }> = [];
let answer = 200;
const cards: string[] = [];
/** While set, the receiver takes a delivery and never answers until it is let go. */
let held: Array<(response: Response) => void> | undefined;
const events = () => sent.map((delivery) => JSON.parse(delivery.body) as { id: string; type: string; subject: string; source: string; specversion: string; time: string; data: Record<string, unknown> });
const failures = () => (harness.governor.gov.db.prepare("SELECT payload_json AS payload FROM events WHERE type='webhook.failed' ORDER BY seq").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

beforeAll(async () => {
  harness = await createHarness({
    fetch: (input, init) => {
      if (String(input).startsWith("https://teams.example.test/")) cards.push(String(init?.body));
      if (!String(input).startsWith("https://ci.example.test/")) return Promise.resolve(Response.json({}));
      sent.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) });
      const waiting = held;
      return waiting ? new Promise<Response>((resolve) => waiting.push(resolve)) : Promise.resolve(new Response("", { status: answer }));
    },
  });
  ({ workspaceId } = await makeWorkspace(harness, "Followed", {
    brain: '[webhook]\nurl = "https://ci.example.test/brain"\nsecret = "secret:brain-webhook"\n',
    agents: { dev: {} }, plays: { one: 'title = "One step"\n[[step]]\nid = "work"\nagent = "dev"\ngoal = "Do the work."\napprove = true\n' },
  }));
  await harness.admin.command("secret.set", { workspaceId, name: "brain-webhook", value: "shared-signing-secret" });
  driver = await enrolRunner(harness, { checker: () => pass(), dev: () => "Done." });
});
afterAll(() => harness.close());

/** One look at the audit log, and the deliveries it queued carried out. */
const deliver = async (): Promise<void> => { await deliverNotifications(harness.governor.gov); await webhooksSettled(harness.governor.gov); };

describe("a workspace's webhook", () => {
  it("is sent each task that needs a person and each goal that ends, signed, as a CloudEvent, once", async () => {
    const { taskId } = await harness.admin.command("task.create", { workspaceId, play: "one" });
    await driver.drain();
    await deliver();
    await deliver();
    expect(events()).toEqual([expect.objectContaining({
      specversion: "1.0", type: "brain.task.needs_you", source: "http://localhost:3100/w/followed", data: expect.objectContaining({ workspaceId, title: "work", goal: false, need: "sign-off" }) as Record<string, unknown>,
    })]);
    const [first] = sent;
    expect(first?.headers["content-type"]).toBe("application/cloudevents+json");
    expect(first?.headers["x-brain-signature-256"]).toBe(`sha256=${createHmac("sha256", "shared-signing-secret").update(first?.body ?? "").digest("hex")}`);
    expect(first?.body).not.toContain("shared-signing-secret");

    const waiting = (await harness.admin.query("task.get", { workspaceId, taskId })).subtasks[0]?.id ?? "";
    await harness.admin.command("task.check", { workspaceId, taskId: waiting, pass: true });
    await deliver();
    expect(events().slice(1)).toEqual([expect.objectContaining({ type: "brain.task.done", subject: taskId })]);
    expect(new Set(events().map((event) => event.id)).size).toBe(2);
    expect(failures()).toEqual([]);
  });

  it("tries a delivery three times, then drops it and says so in the audit log", { timeout: 20_000 }, async () => {
    const before = sent.length;
    answer = 500;
    await harness.admin.command("task.create", { workspaceId, play: "one" });
    await driver.drain();
    await deliver();
    await deliver();
    expect(sent.length - before).toBe(3);
    expect(failures()).toEqual([expect.objectContaining({ type: "task.needs_you", message: "it answered 500" })]);
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true });
  });

  it("holds nobody else up when its receiver does not answer", async () => {
    const other = await makeWorkspace(harness, "Chatty", { brain: '[teams]\nwebhook = "secret:teams"\n', agents: { dev: {} }, plays: { one: 'title = "One step"\n[[step]]\nid = "work"\nagent = "dev"\ngoal = "Do the work."\n' } });
    await harness.admin.command("secret.set", { workspaceId: other.workspaceId, name: "teams", value: "https://teams.example.test/hook" });
    answer = 200;
    held = [];
    await harness.admin.command("task.create", { workspaceId, play: "one" });
    await harness.admin.command("task.create", { workspaceId: other.workspaceId, play: "one" });
    await driver.drain();
    // The card of the other workspace is posted while the first one's receiver is still silent.
    await deliverNotifications(harness.governor.gov);
    expect(cards).toEqual([expect.stringContaining("is done") as string]);
    const waiting = held;
    held = undefined;
    for (const letGo of waiting) letGo(new Response(""));
    await webhooksSettled(harness.governor.gov);
  });
});
