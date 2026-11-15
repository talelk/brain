import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { cpus, freemem } from "node:os";
import { join } from "node:path";
import { domainDigest, isKeyReference, isolationSatisfies, sha256Digest } from "@brain/contracts";
import type { ArtifactRef, Checkpoint, EngineInfo, EvaluationAssignment, JsonValue, ReleaseRef, VerificationVerdict } from "@brain/contracts";
import Ajv2020 from "ajv/dist/2020.js";
import { executeToolPayload, normalizeEvaluation } from "./tools/invoke";
import { brokerRead } from "./tools/broker-read";
import { BrainSession } from "./tools/brain-tools";
import { OUTPUT_BROKERED } from "./tools/brokers";
import { RunOutputDir } from "./tools/run-output";
import { proposeEffect, type Proposal } from "./tools/effects";
import { prepareMcpCall, type McpDeclaration } from "./tools/mcp";
import { performHeldEffect, type ActPayload } from "./tools/act";
import { DurableEventSpool } from "./spool-durable";
import { GovernorClient, GovernorProtocolError } from "./governor-client";
import { LauncherClient } from "./launcher-client";
import { payloadValidator } from "@brain/contracts/validate";
import { instructionsWithSkills, promptWithContext, runAgentExecution, runAgentOnRoutes, selectEngine, type RouteReport } from "./engines/run";
import { advertisedCapabilities, advertisedIsolationModes, engineIsolation } from "./engines/isolation";
import type { HostedRoute } from "./engines/pi";

/** The step's output schema, as sent with its job, turned into a check that lists the violations of a reply; a schema that cannot be compiled checks nothing. */
function outputContractCheck(schema: unknown): ((output: JsonValue) => readonly string[]) | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  try { const check = payloadValidator(schema); return (output) => { const result = check(output); return result.ok ? [] : result.errors; }; } catch { return undefined; }
}

export interface RunnerConfig {
  readonly governorUrl: string;
  readonly runnerId: string;
  readonly stateDir: string;
  readonly capabilities: readonly string[];
  readonly engines?: readonly string[];
  readonly groupToolsDir?: string;
  readonly transport?: typeof fetch;
  /**
   * Operator-declared read-only data mounts offered to sandboxed tools, by
   * tool id then mount name (BRAIN_TOOL_DATA_MOUNTS="host.read=srv+logs,..").
   * This is host configuration, not workflow configuration: a release cannot
   * add a mount it was not given, and a tool sees only its own mounts.
   */
  readonly dataMounts?: ReadonlyMap<string, readonly string[]>;
  /** Tests and embedders supply the trusted launcher directly; otherwise it is built from BRAIN_LAUNCHER_SOCKET. */
  readonly launcher?: LauncherClient;
}

/** "host.read=srv+logs,csv.query=cv-data" -> tool id -> mount names. Malformed entries are ignored, never widened. */
export function parseToolDataMounts(raw: string): ReadonlyMap<string, readonly string[]> {
  const byTool = new Map<string, string[]>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const names = pair.slice(eq + 1).split("+").map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9-]*$/u.test(s));
    if (names.length > 0) byTool.set(pair.slice(0, eq).trim(), names);
  }
  return byTool;
}

/**
 * Live controls delivered through heartbeat acks. Stop aborts the current
 * attempt through the existing watchdog path; steer is queued and handed to
 * the engine adapter at the next turn boundary (feature-gated). Pause and
 * continue are repeated by every heartbeat until the Governor has seen the
 * runner's report, so each is applied once per command id and the report is
 * a progress event the durable spool replays (ADR 0058).
 */
export interface RunnerControls {
  stopRequests: Set<string>;
  steerQueue: Array<{ attemptId: string; messageId: string; message: string }>;
  pauseQueue: Array<{ attemptId: string; commandId: string; type: "pause-attempt" | "continue-attempt" }>;
  /** Attempts executing right now (one per busy slot). */
  activeAttemptIds: Set<string>;
}

export function newRunnerControls(): RunnerControls {
  return { stopRequests: new Set(), steerQueue: [], pauseQueue: [], activeAttemptIds: new Set() };
}

/**
 * What this runner offers the Governor: concurrent sessions (slots) and the CPU and memory those sessions may reserve.
 * BRAIN_RUNNER_SLOTS (default 1), BRAIN_RUNNER_CPU_MILLICORES (default 4000), BRAIN_RUNNER_MEMORY_MB (default 8192).
 */
export function runnerCapacity(env: NodeJS.ProcessEnv = process.env): { cpuMillicores: number; memoryMb: number; diskMb: number; slots: number } {
  const positive = (name: string, fallback: number): number => { const value = Number(env[name]); return Number.isInteger(value) && value > 0 ? value : fallback; };
  return { cpuMillicores: positive("BRAIN_RUNNER_CPU_MILLICORES", 4000), memoryMb: positive("BRAIN_RUNNER_MEMORY_MB", 8192), diskMb: 20480, slots: positive("BRAIN_RUNNER_SLOTS", 1) };
}

export function loadOrCreateKeys(stateDir: string): { publicKeyPem: string; privateKeyPem: string } {
  mkdirSync(stateDir, { recursive: true });
  const pubPath = join(stateDir, "runner.pub.pem");
  const privPath = join(stateDir, "runner.key.pem");
  if (existsSync(pubPath) && existsSync(privPath)) {
    return { publicKeyPem: readFileSync(pubPath, "utf8"), privateKeyPem: readFileSync(privPath, "utf8") };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(pubPath, publicKeyPem);
  writeFileSync(privPath, privateKeyPem, { mode: 0o600 });
  return { publicKeyPem, privateKeyPem };
}

/** The engines that answered their probe, and when the probing finished: the time every observation made from it carries. */
async function availableEngines(cfg: RunnerConfig): Promise<{ engines: EngineInfo[]; probedAt: string }> {
  const engines: EngineInfo[] = [];
  for (const id of cfg.engines ?? ["fixture"]) {
    const engine = selectEngine(id);
    if (!engine) continue;
    const info = await engine.probe();
    if (info.features.includes("sessions")) engines.push(info);
  }
  return { engines, probedAt: new Date().toISOString() };
}

/** What this runner observes about itself, each dated by the probe that produced it (never by when the message is assembled). */
function observedCapabilities(cfg: RunnerConfig, probed: { engines: readonly EngineInfo[]; probedAt: string }) {
  const expiresAt = new Date(Date.parse(probed.probedAt) + 5 * 60_000).toISOString();
  return advertisedCapabilities(cfg.capabilities, probed.engines).map((capability) => ({ capability, observedAt: probed.probedAt, source: "runner-probe" as const, verified: true, expiresAt }));
}

/**
 * One hello. The boot nonce names this process's boot: the Governor keeps the epoch (and so every running attempt's fence) for a hello
 * with the same nonce and only replaces the session token; a new nonce (a restarted runner) is a new epoch that fences the old attempts.
 */
async function challengeHello(cfg: RunnerConfig, credential: string, bootNonce = `boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`): Promise<{ sessionToken: string; epoch: number; bootNonce: string }> {
  const keys = loadOrCreateKeys(cfg.stateDir);
  const client = new GovernorClient(cfg);
  const { challengeId, nonce } = await client.challenge(cfg.runnerId, credential);
  const probed = await availableEngines(cfg);
  const { engines } = probed;
  const helloBody = {
    contractVersion: "brain.runner/v1", runnerId: cfg.runnerId, bootNonce, runtimeVersion: "brain-runner/0.1.0",
    configDigest: `sha256:${"0".repeat(64)}`,
    capabilities: observedCapabilities(cfg, probed),
    engines,
    capacity: runnerCapacity(),
    isolationModes: advertisedIsolationModes(engines),
  };
  const helloDigest = domainDigest("brain:runner-hello:v1", helloBody as unknown as JsonValue);
  const signed = JSON.stringify({ challengeId, nonce, runnerId: cfg.runnerId, bootNonce, helloDigest });
  const signature = sign(null, Buffer.from(signed, "utf8"), keys.privateKeyPem).toString("base64url");
  const { sessionToken, epoch } = await client.hello({ ...helloBody, proof: { challengeId, signatureBase64url: signature } });
  return { sessionToken, epoch, bootNonce };
}

export async function enrollAndHello(cfg: RunnerConfig, enrollToken: string): Promise<{ sessionToken: string; epoch: number; credential: string; bootNonce: string }> {
  const keys = loadOrCreateKeys(cfg.stateDir);
  const credPath = join(cfg.stateDir, "credential.txt");
  let credential = existsSync(credPath) ? readFileSync(credPath, "utf8").trim() : "";
  if (!credential) {
    const enrolled = await new GovernorClient(cfg).enroll(enrollToken, keys.publicKeyPem, cfg.runnerId);
    credential = enrolled.credential;
    writeFileSync(credPath, credential, { mode: 0o600 });
  }
  const { sessionToken, epoch, bootNonce } = await challengeHello(cfg, credential);
  return { sessionToken, epoch, credential, bootNonce };
}

// Runner sessions expire after 15 minutes (Governor-issued); a long-lived
// supervisor must re-hello with its stored credential to stay authorized.
// Re-hello also refreshes the 5-minute capability observations. Passing the
// boot nonce of the first hello keeps the epoch: running attempts continue.
export async function refreshSession(cfg: RunnerConfig, bootNonce?: string): Promise<{ sessionToken: string; epoch: number }> {
  const credPath = join(cfg.stateDir, "credential.txt");
  const credential = existsSync(credPath) ? readFileSync(credPath, "utf8").trim() : "";
  if (!credential) throw new Error("runner credential missing; cannot refresh session");
  return challengeHello(cfg, credential, bootNonce);
}

/**
 * What a resumed attempt is told about the changes it proposed earlier (ADR 0028): each one's outcome, in plain words, and that it must not
 * ask again. Empty for an attempt that proposed nothing before.
 */
export function settledEffectsNote(settled: ReadonlyArray<{ summary: string; outcome: string; result?: string }>): string {
  if (settled.length === 0) return "";
  const how: Record<string, string> = { applied: "was approved and made", absent: "was approved but did not happen; nothing was changed", declined: "was declined by a person; nothing was changed", expired: "expired unanswered; nothing was changed", revoked: "was withdrawn; nothing was changed", cancelled: "was cancelled; nothing was changed" };
  return `\n\n# Changes you proposed earlier in this task\nYou already investigated and proposed these. Do not propose them again. Write your final report now, saying plainly what became of each.\n${settled.map((entry, index) => `${index + 1}. ${entry.summary}: this change ${how[entry.outcome] ?? entry.outcome}.${entry.result ? ` It reported: ${entry.result}` : ""}`).join("\n")}`;
}

/** What a resumed attempt is told: the conversation before it is its own earlier work, not a new task. */
export const RESUME_NOTE = "\n\n# Resuming earlier work\nThis conversation continues your own earlier attempt at this task, which stopped before it finished. Pick up from where it stopped; do not start over or repeat work you already did.";

/**
 * The hosted model routes the Governor offered this attempt (a check, a second attempt, ADR 0023), in the order they are tried. A route without
 * both prices would run hosted spend for free, and one without a key reference has nowhere to find its key; neither is accepted here.
 */
export function hostedRoutesOf(routes: ReadonlyArray<{ tier?: string; role?: string; routeId?: string; keyRef?: string; baseUrl?: string; model?: string; inputMicroUsdPerMTok?: number; outputMicroUsdPerMTok?: number; viaGateway?: boolean }> | undefined, gateway?: { baseUrl: (routeId: string) => string; token: string }): HostedRoute[] {
  const priced = (price: number | undefined): price is number => typeof price === "number" && price >= 1;
  return (routes ?? []).flatMap((route): HostedRoute[] => {
    if (route.tier !== "hosted" || !(route.role === "second-attempt" || route.role === "evaluator") || !route.routeId || !route.model || !priced(route.inputMicroUsdPerMTok) || !priced(route.outputMicroUsdPerMTok)) return [];
    const prices = { inputMicroUsdPerMTok: route.inputMicroUsdPerMTok, outputMicroUsdPerMTok: route.outputMicroUsdPerMTok };
    // A route through the Governor's gateway (ADR 0072) carries no key reference and no upstream address: the runner calls the gateway with its attempt's token.
    if (route.viaGateway === true) return gateway ? [{ routeId: route.routeId, keyRef: "", baseUrl: gateway.baseUrl(route.routeId), model: route.model, ...prices, gatewayToken: gateway.token }] : [];
    return route.keyRef && isKeyReference(route.keyRef) && route.baseUrl ? [{ routeId: route.routeId, keyRef: route.keyRef, baseUrl: route.baseUrl, model: route.model, ...prices }] : [];
  });
}

export async function runOnce(cfg: RunnerConfig, sessionToken: string | (() => string), runnerEpoch = 1, controls: RunnerControls = newRunnerControls()): Promise<boolean> {
  const client = new GovernorClient(cfg);
  // A function follows the supervisor's session through a refresh; a plain token is used as given.
  if (typeof sessionToken === "function") client.setTokenSource(sessionToken); else client.setToken(sessionToken);
  const offer = await client.claim(`claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (!offer) return false;
  controls.activeAttemptIds.add(offer.attemptId);
  const ackBody: Record<string, unknown> = { leaseId: offer.leaseId, jobFence: offer.jobFence };
  if (offer.execution.kind === "tool") ackBody["engine"] = { id: "tool-broker", adapterDigest: sha256Digest(new TextEncoder().encode("tool-broker:v1")), features: [] as string[] };
  const ack = await client.ack(offer.attemptId, ackBody);
  // Execution input travels as a digest-pinned CAS artifact, never inline.
  const artifactBytes = await client.executionArtifact(offer.attemptId, offer.execution.artifact.digest, offer.execution.artifact.bytes);
  const payload = JSON.parse(new TextDecoder().decode(artifactBytes)) as { kind?: string; input?: Record<string, unknown>; step?: Record<string, unknown>; evaluation?: EvaluationAssignment; modelRoutes?: Parameters<typeof hostedRoutesOf>[0]; contextPack?: { text?: string; unavailableTools?: Array<{ id: string; reason?: string }> }; skills?: Array<{ id: string; digest: string; text: string }>; resume?: { engineState: ArtifactRef; fromSessionId: string } };
  // The execution deadline is the lease: a monotonic clock (performance.now)
  // is armed from the ack's server lease expiry and refreshed by every
  // successful renewal, so wall-clock adjustments cannot extend the window.
  const leaseExpiresAt = ack.leaseExpiresAt ?? "";
  let monoDeadline = 0;
  const armDeadline = (expiresAt: string): void => {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (Number.isFinite(remaining) && remaining > 0) monoDeadline = performance.now() + remaining - 5_000;
  };
  armDeadline(leaseExpiresAt);

  let leaseLost = false;
  let abortReason: "lease" | "deadline" | undefined;
  const controller = new AbortController();
  const spool = DurableEventSpool.load(join(cfg.stateDir, "spool", `${offer.attemptId}.jsonl`));
  let eventSeq = spool.stats().lastSequence;
  // The engine that actually executes the attempt; reported with the event
  // batches so the Governor's session view names the real adapter and its
  // probe features, not a guess.
  let engineInfo: { id: string; adapterDigest: string; features: string[]; model?: string } | undefined;
  // A failed events POST leaves the journal untouched: the same batch replays
  // on the next flush, in order, after the Governor acknowledges the batch.
  const flushEvents = async (): Promise<void> => {
    const batch = spool.peek(128);
    if (batch.length === 0) return;
    try {
      await client.events(offer.attemptId, {
        leaseId: offer.leaseId, jobFence: offer.jobFence,
        ...(engineInfo ? { engine: engineInfo } : {}),
        events: batch.map((e) => ({ sequence: e.sequence, kind: e.kind, payload: e.payload })),
      });
      spool.commit(batch.map((e) => e.sequence));
    } catch (error) {
      if (error instanceof GovernorProtocolError) {
        // 409/410: attempt fenced server-side, journal is dead. Other statuses
        // are transient: the journal stays untouched and the batch replays.
        if (error.status === 409 || error.status === 410) spool.discard();
      } else throw error; // transport failure surfaces like a rejected round-trip did before
    }
  };
  const emit = async (kind: string, eventPayload: unknown): Promise<void> => {
    if (kind === "engine") {
      const event = eventPayload as { kind?: string; payload?: { engine?: { id: string; adapterDigest: string; features?: string[] } } };
      if (event.kind === "session.started" && event.payload?.engine) {
        engineInfo = { id: event.payload.engine.id, adapterDigest: event.payload.engine.adapterDigest, features: event.payload.engine.features ?? [], ...(engineInfo?.model ? { model: engineInfo.model } : {}) };
      }
    }
    eventSeq += 1;
    const pushed = spool.push({ sequence: eventSeq, kind, payload: eventPayload });
    if (pushed === "backpressure") throw new Error("event spool full; stopping bounded instead of growing memory");
    await flushEvents();
  };
  const renew = setInterval(() => {
    void client.renew(offer.attemptId, offer.leaseId, offer.jobFence)
      .then((r) => { if (r.leaseExpiresAt) armDeadline(r.leaseExpiresAt); }, () => { leaseLost = true; });
  }, 15_000);
  const watchdog = setInterval(() => {
    if (abortReason) return;
    if (controls.stopRequests.has(offer.attemptId)) {
      // Governor-requested stop: abort through the same cancellation path; the
      // adapter's confirmed termination decides the cleanup outcome.
      controls.stopRequests.delete(offer.attemptId);
      controller.abort(new Error("stop requested"));
      return;
    }
    if (leaseLost) { abortReason = "lease"; controller.abort(new Error("lease lost")); return; }
    if (monoDeadline && performance.now() >= monoDeadline) {
      abortReason = "deadline";
      controller.abort(new Error("lease deadline approached"));
    }
  }, 250);
  try {
    await emit("progress", { phase: "started", artifactId: offer.execution.artifact.artifactId });
    // Effect-class tools carry exact, current authority: the supervisor
    // acquires the attempt-scoped permit before the invocation runs.
    const effectClass = typeof (payload.step ?? {})["effectClass"] === "string" ? String((payload.step ?? {})["effectClass"]) : "read";
    let permit: { token: string; permitId: string } | undefined;
    if (effectClass !== "read") {
      const step = (payload.step ?? {}) as { target?: { targetId?: string } };
      const subjectDigest = sha256Digest(artifactBytes);
      const resourceKeys = [step.target?.targetId ? `target:${step.target.targetId}` : `ws:${offer.workspaceId}`];
      const granted = await client.permit(offer.attemptId, {
        invocationId: `inv-${offer.attemptId}`, subjectDigest, resourceKeys,
      });
      permit = { token: granted.token, permitId: granted.invocationId ?? `inv-${offer.attemptId}` };
      (payload as { invocationId?: string }).invocationId = granted.invocationId ?? `inv-${offer.attemptId}`;
    }
    let result: { ok: boolean; output: JsonValue; cleanupConfirmed?: boolean; checkpoint?: Checkpoint };
    const toolArtifacts: ArtifactRef[] = [];
    // Files an agent writes with files.write live in this attempt's own folder until the attempt ends well (run-output.ts); removed in every case.
    const outputs = new RunOutputDir(cfg.stateDir, offer.attemptId);
    const nestedToolReleases: ReleaseRef[] = [];
    // The credential this attempt's Brain tools act with is asked for on the first such call and lives only here (ADR 0042).
    const brainSession = new BrainSession(client, offer.attemptId);
    // What approved effect calls did, for the evidence bundle: each effect with its reconciled receipt, and the approvals it consumed.
    const nestedEffects: Array<{ invocationId: string; targetId: string; operation: string; outcome: "applied" | "absent" | "unknown"; receiptArtifact: ArtifactRef }> = [];
    const nestedApprovalIds: string[] = [];
    // Changes this attempt proposed and left held. When there are any, the attempt ends after its report and writes no evidence: the
    // attempt resumed once they are settled carries the receipts (ADR 0028).
    let heldProposals = 0;
    let routeReport: RouteReport[] = [];
    // A resumed attempt is told what became of each change proposed before; the ones that were made are evidence of this run.
    const settledEffects = ((payload as { effectOutcomes?: Array<{ proposalId: string; toolId: string; summary: string; approvalId: string; outcome: string; result?: string; invocationId?: string; targetId?: string; operation?: string; receiptArtifact?: ArtifactRef }> }).effectOutcomes) ?? [];
    for (const settled of settledEffects) {
      if (settled.receiptArtifact && settled.invocationId && settled.targetId && settled.operation && (settled.outcome === "applied" || settled.outcome === "absent")) {
        if (!toolArtifacts.some((known) => known.artifactId === settled.receiptArtifact!.artifactId)) toolArtifacts.push(settled.receiptArtifact);
        nestedEffects.push({ invocationId: settled.invocationId, targetId: settled.targetId, operation: settled.operation, outcome: settled.outcome, receiptArtifact: settled.receiptArtifact });
        nestedApprovalIds.push(settled.approvalId);
      }
    }
    if (offer.execution.kind === "agent") {
      const step = (payload.step ?? {}) as { task?: string; timeoutSeconds?: number; uses?: { release?: { id: string; digest: string } } };
      const ref = step.uses?.release;
      if (!ref) throw new Error("agent job has no pinned agent release");
      const asset = await client.agentInstructions(offer.configDigest, ref.id, ref.digest);
      // Skills the Governor loaded for this task are the agent's own pinned documents, added to its instructions as text; they carry no tools.
      const skills = payload.skills ?? [];
      for (const skill of skills) {
        if (!asset.agent.spec.skills?.some((pinned) => pinned.id === skill.id && pinned.digest === skill.digest)) throw new Error(`skill ${skill.id} is not pinned by agent ${ref.id}`);
      }
      const instructions = instructionsWithSkills(asset.instructions, skills);
      if (skills.length > 0) await emit("progress", { phase: "skills-loaded", skills: skills.map((skill) => ({ id: skill.id, digest: skill.digest })), instructionsDigest: sha256Digest(new TextEncoder().encode(instructions)) });
      const configured = cfg.engines ?? [process.env["BRAIN_RUNNER_ENGINE"] ?? "fixture"];
      // The engine must be configured here and provide the isolation this step's placement requires (ADR 0035): an engine that cannot is never used,
      // even when the runner also has one that can.
      const required = offer.placement?.isolation ?? "none stated";
      const engineConfigured = asset.agent.spec.engine.anyOf.find((id) => configured.includes(id) && isolationSatisfies(engineIsolation(id), required));
      // Tools the Governor found to have nothing to read for this task (no documents, no CSV files) are not offered to the model at all:
      // each call it would waste is a model round trip. The pinned allowlist above still bounds what could ever run.
      const withheld = new Set((payload.contextPack?.unavailableTools ?? []).map((tool) => tool.id));
      const offeredBindings = asset.toolBindings.filter((binding) => !withheld.has(binding.release.id));
      const offeredTools = asset.agent.spec.tools.filter((tool) => !withheld.has(tool.id));
      // A second attempt the Governor routed to the workspace's hosted model (ADR 0023); every other attempt stays on this runner's own model.
      // A route through the Governor's gateway is called with this attempt's own token, asked for now that the attempt runs; the key stays on the Governor host (ADR 0072).
      const gatewayToken = payload.modelRoutes?.some((route) => route.viaGateway === true) ? (await client.modelGatewayToken(offer.attemptId)).token : undefined;
      const hostedRoutes = hostedRoutesOf(payload.modelRoutes, gatewayToken ? { baseUrl: (routeId) => client.gatewayBaseUrl(routeId), token: gatewayToken } : undefined);
      const candidates = hostedRoutes.flatMap((route) => { const picked = selectEngine(engineConfigured, offeredBindings, route); return picked ? [{ route, engine: picked }] : []; });
      const engine = hostedRoutes.length > 0 ? candidates[0]?.engine : selectEngine(engineConfigured, offeredBindings);
      if (!engine) throw new Error(`none of the required engines (${asset.agent.spec.engine.anyOf.join(", ")}) is configured on this runner with the ${required} isolation this step requires`);
      const engineProbe = await engine.probe();
      // The model this attempt runs on, as the usage ledger attributes spend (#111): the hosted route's, else the runner's configured one, else the
      // engine's own default. An engine that names none (an ACP agent picks its own) reports none: nothing is invented.
      const modelId = hostedRoutes[0]?.model ?? process.env["BRAIN_LOCAL_MODEL_ID"] ?? engine.defaultModelId;
      engineInfo = { id: engineProbe.id, adapterDigest: engineProbe.adapterDigest, features: [...engineProbe.features], ...(modelId ? { model: modelId } : {}) };
      const task = promptWithContext(step.task ?? JSON.stringify(payload.input ?? {}), payload.contextPack) + settledEffectsNote(settledEffects) + (payload.resume ? RESUME_NOTE : "");
      const launcher = cfg.launcher ?? (LauncherClient.configured() ? LauncherClient.fromEnv() : undefined);
      const toolPins = (offer as { toolPins?: Record<string, string> }).toolPins;
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      let invocationCount = 0;
      // Steer delivery: heartbeat acks queue steering requests; the drain hands
      // them to the adapter at the next turn boundary, gated on the engine's
      // advertised features.
      let steer: ((messageId: string, message: string) => Promise<void>) | undefined;
      let pauseControl: { pause: () => Promise<void>; continue: () => Promise<void> } | undefined;
      const appliedPauseCommands = new Set<string>();
      const steerDrain = setInterval(() => {
        // Pause and continue: applied once per command id, never blocking one another (a continue must be able to cancel a pause still waiting for its boundary).
        for (let index = controls.pauseQueue.length - 1; index >= 0 && pauseControl; index--) {
          const request = controls.pauseQueue[index]!;
          if (request.attemptId !== offer.attemptId) continue;
          controls.pauseQueue.splice(index, 1);
          if (appliedPauseCommands.has(request.commandId)) continue;
          appliedPauseCommands.add(request.commandId);
          if (request.type === "pause-attempt") {
            void pauseControl.pause().then(
              () => emit("progress", { phase: "session-paused" }),
              (error: unknown) => emit("progress", { phase: "pause-not-taken", detail: error instanceof Error ? error.message : String(error) }),
            ).catch(() => undefined);
          } else {
            void pauseControl.continue().then(() => emit("progress", { phase: "session-continued" }), () => undefined).catch(() => undefined);
          }
        }
        if (!steer) return;
        for (let index = controls.steerQueue.length - 1; index >= 0; index--) {
          const request = controls.steerQueue[index]!;
          if (request.attemptId !== offer.attemptId) continue;
          controls.steerQueue.splice(index, 1);
          void steer(request.messageId, request.message).catch((error: unknown) => {
            void emit("progress", { phase: "steer-refused", detail: error instanceof Error ? error.message : String(error) });
          });
        }
      }, 500);
      // A resumed attempt continues a conversation the Governor holds, not one on this runner's disk (ADR 0068): download and verify it first.
      let resumeBytes: Uint8Array | undefined;
      let resumeRefusal: string | undefined;
      if (payload.resume) {
        try { resumeBytes = await client.resumeCheckpoint(offer.attemptId, payload.resume.engineState); }
        catch (e) { resumeRefusal = `The checkpoint could not be downloaded and verified, so this runner did not resume from it: ${e instanceof Error ? e.message : "unknown error"}`.slice(0, 500); }
      }
      const agentInput: Omit<Parameters<typeof runAgentExecution>[0], "engine" | "modelId"> = {
        attemptId: offer.attemptId, jobFence: offer.jobFence, leaseId: offer.leaseId,
        runnerId: cfg.runnerId, runnerEpoch, organizationId: offer.organizationId ?? "", workspaceId: offer.workspaceId,
        jobId: offer.jobId, configDigest: offer.configDigest, sourceRevision: offer.sourceRevision ?? offer.configDigest,
        instructions, task, ...(payload.resume ? { resumeFrom: payload.resume.engineState } : {}), ...(resumeBytes ? { resumeBytes } : {}), timeoutMs: (step.timeoutSeconds ?? 300) * 1000,
        maxTurns: asset.agent.spec.maxTurns, maxTokens: asset.agent.spec.maxTokens,
        outputCheck: outputContractCheck((payload as { outputSchema?: unknown }).outputSchema),
        maxMicroUsd: asset.agent.spec.maxMicroUsd, allowedTools: offeredTools,
        onSession: (handle) => {
          steer = handle.features.includes("steer")
            ? (messageId, message) => handle.steer(messageId, message)
            : undefined;
          pauseControl = handle.features.includes("pause") ? { pause: () => handle.pause(), continue: () => handle.continue() } : undefined;
        },
        executeTool: async (proposal) => {
          if (++invocationCount > asset.agent.spec.maxTurns) throw new Error("Agent tool-call budget exhausted");
          const binding = asset.toolBindings.find((candidate) => candidate.release.id === proposal.tool.id && candidate.release.digest === proposal.tool.digest);
          if (!binding || !asset.agent.spec.tools.some((allowed) => allowed.id === proposal.tool.id && allowed.digest === proposal.tool.digest)) throw new Error("Agent proposed an unauthorized tool or digest");
          if (!nestedToolReleases.some((tool) => tool.id === binding.release.id && tool.digest === binding.release.digest)) nestedToolReleases.push(binding.release);
          if (JSON.stringify(binding.target) !== JSON.stringify(proposal.target)) throw new Error("Agent tool target does not match the pinned target");
          if (sha256Digest(new TextEncoder().encode(JSON.stringify(proposal.input))) !== proposal.inputDigest) throw new Error("Agent tool input digest mismatch");
          const valid = ajv.compile(binding.inputSchema);
          if (!valid(proposal.input)) throw new Error(`Agent tool input rejected: ${ajv.errorsText(valid.errors)}`);
          const invocationId = proposal.proposalId;
          // A change is only proposed here (ADR 0028): the Governor records the approval and holds the change as its own job, which a runner
          // runs after a person decided it. This attempt does not wait; it is told the change is held and finishes its report.
          let proposed: Proposal | undefined;
          if (binding.effectClass !== "read") {
            proposed = await proposeEffect(client, offer.attemptId, { proposalId: proposal.proposalId, tool: proposal.tool, input: proposal.input as Record<string, unknown> });
            if (proposed.ok && proposed.held) { heldProposals++; await emit("progress", { phase: "change-proposed", detail: String(proposed.output["summary"] ?? "") }); }
          }
          const startedAt = new Date().toISOString();
          // Read tools that need data the sandboxed script cannot reach get it from a broker first; a refusal is a failed call with a
          // receipt, never a script run on missing data.
          const scriptInput = (base: Record<string, unknown>): Record<string, unknown> => { if (!OUTPUT_BROKERED.has(binding.release.id)) return base; const { content: _content, ...rest } = base; return rest; };
          // An external MCP tool (ADR 0064) is called by its pinned client inside a sandbox granted only its server host; the runner itself never connects.
          const mcpDeclaration = (offer as { toolMcp?: Record<string, McpDeclaration> }).toolMcp?.[binding.release.id];
          const mcpPrepared = mcpDeclaration && !proposed ? prepareMcpCall(mcpDeclaration, offer.workspaceId, offer.egressHosts) : undefined;
          const brokered = proposed || mcpPrepared ? undefined : await brokerRead(binding, proposal.input as Record<string, unknown>, offer.attemptId, client, launcher, outputs, { session: brainSession, proposalId: proposal.proposalId });
          const executed: { ok: boolean; output: JsonValue } = proposed
            ? proposed.ok ? { ok: true, output: proposed.output as unknown as JsonValue } : { ok: false, output: { error: proposed.error } as JsonValue }
            : mcpPrepared && !mcpPrepared.ok ? { ok: false as const, output: { error: mcpPrepared.error } as JsonValue }
            : brokered && !brokered.ok ? { ok: false as const, output: { error: brokered.error } as JsonValue } : await executeToolPayload({
              offer: { payload: { input: brokered ? { ...scriptInput(proposal.input as Record<string, unknown>), broker: brokered.data } : proposal.input as Record<string, unknown>, invocationId,
                step: { uses: { type: "tool", release: proposal.tool }, effectClass: binding.effectClass, target: binding.target } },
                execution: { kind: "tool" }, workspaceId: offer.workspaceId },
              cfg, signal: controller.signal, launcher, permit: undefined, toolPins, egressHosts: offer.egressHosts, mcp: mcpPrepared?.ok ? mcpPrepared.call : undefined,
              validatePermit: (token, id) => client.validatePermit(token, id),
              fetchPinnedTool: (toolId, digest) => client.toolScript(offer.configDigest, toolId, digest),
            });
          const bytes = new TextEncoder().encode(JSON.stringify(executed.output));
          const uploaded = await client.uploadArtifact(offer.attemptId, bytes, "application/json");
          const artifact = { ...uploaded, mediaType: "application/json", classification: "internal" as const };
          if (!toolArtifacts.some((known) => known.artifactId === artifact.artifactId)) toolArtifacts.push(artifact);
          await emit("effect", { phase: "governed-tool-result", proposalId: proposal.proposalId, invocationId, artifact });
          return { proposalId: proposal.proposalId, invocationId,
            receipt: { invocationId, attemptId: offer.attemptId, jobFence: offer.jobFence, result: executed.ok ? "succeeded" : "failed", startedAt, finishedAt: new Date().toISOString(), stdout: artifact, effects: [] },
            output: executed.output };
        },
        emit, signal: controller.signal,
      };
      // Routed attempts move to the next route on a quota refusal (ADR 0055); an unrouted one runs on this runner's own model.
      const agentResult = resumeRefusal !== undefined ? { ok: false, output: { error: resumeRefusal } as JsonValue, outputText: "" }
        : candidates.length > 0 ? await runAgentOnRoutes(agentInput, candidates) : await runAgentExecution({ ...agentInput, engine, modelId: process.env["BRAIN_LOCAL_MODEL_ID"] });
      routeReport = (agentResult as { routes?: RouteReport[] }).routes ?? [];
      // The conversation an unfinished attempt saved goes to the Governor as an artifact of this attempt, before the attempt completes, so any
      // eligible runner can resume it later (ADR 0068). It is never an event and never evidence. A conversation that cannot be uploaded (too
      // large, or the lease is gone) leaves no checkpoint rather than one nobody can use.
      const taken = (agentResult as { checkpoint?: Checkpoint }).checkpoint;
      const takenBytes = (agentResult as { checkpointBytes?: Uint8Array }).checkpointBytes;
      if (taken) {
        let shared: Checkpoint | undefined;
        if (taken.engineState && takenBytes && !leaseLost) {
          try {
            const stored = await client.uploadArtifact(offer.attemptId, takenBytes, taken.engineState.mediaType);
            shared = { ...taken, engineState: { ...taken.engineState, artifactId: stored.artifactId, digest: stored.digest, bytes: stored.bytes } };
          } catch { shared = undefined; }
        }
        if (shared) (agentResult as { checkpoint?: Checkpoint }).checkpoint = shared; else delete (agentResult as { checkpoint?: Checkpoint }).checkpoint;
      }
      if (agentResult.ok) {
        const outputBytes = new TextEncoder().encode(agentResult.outputText);
        const uploaded = await client.uploadArtifact(offer.attemptId, outputBytes, "text/plain");
        await emit("effect", { phase: "output-pinned", artifact: uploaded });
        // The files the agent wrote become artifacts of this attempt (and so of its evidence bundle); a failed attempt's files are dropped.
        const collected: Array<{ name: string; artifact: ArtifactRef }> = [];
        for (const file of outputs.collect()) {
          const stored = await client.uploadArtifact(offer.attemptId, file.bytes, file.mediaType);
          const artifact = { ...stored, mediaType: file.mediaType, classification: "internal" as const };
          if (!toolArtifacts.some((known) => known.artifactId === artifact.artifactId)) toolArtifacts.push(artifact);
          collected.push({ name: file.name, artifact });
        }
        if (collected.length > 0) await emit("effect", { phase: "run-output-collected", files: collected });
      }
      result = agentResult;
      clearInterval(steerDrain);
    } else {
    const launcher = cfg.launcher ?? (LauncherClient.configured() ? LauncherClient.fromEnv() : undefined);
    const toolPins = (offer as { toolPins?: Record<string, string> }).toolPins;
    // A direct tool step of a read tool whose data a broker supplies (a page, a document, a host command) gets it first, exactly as an agent's call does.
    const directTool = (payload.step as { uses?: { type?: string; release?: { id: string; digest: string } }; effectClass?: string } | undefined);
    let toolPayload = payload;
    let brokerRefusal: string | undefined;
    if (directTool?.uses?.type === "tool" && directTool.uses.release && (offer as { toolMcp?: Record<string, unknown> }).toolMcp?.[directTool.uses.release.id]) {
      // An external MCP tool is reachable only through an agent's validated, governed call, never as a bare workflow step.
      brokerRefusal = "an external MCP tool can be called only by an agent that lists it, not as a direct workflow step";
    } else if (directTool?.uses?.type === "tool" && directTool.uses.release && (directTool.effectClass ?? "read") === "read") {
      const binding = { release: directTool.uses.release, effectClass: "read", allowedHosts: (offer as { toolAllowedHosts?: Record<string, string[]> }).toolAllowedHosts?.[directTool.uses.release.id] } as unknown as Parameters<typeof brokerRead>[0];
      const brokered = await brokerRead(binding, (payload.input ?? {}) as Record<string, unknown>, offer.attemptId, client, launcher);
      if (brokered && !brokered.ok) brokerRefusal = brokered.error;
      else if (brokered) toolPayload = { ...payload, input: { ...(payload.input as Record<string, unknown>), broker: brokered.data } } as typeof payload;
    }
    if ((payload as { kind?: string }).kind === "act") {
      // The held change of an approved proposal (ADR 0028): this attempt exists only to make it, once, and report how it ended.
      const made = await performHeldEffect({ client, cfg, launcher, signal: controller.signal, attemptId: offer.attemptId, workspaceId: offer.workspaceId, configDigest: offer.configDigest, toolPins, toolMcp: (offer as { toolMcp?: Record<string, McpDeclaration> }).toolMcp, egressHosts: offer.egressHosts }, payload as unknown as ActPayload);
      result = { ok: made.ok, output: made.output };
    } else
    result = brokerRefusal !== undefined ? { ok: false, output: { error: brokerRefusal } as JsonValue } : await executeToolPayload({
      offer: { payload: toolPayload, execution: offer.execution, workspaceId: offer.workspaceId },
      cfg, signal: controller.signal, launcher, permit, toolPins, egressHosts: offer.egressHosts,
      validatePermit: (token, invocationId) => client.validatePermit(token, invocationId),
      fetchPinnedTool: (toolId, digest) => client.toolScript(offer.configDigest, toolId, digest),
      // The secrets this attempt's own tool declared arrive as short-lived credentials from the Governor, never from a runner-local store (ADR 0070).
      secrets: { mint: () => client.secretCredentials(offer.attemptId), validate: (ids) => client.validateSecretCredentials(offer.attemptId, ids) },
    });
    }
    const assignment = payload.evaluation;
    await emit("progress", { phase: "executed", ok: result.ok });
    const output = result.ok && assignment ? normalizeEvaluation(result.output,assignment) : result.output;
    const outcomeUnknown = leaseLost || abortReason !== undefined || result.cleanupConfirmed === false;
    let artifact: { artifactId: string; digest: string; bytes: number } | undefined;
    if (result.ok) {
      const outputBytes = new TextEncoder().encode(JSON.stringify(output));
      const uploaded = await client.uploadArtifact(offer.attemptId, outputBytes, "application/json");
      artifact = uploaded;
      await emit("effect", { phase: "output-pinned", artifact });
    }
    // An attempt that proposed changes ends here and says so: the Governor parks its job until they are settled (ADR 0028).
    const held = heldProposals > 0 && result.ok && !outcomeUnknown;
    await client.complete(offer.attemptId, {
      result: outcomeUnknown ? "unknown-outcome" : result.ok ? "succeeded" : "failed", output, jobFence: offer.jobFence, cleanupConfirmed: result.cleanupConfirmed ?? true,
      ...(held ? { held: true } : {}),
      ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
      ...(routeReport.length > 0 ? { modelRoutes: routeReport } : {}),
    });
    // A workflow with no evaluator (a tool test) claims no checks: there is nothing for a bundle to carry, and an empty one is refused.
    if (result.ok && !held && (payload as { kind?: string }).kind !== "act" && !assignment && offer.authorEvidence && offer.authorEvidence.claimedChecks.length > 0 && offer.workflowRunId && artifact) {
      const bundle = {
        contractVersion: "brain.evidence/v1",
        bundleId: `bundle-${offer.attemptId}`,
        organizationId: offer.organizationId ?? "",
        workspaceId: offer.workspaceId,
        workflowRunId: offer.workflowRunId,
        jobId: offer.jobId,
        attemptId: offer.attemptId,
        jobFence: offer.jobFence,
        sourceRevision: offer.sourceRevision ?? "",
        configDigest: offer.configDigest,
        workflowDigest: (offer as { workflowDigest?: string }).workflowDigest ?? offer.configDigest,
        primitiveVersions: (offer as { primitiveVersions?: Record<string, string> }).primitiveVersions ?? {},
        toolReleases: [...offer.authorEvidence.toolReleases, ...nestedToolReleases.filter((nested) => !offer.authorEvidence?.toolReleases.some((tool) => tool.id === nested.id && tool.digest === nested.digest))],
        artifacts: [{ ...artifact, mediaType: "application/json", classification: "internal" }, ...toolArtifacts.filter((known) => known.artifactId !== artifact.artifactId)],
        checks: offer.authorEvidence.claimedChecks,
        approvalIds: [...nestedApprovalIds],
        effects: [...nestedEffects],
        createdAt: new Date().toISOString(),
      };
      const submitted = await client.submitEvidence(bundle);
      await emit("effect", { phase: "author-bundle-submitted", bundleId: bundle.bundleId, digest: submitted.digest });
    }
    if (result.ok && assignment && !outcomeUnknown) {
      const checks = (output as unknown as { checks: VerificationVerdict["checks"] }).checks;
      const outcome = checks.some((c) => c.status === "failed") ? "rejected" : checks.every((c) => c.status === "passed") ? "verified" : "incomplete";
      for (const bundleDigest of assignment.bundleDigests) {
        const verdict: VerificationVerdict = { contractVersion:"brain.verdict/v1",bundleDigest,evaluatorAttemptId:offer.attemptId,evaluatorRelease:assignment.evaluatorRelease,
          independence:assignment.independence,outcome,checks,acceptedBy:cfg.runnerId,createdAt:new Date().toISOString() };
        await client.submitVerdict(offer.workspaceId, verdict);
      }
    }
    spool.discard();
    return true;
  } finally {
    clearInterval(renew);
    clearInterval(watchdog);
    controls.activeAttemptIds.delete(offer.attemptId);
    controls.stopRequests.delete(offer.attemptId);
    for (let index = controls.pauseQueue.length - 1; index >= 0; index--) if (controls.pauseQueue[index]!.attemptId === offer.attemptId) controls.pauseQueue.splice(index, 1);
    try { new RunOutputDir(cfg.stateDir, offer.attemptId).dispose(); } catch { /* an unusable attempt id never created a folder */ }
  }
}

/**
 * What the runner tells the Governor about the layer below it: whether its sandbox launcher (and Docker behind it) answers and every sandbox image is built. A runner with
 * no launcher configured has nothing to check. One miss is degraded, two in a row unhealthy: an unhealthy runner takes no new work, so
 * jobs wait instead of failing against a dead sandbox, and Health says the launcher is down so someone (or the host watchdog) restarts it.
 */
export function launcherHealthCheck(env: NodeJS.ProcessEnv = process.env, probe: () => Promise<{ docker: boolean; missingImages?: readonly string[] }> = () => LauncherClient.fromEnv().health()): () => Promise<"healthy" | "degraded" | "unhealthy"> {
  let misses = 0;
  return async () => {
    if (!env["BRAIN_LAUNCHER_SOCKET"]) return "healthy";
    try {
      const result = await probe();
      // Docker answering is not enough: with a sandbox image never built here every sandboxed step fails on its first container, so the engine is unusable.
      misses = result.docker && (result.missingImages ?? []).length === 0 ? 0 : misses + 1;
    } catch { misses += 1; }
    return misses === 0 ? "healthy" : misses === 1 ? "degraded" : "unhealthy";
  };
}

export async function startSupervisor(configurationChanged?: () => boolean): Promise<void> {
  const cfg: RunnerConfig = {
    governorUrl: process.env["BRAIN_GOVERNOR_URL"] ?? "http://127.0.0.1:3000",
    runnerId: process.env["BRAIN_RUNNER_ID"] ?? "runner-local-1",
    stateDir: process.env["BRAIN_RUNNER_STATE_DIR"] ?? join(process.cwd(), ".runner-state"),
    capabilities: (process.env["BRAIN_RUNNER_CAPABILITIES"] ?? "os:linux,arch:amd64,tool:fixture.echo,tool:fixture.verify,isolation:ephemeral-container").split(","),
    engines: (process.env["BRAIN_RUNNER_ENGINE"] ?? "fixture").split(",").map((id) => id.trim()).filter(Boolean),
    dataMounts: parseToolDataMounts(process.env["BRAIN_TOOL_DATA_MOUNTS"] ?? ""),
  };
  const enrollToken = process.env["BRAIN_RUNNER_ENROLL_TOKEN"] ?? "";
  const initial = await enrollAndHello(cfg, enrollToken);
  console.log(`Brain runner ${cfg.runnerId} connected`);
  // Session TTL is 15 minutes; refresh proactively at 10 and on any 401. The refresh re-hellos with this process's boot nonce, which
  // keeps the epoch and only replaces the token, and every client follows `session.token`, so running attempts continue and the
  // other slots keep claiming. The heartbeat just flags staleness.
  const session = { token: initial.sessionToken, epoch: initial.epoch, sinceMs: Date.now(), stale: false };
  const client = new GovernorClient(cfg);
  client.setToken(initial.sessionToken);
  const refresh = async (): Promise<void> => {
    const next = await refreshSession(cfg, initial.bootNonce);
    session.token = next.sessionToken;
    session.epoch = next.epoch;
    session.sinceMs = Date.now();
    session.stale = false;
    client.setToken(next.sessionToken);
    console.log(`Brain runner ${cfg.runnerId} session refreshed (epoch ${next.epoch})`);
  };
  let seq = 0;
  const controls = newRunnerControls();
  const launcherCheck = launcherHealthCheck();
  const heartbeatTimer = setInterval(() => {
    seq += 1;
    void Promise.all([availableEngines(cfg), launcherCheck()]).then(([probed, health]) => client.heartbeat({
      // Full RunnerHeartbeat body: command delivery sits on the declared shape.
      runnerId: cfg.runnerId,
      runnerEpoch: session.epoch,
      sequence: seq,
      health,
      observedFree: {
        cpuMillicores: cpus().length * 1000,
        memoryMb: Math.floor(freemem() / 1_048_576),
        diskMb: 0,
        slots: Math.max(0, runnerCapacity().slots - controls.activeAttemptIds.size),
      },
      activeAttemptIds: [...controls.activeAttemptIds],
      observedAt: new Date().toISOString(),
      capabilities: observedCapabilities(cfg, probed),
      engines: probed.engines,
    })).then((ack) => {
      // Stop is delivered until the session has ended and applied once however often it repeats; steer is delivered once and waits in
      // the queue for the attempt's turn boundary.
      for (const command of ack.commands ?? []) {
        if (command.type === "stop-attempt" && command.attemptId && controls.activeAttemptIds.has(command.attemptId)) {
          controls.stopRequests.add(command.attemptId);
          console.log(`Brain runner ${cfg.runnerId} stop requested for attempt ${command.attemptId}`);
        } else if ((command.type === "pause-attempt" || command.type === "continue-attempt") && command.attemptId && command.commandId) {
          // Repeated every heartbeat until the Governor has the runner's report: queued once.
          if (!controls.pauseQueue.some((queued) => queued.commandId === command.commandId)) controls.pauseQueue.push({ attemptId: command.attemptId, commandId: command.commandId, type: command.type });
        } else if (command.type === "steer" && command.attemptId) {
          controls.steerQueue.push({ attemptId: command.attemptId, messageId: command.commandId ?? `steer-${seq}`, message: command.text ?? "" });
        }
      }
    }, (error) => {
      if (error instanceof GovernorProtocolError && error.status === 401) session.stale = true;
      else { /* transient; the claim loop surfaces errors */ }
    });
  }, 15_000).unref();
  const slots = runnerCapacity().slots;
  try {
    await runClaimLoops({
      slots, session, refresh, configurationChanged,
      claimOnce: () => runOnce(cfg, () => session.token, session.epoch, controls),
    });
  } finally { clearInterval(heartbeatTimer); }
}

export interface ClaimLoopSession { token: string; sinceMs: number; stale: boolean }
export interface ClaimLoopOptions {
  slots: number;
  session: ClaimLoopSession;
  /** Replaces the session token (a re-hello). */
  refresh: () => Promise<void>;
  /** Claims and runs one attempt; false when there was no work. Resolves when that attempt is finished. */
  claimOnce: () => Promise<boolean>;
  configurationChanged?: (() => boolean) | undefined;
  /** The session is renewed once it is older than this (default 10 minutes; the Governor's session lives 15). */
  refreshAfterMs?: number;
  idleMs?: number;
  errorMs?: number;
}

/**
 * One claim loop per slot. Once the session token is old, ONE worker refreshes it (the others wait only for that hello) and every worker
 * goes on claiming: attempts that are running are never waited for, because a refresh keeps the epoch and every client follows the
 * current token. A 401 marks the session stale and has the same effect.
 */
export async function runClaimLoops(options: ClaimLoopOptions): Promise<void> {
  const { session } = options;
  const refreshAfterMs = options.refreshAfterMs ?? 10 * 60_000;
  let stopped = false;
  let refreshing: Promise<void> | undefined;
  const refreshIfDue = (): void => {
    if (!refreshing && (session.stale || Date.now() - session.sinceMs > refreshAfterMs)) refreshing = options.refresh().finally(() => { refreshing = undefined; });
    // A failed refresh is reported by the worker that awaits it, or retried by the next tick.
    refreshing?.catch(() => undefined);
  };
  // Every slot may be busy with a long attempt, so the refresh must not depend on a worker being free: a timer keeps the token young.
  const ticker = setInterval(refreshIfDue, Math.max(10, Math.min(30_000, refreshAfterMs / 4)));
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      try {
        if (options.configurationChanged?.()) { stopped = true; return; }
        refreshIfDue();
        if (refreshing) { await refreshing; continue; }
        const worked = await options.claimOnce();
        if (!worked) await new Promise((r) => setTimeout(r, options.idleMs ?? 2000));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/\b401\b/.test(msg) && !session.stale) { session.stale = true; continue; }
        console.error("runner loop error", msg);
        await new Promise((r) => setTimeout(r, options.errorMs ?? 3000));
      }
    }
  };
  try { await Promise.all(Array.from({ length: options.slots }, () => worker())); } finally { clearInterval(ticker); }
}
