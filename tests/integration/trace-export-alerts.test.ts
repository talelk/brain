import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask } from "@brain/contracts";
import { renderMetrics } from "../../apps/governor/src/modules/operations/index";
import { missionTraceId } from "../../apps/governor/src/domain/trace";
import { setupWorld } from "../helpers";
import { startFakeOtlp } from "../support/fake-otlp";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
const closers: Array<() => Promise<void>> = [];
const keys = ["OTEL_TRACES_EXPORTER", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_SERVICE_NAME", "BRAIN_NOTIFY_SMTP_URL", "BRAIN_NOTIFY_FROM", "BRAIN_BASE_URL", "BRAIN_NOTIFY_WEBHOOK_URL", "BRAIN_NOTIFY_WEBHOOK_FORMAT", "BRAIN_LOCAL_MODEL_URL"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(async () => {
  for (const w of worlds.splice(0)) w.brain.close();
  for (const close of closers.splice(0)) await close();
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
}
const task = (id: string): PlanTask => ({ id, title: `Secret plan ${id}`, criteria: [`${id}-done`], dependsOn: [] });
async function startedMission(w: World, key: string): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: `Confidential launch ${key}`, intent: `Deliver ${key} with sk-live-intent-secret`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: Mission }).snapshot.version;
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, version);
  return id;
}

describe("optional trace export (ADR 0063)", () => {
  it("is off by default: nothing is exported and the metrics say nothing about it", async () => {
    for (const key of keys) delete process.env[key];
    const w = setupWorld(); worlds.push(w);
    await startedMission(w, "off");
    expect(w.brain.traceExport).toBeUndefined();
    expect(renderMetrics(w.brain.store)).not.toContain("brain_trace_spans");
    // An endpoint alone does not switch it on.
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:1";
    const other = setupWorld(); worlds.push(other);
    expect(other.brain.traceExport).toBeUndefined();
  });

  it("exports one trace per mission, with the mission trace id, ids and states only", async () => {
    const collector = await startFakeOtlp(); closers.push(collector.close);
    process.env["OTEL_TRACES_EXPORTER"] = "otlp";
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = collector.url;
    process.env["OTEL_EXPORTER_OTLP_HEADERS"] = "authorization=Bearer%20collector-token-xyz";
    process.env["OTEL_SERVICE_NAME"] = "brain-test";
    const w = setupWorld(); worlds.push(w);
    const id = await startedMission(w, "on");
    await w.brain.traceExport!.flush();
    const spans = collector.spans();
    const trace = missionTraceId(id);
    expect(collector.requests[0]).toMatchObject({ path: "/v1/traces" });
    expect(collector.requests[0]!.headers["authorization"]).toBe("Bearer collector-token-xyz");
    const mine = spans.filter((span) => span.traceId === trace);
    expect(mine.map((span) => span.name)).toEqual(expect.arrayContaining(["mission", "mission.created", "plan.proposed", "plan.confirmed"]));
    const root = mine.find((span) => span.name === "mission")!;
    expect(mine.filter((span) => span.name !== "mission").every((span) => span.parentSpanId === root.spanId)).toBe(true);
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([trace]));
    const body = collector.requests.map((r) => r.body).join("");
    expect(body).toContain('"brain-test"');
    expect(body).not.toMatch(/Confidential|Secret plan|sk-live-intent-secret|collector-token-xyz|owner-1|password/iu);
    expect(renderMetrics(w.brain.store)).toMatch(/brain_trace_spans_exported_total \d+/u);
  });

  it("a collector that is down changes nothing for the work: commands succeed, spans are dropped and counted", async () => {
    const dead: Server = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((resolve) => dead.close(resolve));
    process.env["OTEL_TRACES_EXPORTER"] = "otlp";
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${port}`;
    const w = setupWorld(); worlds.push(w);
    const started = Date.now();
    const id = await startedMission(w, "down");
    expect(id).not.toBe("");
    await w.brain.traceExport!.flush();
    expect(w.brain.traceExport!.stats().dropped).toBeGreaterThan(0);
    expect(renderMetrics(w.brain.store)).toMatch(/brain_trace_spans_dropped_total [1-9]\d*/u);
    expect(Date.now() - started).toBeLessThan(5000);
    // The queue is bounded: a flood of events never grows it past its limit.
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    for (let i = 0; i < 1500; i++) w.brain.store.emit(db, { aggregateType: "mission", aggregateId: id, eventType: "mission.briefChanged", payload: { missionId: id } });
    expect(w.brain.traceExport!.stats().queued).toBeLessThanOrEqual(1000);
  });
});

describe("platform alerts use the attention channels (ADR 0011)", () => {
  it("a probe that turns bad reaches the owner's webhook (Slack format) and email, once", async () => {
    const hooks: string[] = [];
    const hook: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => { hooks.push(Buffer.concat(chunks).toString("utf8")); response.writeHead(204).end(); });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => hook.close(() => resolve())));
    const smtp: FakeSmtp = await startFakeSmtp({ auth: "plain", user: "user", password: "p@ss" }); closers.push(smtp.close);
    process.env["BRAIN_NOTIFY_WEBHOOK_URL"] = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
    process.env["BRAIN_NOTIFY_WEBHOOK_FORMAT"] = "slack";
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://user:p%40ss@127.0.0.1:${smtp.port}`;
    process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
    process.env["BRAIN_BASE_URL"] = "https://brain.example.test";
    const w = setupWorld(); worlds.push(w);
    w.brain.setNotificationPreferences(w.owner, { webhook: true, email: true, push: false });
    process.env["BRAIN_LOCAL_MODEL_URL"] = "http://model.invalid/v1";
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await w.brain.runEngineProbes(offline);
    await until(() => hooks.length >= 1 && smtp.messages.length >= 1);
    expect(JSON.parse(hooks[0]!)).toEqual({ text: "Brain: a platform check needs attention. Open https://brain.example.test/settings?tab=health\n<https://brain.example.test/settings?tab=health|Open in Brain>" });
    expect(smtp.messages[0]!.data).toContain("Subject: Brain: a platform check needs attention");
    expect(smtp.messages[0]!.data).toContain("https://brain.example.test/settings?tab=health");
    expect(hooks[0]).not.toMatch(/model endpoint|offline/iu);
    // Still bad on the next pass: a bad spell alerts once.
    await w.brain.runEngineProbes(offline);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hooks).toHaveLength(1);
    expect(smtp.messages).toHaveLength(1);
  });

  it("an owner who switched the channels off gets only the in-app notification", async () => {
    const smtp: FakeSmtp = await startFakeSmtp({ auth: "plain", user: "user", password: "p@ss" }); closers.push(smtp.close);
    process.env["BRAIN_NOTIFY_SMTP_URL"] = `smtp://user:p%40ss@127.0.0.1:${smtp.port}`;
    process.env["BRAIN_NOTIFY_FROM"] = "brain@example.test";
    const w = setupWorld(); worlds.push(w);
    w.brain.setNotificationPreferences(w.owner, { email: false, push: false });
    process.env["BRAIN_LOCAL_MODEL_URL"] = "http://model.invalid/v1";
    await w.brain.runEngineProbes((async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(smtp.messages).toEqual([]);
    const row = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT title FROM attention_notifications WHERE item_id='platform:model'").get() as { title: string } | undefined;
    expect(row?.title).toMatch(/model endpoint is down/iu);
  });
});
