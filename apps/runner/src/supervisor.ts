import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { cpus, freemem } from "node:os";
import { join } from "node:path";
import { domainDigest, sha256Digest } from "@brain/contracts";
import type { ArtifactRef, EvaluationAssignment, JsonValue, ReleaseRef, VerificationVerdict } from "@brain/contracts";
import Ajv2020 from "ajv/dist/2020.js";
import { executeToolPayload, normalizeEvaluation } from "./tools/invoke";
import { brokerRead } from "./tools/broker-read";
import { DurableEventSpool } from "./spool-durable";
import { GovernorClient, GovernorProtocolError } from "./governor-client";
import { LauncherClient } from "./launcher-client";
import { payloadValidator } from "@brain/contracts/validate";
import { promptWithContext, runAgentExecution, selectEngine } from "./engines/run";

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
   * name. This is host configuration, not workflow configuration: a workflow
   * spec cannot add a mount it was not given.
   */
  readonly dataMounts?: readonly string[];
}

/**
 * Live controls delivered through heartbeat acks. Stop aborts the current
 * attempt through the existing watchdog path; steer is queued and handed to
 * the engine adapter at the next turn boundary (feature-gated).
 */
export interface RunnerControls {
  stopRequests: Set<string>;
  steerQueue: Array<{ attemptId: string; messageId: string; message: string }>;
  activeAttemptId?: string | undefined;
}

export function newRunnerControls(): RunnerControls {
  return { stopRequests: new Set(), steerQueue: [] };
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

async function availableEngines(cfg: RunnerConfig) {
  const available = [];
  for (const id of cfg.engines ?? ["fixture"]) {
    const engine = selectEngine(id);
    if (!engine) continue;
    const info = await engine.probe();
    if (info.features.includes("sessions")) available.push(info);
  }
  return available;
}

async function challengeHello(cfg: RunnerConfig, credential: string): Promise<{ sessionToken: string; epoch: number }> {
  const keys = loadOrCreateKeys(cfg.stateDir);
  const client = new GovernorClient(cfg);
  const { challengeId, nonce } = await client.challenge(cfg.runnerId, credential);
  const bootNonce = `boot-${Date.now()}`;
  const engines = await availableEngines(cfg);
  const capabilities = [...new Set([...cfg.capabilities.filter((cap) => !/^engine(:|-feature:)/u.test(cap)), ...engines.map((engine) => `engine:${engine.id}`), ...engines.flatMap((engine) => engine.features.map((feature) => `engine-feature:${engine.id}:${feature}`))])];
  const helloBody = {
    contractVersion: "brain.runner/v1", runnerId: cfg.runnerId, bootNonce, runtimeVersion: "brain-runner/0.1.0",
    configDigest: `sha256:${"0".repeat(64)}`,
    capabilities: capabilities.map((capability) => ({ capability, observedAt: new Date().toISOString(), source: "runner-probe", verified: true, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() })),
    engines,
    capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 1 },
    isolationModes: ["ephemeral-container"],
  };
  const helloDigest = domainDigest("brain:runner-hello:v1", helloBody as unknown as JsonValue);
  const signed = JSON.stringify({ challengeId, nonce, runnerId: cfg.runnerId, bootNonce, helloDigest });
  const signature = sign(null, Buffer.from(signed, "utf8"), keys.privateKeyPem).toString("base64url");
  const { sessionToken, epoch } = await client.hello({ ...helloBody, proof: { challengeId, signatureBase64url: signature } });
  return { sessionToken, epoch };
}

export async function enrollAndHello(cfg: RunnerConfig, enrollToken: string): Promise<{ sessionToken: string; epoch: number; credential: string }> {
  const keys = loadOrCreateKeys(cfg.stateDir);
  const credPath = join(cfg.stateDir, "credential.txt");
  let credential = existsSync(credPath) ? readFileSync(credPath, "utf8").trim() : "";
  if (!credential) {
    const enrolled = await new GovernorClient(cfg).enroll(enrollToken, keys.publicKeyPem, cfg.runnerId);
    credential = enrolled.credential;
    writeFileSync(credPath, credential, { mode: 0o600 });
  }
  const { sessionToken, epoch } = await challengeHello(cfg, credential);
  return { sessionToken, epoch, credential };
}

// Runner sessions expire after 15 minutes (Governor-issued); a long-lived
// supervisor must re-hello with its stored credential to stay authorized.
// Re-hello also refreshes the 5-minute capability observations.
export async function refreshSession(cfg: RunnerConfig): Promise<{ sessionToken: string; epoch: number }> {
  const credPath = join(cfg.stateDir, "credential.txt");
  const credential = existsSync(credPath) ? readFileSync(credPath, "utf8").trim() : "";
  if (!credential) throw new Error("runner credential missing; cannot refresh session");
  return challengeHello(cfg, credential);
}

export async function runOnce(cfg: RunnerConfig, sessionToken: string, runnerEpoch = 1, controls: RunnerControls = newRunnerControls()): Promise<boolean> {
  const client = new GovernorClient(cfg);
  client.setToken(sessionToken);
  const offer = await client.claim(`claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (!offer) return false;
  controls.activeAttemptId = offer.attemptId;
  const ackBody: Record<string, unknown> = { leaseId: offer.leaseId, jobFence: offer.jobFence };
  if (offer.execution.kind === "tool") ackBody["engine"] = { id: "tool-broker", adapterDigest: sha256Digest(new TextEncoder().encode("tool-broker:v1")), features: [] as string[] };
  const ack = await client.ack(offer.attemptId, ackBody);
  // Execution input travels as a digest-pinned CAS artifact, never inline.
  const artifactBytes = await client.executionArtifact(offer.attemptId, offer.execution.artifact.digest, offer.execution.artifact.bytes);
  const payload = JSON.parse(new TextDecoder().decode(artifactBytes)) as { kind?: string; input?: Record<string, unknown>; step?: Record<string, unknown>; evaluation?: EvaluationAssignment; contextPack?: { text?: string } };
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
  let engineInfo: { id: string; adapterDigest: string; features: string[] } | undefined;
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
        engineInfo = { id: event.payload.engine.id, adapterDigest: event.payload.engine.adapterDigest, features: event.payload.engine.features ?? [] };
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
    let result: { ok: boolean; output: JsonValue; cleanupConfirmed?: boolean };
    const toolArtifacts: ArtifactRef[] = [];
    const nestedToolReleases: ReleaseRef[] = [];
    if (offer.execution.kind === "agent") {
      const step = (payload.step ?? {}) as { task?: string; timeoutSeconds?: number; uses?: { release?: { id: string; digest: string } } };
      const ref = step.uses?.release;
      if (!ref) throw new Error("agent job has no pinned agent release");
      const asset = await client.agentInstructions(offer.configDigest, ref.id, ref.digest);
      const instructions = asset.instructions;
      const configured = cfg.engines ?? [process.env["BRAIN_RUNNER_ENGINE"] ?? "fixture"];
      const engineConfigured = asset.agent.spec.engine.anyOf.find((id) => configured.includes(id));
      const engine = selectEngine(engineConfigured, asset.toolBindings);
      if (!engine) throw new Error(`none of the required engines (${asset.agent.spec.engine.anyOf.join(", ")}) is configured on this runner`);
      const engineProbe = await engine.probe();
      engineInfo = { id: engineProbe.id, adapterDigest: engineProbe.adapterDigest, features: [...engineProbe.features] };
      const task = promptWithContext(step.task ?? JSON.stringify(payload.input ?? {}), payload.contextPack);
      const launcher = LauncherClient.configured() ? LauncherClient.fromEnv() : undefined;
      const toolPins = (offer as { toolPins?: Record<string, string> }).toolPins;
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      let invocationCount = 0;
      // Steer delivery: heartbeat acks queue steering requests; the drain hands
      // them to the adapter at the next turn boundary, gated on the engine's
      // advertised features.
      let steer: ((messageId: string, message: string) => Promise<void>) | undefined;
      const steerDrain = setInterval(() => {
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
      const agentResult = await runAgentExecution({
        engine, attemptId: offer.attemptId, jobFence: offer.jobFence, leaseId: offer.leaseId,
        runnerId: cfg.runnerId, runnerEpoch, organizationId: offer.organizationId ?? "", workspaceId: offer.workspaceId,
        jobId: offer.jobId, configDigest: offer.configDigest, sourceRevision: offer.sourceRevision ?? offer.configDigest,
        instructions, task, modelId: process.env["BRAIN_LOCAL_MODEL_ID"], timeoutMs: (step.timeoutSeconds ?? 300) * 1000,
        maxTurns: asset.agent.spec.maxTurns, maxTokens: asset.agent.spec.maxTokens,
        outputCheck: outputContractCheck((payload as { outputSchema?: unknown }).outputSchema),
        maxMicroUsd: asset.agent.spec.maxMicroUsd, allowedTools: asset.agent.spec.tools,
        onSession: (handle) => {
          steer = handle.features.includes("steer")
            ? (messageId, message) => handle.steer(messageId, message)
            : undefined;
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
          let invocationId = proposal.proposalId;
          let nestedPermit: { token: string; permitId: string } | undefined;
          if (binding.effectClass !== "read") {
            const subjectDigest = domainDigest("brain:agent-tool:v1", { tool: proposal.tool, inputDigest: proposal.inputDigest, target: proposal.target, attemptId: offer.attemptId });
            const granted = await client.permit(offer.attemptId, { invocationId, subjectDigest, resourceKeys: [`target:${binding.target.targetId}`] });
            invocationId = granted.invocationId ?? invocationId;
            nestedPermit = { token: granted.token, permitId: invocationId };
          }
          const startedAt = new Date().toISOString();
          // Read tools that need data the sandboxed script cannot reach get it from a broker first; a refusal is a failed call with a
          // receipt, never a script run on missing data.
          const brokered = await brokerRead(binding, proposal.input as Record<string, unknown>, offer.attemptId, client);
          const executed = brokered && !brokered.ok ? { ok: false as const, output: { error: brokered.error } as JsonValue } : await executeToolPayload({
            offer: { payload: { input: brokered ? { ...(proposal.input as Record<string, unknown>), broker: brokered.data } : proposal.input as Record<string, unknown>, invocationId,
              step: { uses: { type: "tool", release: proposal.tool }, effectClass: binding.effectClass, target: binding.target } },
              execution: { kind: "tool" }, workspaceId: offer.workspaceId },
            cfg, signal: controller.signal, launcher, permit: nestedPermit, toolPins,
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
      });
      if (agentResult.ok) {
        const outputBytes = new TextEncoder().encode(agentResult.outputText);
        const uploaded = await client.uploadArtifact(offer.attemptId, outputBytes, "text/plain");
        await emit("effect", { phase: "output-pinned", artifact: uploaded });
      }
      result = agentResult;
      clearInterval(steerDrain);
    } else {
    const launcher = LauncherClient.configured() ? LauncherClient.fromEnv() : undefined;
    const toolPins = (offer as { toolPins?: Record<string, string> }).toolPins;
    result = await executeToolPayload({
      offer: { payload, execution: offer.execution, workspaceId: offer.workspaceId },
      cfg, signal: controller.signal, launcher, permit, toolPins,
      validatePermit: (token, invocationId) => client.validatePermit(token, invocationId),
      fetchPinnedTool: (toolId, digest) => client.toolScript(offer.configDigest, toolId, digest),
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
    await client.complete(offer.attemptId, {
      result: outcomeUnknown ? "unknown-outcome" : result.ok ? "succeeded" : "failed", output, jobFence: offer.jobFence, cleanupConfirmed: result.cleanupConfirmed ?? true,
    });
    if (result.ok && !assignment && offer.authorEvidence && offer.workflowRunId && artifact) {
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
        approvalIds: [],
        effects: [],
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
    if (controls.activeAttemptId === offer.attemptId) controls.activeAttemptId = undefined;
  }
}

export async function startSupervisor(configurationChanged?: () => boolean): Promise<void> {
  const cfg: RunnerConfig = {
    governorUrl: process.env["BRAIN_GOVERNOR_URL"] ?? "http://127.0.0.1:3000",
    runnerId: process.env["BRAIN_RUNNER_ID"] ?? "runner-local-1",
    stateDir: process.env["BRAIN_RUNNER_STATE_DIR"] ?? join(process.cwd(), ".runner-state"),
    capabilities: (process.env["BRAIN_RUNNER_CAPABILITIES"] ?? "os:linux,arch:amd64,tool:fixture.echo,tool:fixture.verify,isolation:ephemeral-container").split(","),
    engines: (process.env["BRAIN_RUNNER_ENGINE"] ?? "fixture").split(",").map((id) => id.trim()).filter(Boolean),
    dataMounts: (process.env["BRAIN_TOOL_DATA_MOUNTS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  const enrollToken = process.env["BRAIN_RUNNER_ENROLL_TOKEN"] ?? "";
  const initial = await enrollAndHello(cfg, enrollToken);
  console.log(`Brain runner ${cfg.runnerId} connected`);
  // Session TTL is 15 minutes; refresh proactively at 10 and on any 401.
  // Refresh happens only between runOnce calls so an in-flight attempt's
  // token is never revoked mid-flight; the heartbeat just flags staleness.
  const session = { token: initial.sessionToken, epoch: initial.epoch, sinceMs: Date.now(), stale: false };
  const client = new GovernorClient(cfg);
  client.setToken(initial.sessionToken);
  const refresh = async (): Promise<void> => {
    const next = await refreshSession(cfg);
    session.token = next.sessionToken;
    session.epoch = next.epoch;
    session.sinceMs = Date.now();
    session.stale = false;
    client.setToken(next.sessionToken);
    console.log(`Brain runner ${cfg.runnerId} session refreshed (epoch ${next.epoch})`);
  };
  let seq = 0;
  const controls = newRunnerControls();
  const heartbeatTimer = setInterval(() => {
    seq += 1;
    void availableEngines(cfg).then((engines) => client.heartbeat({
      // Full RunnerHeartbeat body: command delivery sits on the declared shape.
      runnerId: cfg.runnerId,
      runnerEpoch: session.epoch,
      sequence: seq,
      health: "healthy",
      observedFree: {
        cpuMillicores: cpus().length * 1000,
        memoryMb: Math.floor(freemem() / 1_048_576),
        diskMb: 0,
        slots: controls.activeAttemptId ? 0 : 1,
      },
      activeAttemptIds: controls.activeAttemptId ? [controls.activeAttemptId] : [],
      observedAt: new Date().toISOString(),
      capabilities: [...cfg.capabilities.filter((cap) => !/^engine(:|-feature:)/u.test(cap)), ...engines.map((engine) => `engine:${engine.id}`), ...engines.flatMap((engine) => engine.features.map((feature) => `engine-feature:${engine.id}:${feature}`))]
        .map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+300000).toISOString() })),
    })).then((ack) => {
      // At-most-once delivery: the Governor deleted the control rows when it
      // built this ack. Stop joins the watchdog path; steer waits in the
      // queue for the attempt's turn boundary.
      for (const command of ack.commands ?? []) {
        if (command.type === "stop-attempt" && command.attemptId) {
          controls.stopRequests.add(command.attemptId);
          console.log(`Brain runner ${cfg.runnerId} stop requested for attempt ${command.attemptId}`);
        } else if (command.type === "steer" && command.attemptId) {
          controls.steerQueue.push({ attemptId: command.attemptId, messageId: command.commandId ?? `steer-${seq}`, message: command.text ?? "" });
        }
      }
    }, (error) => {
      if (error instanceof GovernorProtocolError && error.status === 401) session.stale = true;
      else { /* transient; the claim loop surfaces errors */ }
    });
  }, 15_000).unref();
  try { for (;;) {
    try {
      if (configurationChanged?.()) return;
      if (session.stale || Date.now() - session.sinceMs > 10 * 60_000) await refresh();
      const worked = await runOnce(cfg, session.token, session.epoch, controls);
      if (!worked) await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b401\b/.test(msg) && !session.stale) {
        session.stale = true;
        try { await refresh(); continue; } catch { /* fall through to backoff */ }
      }
      console.error("runner loop error", msg);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  } finally { clearInterval(heartbeatTimer); }
}
