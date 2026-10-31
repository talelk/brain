import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import type { ActorContext, LocalModelConnectionRequest, LocalRunnerConfiguration, LocalRuntimeStatus } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { assertRegularFile, durableWrite } from "../../infrastructure/persistence/directory";
import { issueEnrollment, runnerView } from "../jobs/index";

interface SavedConnection extends LocalModelConnectionRequest { revision: string; testedAt: string; organizationId: string }
function runtimeDirectory(): string | null {
  const directory = process.env["BRAIN_LOCAL_RUNTIME_DIR"];
  if (!directory) return null;
  return resolve(directory);
}
function requireAdmin(actor: ActorContext): void {
  if (actor.kind !== "human" || !actor.scopes.includes("config:activate") || !actor.scopes.includes("runner:admin")) throw new BrainDomainError("FORBIDDEN", "Local model setup requires organization administration");
}
function readSaved(s: Store): SavedConnection | null {
  const file = join(s.dataDir, "local-model.json");
  if (!existsSync(file)) return null;
  assertRegularFile(file);
  if (lstatSync(file).mode & 0o077) throw new BrainDomainError("FORBIDDEN", "Local model settings must remain private");
  return JSON.parse(readFileSync(file, "utf8")) as SavedConnection;
}
function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new BrainDomainError("FORBIDDEN", "Local runtime directory must be owned, private and not a link");
}
function replacePrivate(file: string, value: unknown): void {
  if (existsSync(file)) assertRegularFile(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { durableWrite(temporary, JSON.stringify(value)); renameSync(temporary, file); const parent = openSync(resolve(file, ".."), constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(parent); } finally { closeSync(parent); } }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function localRuntimeStatus(s: Store, actor: ActorContext): LocalRuntimeStatus {
  requireAdmin(actor);
  const saved = readSaved(s);
  const settings = saved?.organizationId === actor.organizationId ? saved : null;
  const runners = ["runner-agents-1", "runner-evaluators-1"].map((id) => {
    const runner = runnerView(s, id);
    const owned = !!s.control.prepare("SELECT 1 FROM runners WHERE id=? AND organization_id=?").get(id, actor.organizationId);
    const connected = owned && !!runner?.online && runner.adminState === "enabled" && runner.health === "healthy";
    return { id, connected, applied: connected && !!settings && runner?.capabilities.get(`local-config:${settings.revision}`)?.verified === true && runner.capabilities.get(`local-config:${settings.revision}`)!.expiresAtMs > s.now() && runner.engines.includes(id.includes("evaluators") ? "claude" : "pi") };
  });
  return { enabled: !!runtimeDirectory(), configured: !!settings, modelUrl: settings?.modelUrl ?? null, modelId: settings?.modelId ?? null, hasApiKey: !!settings?.apiKey, revision: settings?.revision ?? null, testedAt: settings?.testedAt ?? null, runners };
}
async function connectLocalModelExclusive(s: Store, actor: ActorContext, input: LocalModelConnectionRequest, transport: typeof fetch = fetch, reauthorize?: () => Promise<ActorContext>): Promise<LocalRuntimeStatus> {
  requireAdmin(actor);
  const directory = runtimeDirectory();
  if (!directory) throw new BrainDomainError("UNSUPPORTED_CAPABILITY", "Start this local installation with pnpm brain start to enable guided setup");
  const check = validate("LocalModelConnectionRequest", input);
  if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", "Enter a model URL and model ID");
  let url: URL;
  try { url = new URL(input.modelUrl); } catch { throw new BrainDomainError("INVALID_ARGUMENT", "Enter an absolute model API URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BrainDomainError("INVALID_ARGUMENT", "Use an HTTP(S) model API URL without credentials, query or fragment");
  const modelUrl = url.href.replace(/\/$/u, "");
  const prior = readSaved(s);
  if (prior && prior.organizationId !== actor.organizationId) throw new BrainDomainError("FORBIDDEN", "This local runtime belongs to another organization");
  const apiKey = input.apiKey ?? (prior?.modelUrl === modelUrl ? prior.apiKey : undefined);
  if (apiKey && /[\r\n]/u.test(apiKey)) throw new BrainDomainError("INVALID_ARGUMENT", "The model API key contains invalid characters");
  try {
    const response = await transport(`${modelUrl}/models`, { redirect: "error", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("unavailable");
    if (!response.body) throw new Error("empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.length; if (total > 262144) throw new Error("oversized"); chunks.push(chunk.value); } }
    finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks).toString("utf8");
    const models = JSON.parse(bytes) as { data?: { id: string }[] };
    if (!models.data?.some((model) => model.id === input.modelId)) throw new Error("missing model");
  } catch { throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "Could not find that model at the endpoint. Check the URL, exact model ID and API key."); }
  if (reauthorize) {
    const current = await reauthorize();
    requireAdmin(current);
    if (current.actorId !== actor.actorId || current.organizationId !== actor.organizationId) throw new BrainDomainError("FORBIDDEN", "Organization context changed during model setup; retry in the intended organization");
  }
  privateDirectory(directory);
  const revision = randomUUID();
  const saved: SavedConnection = { modelUrl, modelId: input.modelId, ...(apiKey ? { apiKey } : {}), revision, testedAt: s.nowIso(), organizationId: actor.organizationId };
  for (const [group, engine] of [["agents", "pi"], ["evaluators", "claude"]] as const) {
    const id = `runner-${group}-1`;
    const stateDirectory = join(directory, `${id}-state`);
    privateDirectory(stateDirectory);
    const registered = s.control.prepare("SELECT organization_id FROM runners WHERE id=?").get(id) as { organization_id: string } | undefined;
    if (registered && registered.organization_id !== actor.organizationId) throw new BrainDomainError("FORBIDDEN", "The local runner identity belongs to another organization");
    const enrollmentToken = registered ? "" : issueEnrollment(s, actor, group).token;
    const config: LocalRunnerConfiguration = { revision, engine, modelUrl, modelId: input.modelId, ...(engine === "pi" && apiKey ? { apiKey } : {}), enrollmentToken };
    replacePrivate(join(stateDirectory, `local-config.${revision}.json`), config);
  }
  replacePrivate(join(s.dataDir, "local-model.json"), saved);
  replacePrivate(join(directory, "local-runtime-revision.json"), { revision });
  s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "local-runtime", aggregateId: revision, eventType: "local-runtime.configured", payload: { modelId: input.modelId, revision, actorId: actor.actorId } });
  return localRuntimeStatus(s, actor);
}

export function localModelConfigured(s: Store, organizationId: string): boolean | null {
  if (!runtimeDirectory()) return null;
  return readSaved(s)?.organizationId === organizationId;
}

const connecting = new WeakSet<Store>();
export async function connectLocalModel(s: Store, actor: ActorContext, input: LocalModelConnectionRequest, transport: typeof fetch = fetch, reauthorize?: () => Promise<ActorContext>): Promise<LocalRuntimeStatus> {
  requireAdmin(actor);
  if (connecting.has(s)) throw new BrainDomainError("CONFLICT", "Another model connection is being tested; wait for it to finish");
  connecting.add(s);
  try { return await connectLocalModelExclusive(s, actor, input, transport, reauthorize); }
  finally { connecting.delete(s); }
}
export function restoreLocalRuntimeHandoff(s: Store): void {
  const directory = runtimeDirectory(); const saved = readSaved(s);
  if (!directory || !saved) return;
  if (!/^[a-f0-9-]{36}$/u.test(saved.revision)) throw new BrainDomainError("INVALID_CONTRACT", "Invalid saved model revision");
  privateDirectory(directory);
  for (const group of ["agents", "evaluators"]) {
    const file = join(directory, `runner-${group}-1-state`, `local-config.${saved.revision}.json`);
    if (!existsSync(file)) return;
    assertRegularFile(file);
    if (!validate("LocalRunnerConfiguration", JSON.parse(readFileSync(file, "utf8"))).ok) throw new BrainDomainError("INVALID_CONTRACT", "Invalid saved runner configuration");
  }
  replacePrivate(join(directory, "local-runtime-revision.json"), { revision: saved.revision });
}

export function localModelTestedAt(s: Store, organizationId: string): number | null {
  const saved = readSaved(s);
  return runtimeDirectory() && saved?.organizationId === organizationId ? Date.parse(saved.testedAt) : null;
}
export function localRunnerSettingsCurrent(s: Store, organizationId: string, runnerId: string): boolean {
  if (!runtimeDirectory() || !["runner-agents-1", "runner-evaluators-1"].includes(runnerId)) return true;
  const saved = readSaved(s);
  if (saved?.organizationId !== organizationId) return false;
  const capability = runnerView(s, runnerId)?.capabilities.get(`local-config:${saved.revision}`);
  return capability?.verified === true && capability.expiresAtMs > s.now();
}
