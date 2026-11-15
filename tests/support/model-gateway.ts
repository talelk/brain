import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "../../apps/governor/src/application/brain";
import { DIGEST_A, setupWorld, type TestWorld } from "../helpers";
import { command } from "./reuse";
import { fixtureStarter } from "./starter";

// Shared by the model gateway tests (ADR 0072): routes through the gateway, a fake upstream model endpoint and a running second attempt.
export const clock = { now: Date.now() };
export const route = (routeId: string, extra: Record<string, unknown> = {}) => ({
  routeId, enabled: true, vendor: "Acme", keyRef: `acme-${routeId}`, model: `model-${routeId}`, baseUrl: `https://${routeId}.acme.example/v1`, costTier: "standard",
  inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000, viaGateway: true, ...extra,
});

export interface Seen { url: string; authorization: string | null; body: Record<string, unknown> }
/** The fake upstream: each route's host answers as scripted and every request it receives is kept. */
export function upstream(script: Record<string, "ok" | "stream" | "quota" | "error">): { seen: Seen[]; fetch: typeof fetch } {
  const seen: Seen[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const behaviour = script[new URL(url).hostname.split(".")[0]!] ?? "error";
    if (behaviour === "quota") return new Response(JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "45" } });
    if (behaviour === "error") return new Response("boom", { status: 500 });
    if (behaviour === "stream") {
      const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      const text = chunk({ id: "c", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] }) + chunk({ id: "c", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }) + "data: [DONE]\n\n";
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 2000, completion_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetch: fetchFake };
}

/** A world on a Governor with a controllable clock, or on the given Brain (a Governor that is listening), with the fixture starter active. */
export function gatewayWorld(dirs: string[], brain?: Brain): TestWorld {
  clock.now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  if (!brain) dirs.push(dir);
  const w = setupWorld(brain ?? new Brain({ dataDir: dir, allowTestActor: true, clock: { nowMs: () => clock.now, monotonicMs: () => clock.now } }));
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  process.env["BRAIN_MODEL_KEY_ACME_A"] = "REAL-KEY-A-held-on-the-governor";
  process.env["BRAIN_MODEL_KEY_ACME_B"] = "REAL-KEY-B-held-on-the-governor";
  return w;
}
export const set = (w: TestWorld, key: string, routes: Array<Record<string, unknown>>) => command(w, w.owner, "workspace.modelRoutes.set", key, { routes });
export type Runner = { runnerId: string; epoch: number; organizationId: string };

/** A queued agent job of a task on its second attempt (a model slip), and a runner able to take it. */
export async function secondAttempt(w: TestWorld, key: string): Promise<{ runner: Runner; jobId: string; runId: string; missionId: string }> {
  const s = w.brain.store;
  const missionId = (await command(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], autoStart: false })).resourceId ?? "";
  const plan = (await command(w, w.owner, "plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks: [{ id: "a", title: "Task a", criteria: ["a-done"], dependsOn: [] }] })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await command(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: plan }, version);
  const db = s.workspaceDb(w.workspaceId, w.org);
  const workItemId = (db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
  const runId = `run-${key}`;
  w.brain.missions.linkExecution(w.owner, w.workspaceId, workItemId, runId);
  db.prepare("UPDATE work_items SET failed_attempts=1, failure_class='model-slip' WHERE id=?").run(workItemId);
  const jobId = `job-${key}`;
  const placement = { group: "fixture-tools", all: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], isolation: "ephemeral-container", resources: { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 } };
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, priority, created_at_ms, ready_at_ms, deadline_ms)
    VALUES (?,?,?,?,?, 'work', 'queued', ?, ?, ?, 'read', 'WAITING_FOR_RUNNER', 0, ?, ?, ?)`)
    .run(jobId, w.org, w.workspaceId, `key-${jobId}`, runId, w.brain.activeRelease(w.org)!.digest, JSON.stringify(placement), DIGEST_A, s.now(), s.now(), s.now() + 3_600_000);
  s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(jobId, "dispatch", JSON.stringify({ step: { uses: { type: "agent", release: { id: "task-worker", digest: DIGEST_A } } } }));
  const runnerId = `runner-${key}`;
  s.control.prepare(`INSERT OR IGNORE INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 16000, 32768, 40960, 4)`).run(runnerId, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"]) {
    s.control.prepare("INSERT OR IGNORE INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 3_600_000);
  }
  return { runner: { runnerId, epoch: 1, organizationId: w.org }, jobId, runId, missionId };
}

/** The runner takes the job and starts it; what it holds afterwards is the attempt's gateway token. */
export function running(w: TestWorld, runner: Runner, request: string): { attemptId: string; leaseId: string; jobFence: number; token: string } {
  const offer = w.brain.jobProtocol.claim(runner, request) as unknown as { attemptId: string; leaseId: string; jobFence: number };
  w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  return { ...offer, token: w.brain.jobProtocol.modelGatewayToken(runner, offer.attemptId).token };
}

