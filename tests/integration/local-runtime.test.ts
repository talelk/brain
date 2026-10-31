import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { setupWorld } from "../helpers";
import { connectLocalModel, localRuntimeStatus, restoreLocalRuntimeHandoff, localRunnerSettingsCurrent } from "../../apps/governor/src/modules/operations/index";
import { readLocalConfiguration } from "../../apps/runner/src/local-configuration";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => { fn(); }); vi.unstubAllEnvs(); });
function world() {
  const runtime = mkdtempSync(join(tmpdir(), "brain-local-runtime-"));
  vi.stubEnv("BRAIN_LOCAL_RUNTIME_DIR", runtime);
  const w = setupWorld();
  cleanup.push(() => { w.brain.close(); rmSync(w.dir, { recursive: true, force: true }); rmSync(runtime, { recursive: true, force: true }); });
  return { ...w, runtime };
}
const model = { modelUrl: "http://localhost:8000/v1", modelId: "local-test-model", apiKey: "private-model-key" };
const transport = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: model.modelId }] }));

it("pairs two private role-scoped runners, redacts the key, and recovers the committed handoff", async () => {
  const w = world(); await w.brain.auth.ready();
  expect(localRuntimeStatus(w.brain.store, w.owner).configured).toBe(false);
  const status = await connectLocalModel(w.brain.store, w.owner, model, transport);
  expect(status.configured).toBe(true);
  expect(JSON.stringify(status)).not.toContain(model.apiKey);
  const author = readLocalConfiguration(join(w.runtime, "runner-agents-1-state"))!;
  const evaluator = readLocalConfiguration(join(w.runtime, "runner-evaluators-1-state"))!;
  expect(author.engine).toBe("pi");
  expect(evaluator.engine).toBe("claude");
  expect(author.apiKey).toBe(model.apiKey);
  expect(evaluator.apiKey).toBeUndefined();
  expect(author.enrollmentToken).not.toBe(evaluator.enrollmentToken);
  const tokens = w.brain.store.control.prepare("SELECT group_id FROM enrollment_tokens ORDER BY group_id").all();
  expect(tokens).toEqual([{ group_id: "agents" }, { group_id: "evaluators" }]);
  expect(lstatSync(join(w.dir, "local-model.json")).mode & 0o077).toBe(0);
  const request = transport.mock.calls.at(-1)!;
  expect(request[0]).toBe(`${model.modelUrl}/models`);
  expect((request[1]!.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${model.apiKey}`);
  expect(localRunnerSettingsCurrent(w.brain.store, w.org, "runner-agents-1")).toBe(false);
  unlinkSync(join(w.runtime, "local-runtime-revision.json"));
  restoreLocalRuntimeHandoff(w.brain.store);
  expect(readLocalConfiguration(join(w.runtime, "runner-agents-1-state"))?.revision).toBe(author.revision);
  expect(readFileSync(join(w.runtime, "local-runtime-revision.json"), "utf8")).not.toContain(model.apiKey);
});

it("rejects missing models, denied authority, and authorization revoked during the probe without publishing settings", async () => {
  const w = world(); await w.brain.auth.ready();
  await expect(connectLocalModel(w.brain.store, { ...w.owner, scopes: [] }, model, transport)).rejects.toThrow(/administration/);
  await expect(connectLocalModel(w.brain.store, w.owner, { ...model, modelId: "unknown" }, transport)).rejects.toThrow(/Could not find/);
  await expect(connectLocalModel(w.brain.store, w.owner, model, transport, async () => ({ ...w.owner, scopes: [] }))).rejects.toThrow(/administration/);
  expect(existsSync(join(w.runtime, "local-runtime-revision.json"))).toBe(false);
  expect(localRuntimeStatus(w.brain.store, w.owner).configured).toBe(false);
});

it("does not forward a retained key to a changed endpoint and serializes concurrent setup requests", async () => {
  const w = world(); await w.brain.auth.ready();
  await connectLocalModel(w.brain.store, w.owner, model, transport);
  const next = await connectLocalModel(w.brain.store, w.owner, { modelUrl: "http://localhost:8001/v1", modelId: model.modelId }, transport);
  expect(next.hasApiKey).toBe(false);
  expect((transport.mock.calls.at(-1)![1]!.headers as Record<string, string>)["authorization"]).toBeUndefined();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayed: typeof fetch = async () => { await gate; return Response.json({ data: [{ id: model.modelId }] }); };
  const pending = connectLocalModel(w.brain.store, w.owner, model, delayed);
  await expect(connectLocalModel(w.brain.store, w.owner, model, transport)).rejects.toThrow(/Another model/);
  release(); await pending;
});
