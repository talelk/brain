import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { domainDigest, sha256Digest } from "@brain/contracts";
import type { Agent, ArtifactRef, EngineToolBinding, EvaluationAssignment, JsonValue, ReleaseRef, VerificationVerdict } from "@brain/contracts";
import Ajv2020 from "ajv/dist/2020.js";
import { executeToolPayload, normalizeEvaluation } from "./tools/invoke";
import { DurableEventSpool } from "./spool-durable";
import { LauncherClient } from "./launcher-client";
import { runAgentExecution, selectEngine } from "./engines/run";

export interface RunnerConfig {
  readonly governorUrl: string;
  readonly runnerId: string;
  readonly stateDir: string;
  readonly capabilities: readonly string[];
  readonly engines?: readonly string[];
  readonly groupToolsDir?: string;
  readonly transport?: typeof fetch;
}

async function req(cfg: RunnerConfig, token: string | undefined, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await (cfg.transport ?? fetch)(`${cfg.governorUrl.replace(/\/$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
}

async function reqBytes(cfg: RunnerConfig, token: string, path: string): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await (cfg.transport ?? fetch)(`${cfg.governorUrl.replace(/\/$/, "")}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
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
  const chal = await req(cfg, undefined, "/runner/v1/challenges", { runnerId: cfg.runnerId, credential });
  if (chal.status !== 201) throw new Error(`challenge failed ${chal.status}`);
  const { challengeId, nonce } = chal.json as { challengeId: string; nonce: string };
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
  const hello = await req(cfg, undefined, "/runner/v1/hello", { ...helloBody, proof: { challengeId, signatureBase64url: signature } });
  if (hello.status !== 200) throw new Error(`hello failed ${hello.status}: ${JSON.stringify(hello.json)}`);
  const { sessionToken, epoch } = hello.json as { sessionToken: string; epoch: number };
  return { sessionToken, epoch };
}

export async function enrollAndHello(cfg: RunnerConfig, enrollToken: string): Promise<{ sessionToken: string; epoch: number; credential: string }> {
  const keys = loadOrCreateKeys(cfg.stateDir);
  const credPath = join(cfg.stateDir, "credential.txt");
  let credential = existsSync(credPath) ? readFileSync(credPath, "utf8").trim() : "";
  if (!credential) {
    const enrolled = await req(cfg, undefined, "/runner/v1/enroll", { token: enrollToken, publicKey: keys.publicKeyPem, runnerId: cfg.runnerId });
    if (enrolled.status !== 201) throw new Error(`enroll failed ${enrolled.status}: ${JSON.stringify(enrolled.json)}`);
    credential = (enrolled.json as { credential: string }).credential;
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

export async function runOnce(cfg: RunnerConfig, sessionToken: string, runnerEpoch = 1): Promise<boolean> {
  const claim = await req(cfg, sessionToken, "/runner/v1/claim", { requestId: `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  if (claim.status === 204) return false;
  if (claim.status !== 200) throw new Error(`claim failed ${claim.status}: ${JSON.stringify(claim.json)}`);
  const offer = claim.json as { attemptId: string; jobId: string; workspaceId: string; organizationId?: string; workflowRunId?: string; attemptNumber?: number; sourceRevision?: string; leaseId: string; jobFence: number; configDigest: string; toolPins?: Record<string, string>; authorEvidence?: { toolReleases: { id: string; digest: string }[]; claimedChecks: unknown[] }; execution: { kind: string; artifact: { artifactId: string; digest: string; bytes: number } } };
  const ackBody: Record<string, unknown> = { leaseId: offer.leaseId, jobFence: offer.jobFence };
  if (offer.execution.kind === "tool") ackBody["engine"] = { id: "tool-broker", adapterDigest: sha256Digest(new TextEncoder().encode("tool-broker:v1")) };
  const ack = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/ack`, ackBody);
  if (ack.status !== 200) throw new Error(`ack failed ${ack.status}`);
  // Execution input travels as a digest-pinned CAS artifact, never inline.
  const artifactRes = await reqBytes(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/artifact`);
  if (artifactRes.status !== 200) throw new Error(`execution artifact fetch failed ${artifactRes.status}`);
  if (sha256Digest(artifactRes.bytes) !== offer.execution.artifact.digest || artifactRes.bytes.length !== offer.execution.artifact.bytes) {
    throw new Error("execution artifact digest/size mismatch; refusing to run");
  }
  const payload = JSON.parse(new TextDecoder().decode(artifactRes.bytes)) as { kind?: string; input?: Record<string, unknown>; step?: Record<string, unknown>; evaluation?: EvaluationAssignment };
  // The execution deadline is the lease: a monotonic clock (performance.now)
  // is armed from the ack's server lease expiry and refreshed by every
  // successful renewal, so wall-clock adjustments cannot extend the window.
  let leaseExpiresAt = "";
  {
    const ackBody = ack.json as { leaseExpiresAt?: string };
    leaseExpiresAt = ackBody.leaseExpiresAt ?? "";
  }
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
  // batches so the Governor's session view names the real adapter, not a guess.
  let engineInfo: { id: string; adapterDigest: string } | undefined;
  // A failed events POST leaves the journal untouched: the same batch replays
  // on the next flush, in order, after the Governor acknowledges the batch.
  const flushEvents = async (): Promise<void> => {
    const batch = spool.peek(128);
    if (batch.length === 0) return;
    const sent = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/events`, {
      leaseId: offer.leaseId, jobFence: offer.jobFence,
      ...(engineInfo ? { engine: engineInfo } : {}),
      events: batch.map((e) => ({ sequence: e.sequence, kind: e.kind, payload: e.payload })),
    });
    if (sent.status === 200) spool.commit(batch.map((e) => e.sequence));
    else if (sent.status === 409 || sent.status === 410) spool.discard(); // attempt fenced server-side: journal is dead
  };
  const emit = async (kind: string, eventPayload: unknown): Promise<void> => {
    if (kind === "engine") {
      const event = eventPayload as { kind?: string; payload?: { engine?: { id: string; adapterDigest: string } } };
      if (event.kind === "session.started" && event.payload?.engine) engineInfo = event.payload.engine;
    }
    eventSeq += 1;
    const pushed = spool.push({ sequence: eventSeq, kind, payload: eventPayload });
    if (pushed === "backpressure") throw new Error("event spool full; stopping bounded instead of growing memory");
    await flushEvents();
  };
  const renew = setInterval(() => {
    void req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/renew`, { leaseId: offer.leaseId, jobFence: offer.jobFence })
      .then((r) => {
        if (r.status !== 200) leaseLost = true;
        else {
          const body = r.json as { leaseExpiresAt?: string };
          if (body.leaseExpiresAt) armDeadline(body.leaseExpiresAt);
        }
      })
      .catch(() => { leaseLost = true; });
  }, 15_000);
  const watchdog = setInterval(() => {
    if (abortReason) return;
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
      const subjectDigest = sha256Digest(artifactRes.bytes);
      const resourceKeys = [step.target?.targetId ? `target:${step.target.targetId}` : `ws:${offer.workspaceId}`];
      const permitRes = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/permit`, {
        invocationId: `inv-${offer.attemptId}`, subjectDigest, resourceKeys,
      });
      if (permitRes.status !== 200) throw new Error(`effect permit refused ${permitRes.status}: ${JSON.stringify(permitRes.json)}`);
      const body = permitRes.json as { token: string; permitId: string; invocationId?: string };
      permit = { token: body.token, permitId: body.invocationId ?? `inv-${offer.attemptId}` };
      (payload as { invocationId?: string }).invocationId = body.invocationId ?? `inv-${offer.attemptId}`;
    }
    let result: { ok: boolean; output: JsonValue; cleanupConfirmed?: boolean };
    const toolArtifacts: ArtifactRef[] = [];
    const nestedToolReleases: ReleaseRef[] = [];
    if (offer.execution.kind === "agent") {
      const step = (payload.step ?? {}) as { task?: string; timeoutSeconds?: number; uses?: { release?: { id: string; digest: string } } };
      const ref = step.uses?.release;
      if (!ref) throw new Error("agent job has no pinned agent release");
      const assetResponse = await req(cfg, sessionToken, `/runner/v1/releases/${encodeURIComponent(offer.configDigest)}/agents/${encodeURIComponent(ref.id)}/instructions`);
      if (assetResponse.status !== 200) throw new Error(`agent instruction fetch failed ${assetResponse.status}: ${JSON.stringify(assetResponse.json)}`);
      const asset = assetResponse.json as { agent: Agent; agentDigest: string; path: string; instructionsDigest: string; bytesBase64: string; toolBindings: EngineToolBinding[] };
      if (asset.agentDigest !== ref.digest || asset.agent.metadata.id !== ref.id || asset.path !== asset.agent.spec.instructionsPath) throw new Error("agent release identity does not match the job offer");
      const instructionBytes = new Uint8Array(Buffer.from(asset.bytesBase64, "base64"));
      if (sha256Digest(instructionBytes) !== asset.instructionsDigest) throw new Error("agent instruction digest mismatch");
      const instructions = new TextDecoder().decode(instructionBytes);
      const configured = cfg.engines ?? [process.env["BRAIN_RUNNER_ENGINE"] ?? "fixture"];
      const engineConfigured = asset.agent.spec.engine.anyOf.find((id) => configured.includes(id));
      const engine = selectEngine(engineConfigured, asset.toolBindings);
      if (!engine) throw new Error(`none of the required engines (${asset.agent.spec.engine.anyOf.join(", ")}) is configured on this runner`);
      const engineProbe = await engine.probe();
      engineInfo = { id: engineProbe.id, adapterDigest: engineProbe.adapterDigest };
      const task = step.task ?? JSON.stringify(payload.input ?? {});
      const launcher = LauncherClient.configured() ? LauncherClient.fromEnv() : undefined;
      const toolPins = (offer as { toolPins?: Record<string, string> }).toolPins;
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      let invocationCount = 0;
      const agentResult = await runAgentExecution({
        engine, attemptId: offer.attemptId, jobFence: offer.jobFence, leaseId: offer.leaseId,
        runnerId: cfg.runnerId, runnerEpoch, organizationId: offer.organizationId ?? "", workspaceId: offer.workspaceId,
        jobId: offer.jobId, configDigest: offer.configDigest, sourceRevision: offer.sourceRevision ?? offer.configDigest,
        instructions, task, modelId: process.env["BRAIN_LOCAL_MODEL_ID"], timeoutMs: (step.timeoutSeconds ?? 300) * 1000,
        maxTurns: asset.agent.spec.maxTurns, maxTokens: asset.agent.spec.maxTokens,
        maxMicroUsd: asset.agent.spec.maxMicroUsd, allowedTools: asset.agent.spec.tools,
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
            const permitRes = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/permit`, { invocationId, subjectDigest, resourceKeys: [`target:${binding.target.targetId}`] });
            if (permitRes.status !== 200) throw new Error(`nested effect permit refused ${permitRes.status}: ${JSON.stringify(permitRes.json)}`);
            const body = permitRes.json as { token: string; permitId: string; invocationId?: string };
            invocationId = body.invocationId ?? invocationId;
            nestedPermit = { token: body.token, permitId: invocationId };
          }
          const startedAt = new Date().toISOString();
          const executed = await executeToolPayload({
            offer: { payload: { input: proposal.input as Record<string, unknown>, invocationId,
              step: { uses: { type: "tool", release: proposal.tool }, effectClass: binding.effectClass, target: binding.target } },
              execution: { kind: "tool" }, workspaceId: offer.workspaceId },
            cfg, signal: controller.signal, launcher, permit: nestedPermit, toolPins,
            validatePermit: async (token, id) => {
              const validation = await req(cfg, sessionToken, "/runner/v1/permits/validate", { token, invocationId: id });
              return validation.status === 200 && (validation.json as { valid?: boolean }).valid === true;
            },
            fetchPinnedTool: async (toolId, digest) => {
              const fetched = await req(cfg, sessionToken, `/runner/v1/releases/${encodeURIComponent(offer.configDigest)}/tools/${encodeURIComponent(toolId)}`);
              if (fetched.status !== 200) throw new Error(`tool script fetch failed ${fetched.status}: ${JSON.stringify(fetched.json)}`);
              const body = fetched.json as { entrypoint: string; entrypointDigest: string; bytesBase64: string };
              if (body.entrypointDigest !== digest) throw new Error("release tool digest disagrees with the offer pin");
              return { entrypoint: body.entrypoint, bytes: new Uint8Array(Buffer.from(body.bytesBase64, "base64")) };
            },
          });
          const bytes = new TextEncoder().encode(JSON.stringify(executed.output));
          const uploaded = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/artifacts`, {
            digest: sha256Digest(bytes), mediaType: "application/json", bytesBase64: Buffer.from(bytes).toString("base64"),
          });
          if (uploaded.status !== 201) throw new Error(`tool output artifact upload failed ${uploaded.status}`);
          const artifact = { ...(uploaded.json as { artifactId: string; digest: string; bytes: number }), mediaType: "application/json", classification: "internal" as const };
          toolArtifacts.push(artifact);
          await emit("effect", { phase: "governed-tool-result", proposalId: proposal.proposalId, invocationId, artifact });
          return { proposalId: proposal.proposalId, invocationId,
            receipt: { invocationId, attemptId: offer.attemptId, jobFence: offer.jobFence, result: executed.ok ? "succeeded" : "failed", startedAt, finishedAt: new Date().toISOString(), stdout: artifact, effects: [] },
            output: executed.output };
        },
        emit, signal: controller.signal,
      });
      if (agentResult.ok) {
        const outputBytes = new TextEncoder().encode(agentResult.outputText);
        const uploaded = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/artifacts`, {
          digest: sha256Digest(outputBytes), mediaType: "text/plain", bytesBase64: Buffer.from(outputBytes).toString("base64"),
        });
        if (uploaded.status !== 201) throw new Error(`agent output artifact upload failed ${uploaded.status}`);
        await emit("effect", { phase: "output-pinned", artifact: uploaded.json });
      }
      result = agentResult;
    } else {
    const launcher = LauncherClient.configured() ? LauncherClient.fromEnv() : undefined;
    const toolPins = (offer as { toolPins?: Record<string, string> }).toolPins;
    result = await executeToolPayload({
      offer: { payload, execution: offer.execution, workspaceId: offer.workspaceId },
      cfg, signal: controller.signal, launcher, permit, toolPins,
      validatePermit: async (token, invocationId) => {
        const r = await req(cfg, sessionToken, "/runner/v1/permits/validate", { token, invocationId });
        return r.status === 200 && (r.json as { valid?: boolean }).valid === true;
      },
      fetchPinnedTool: async (toolId, digest) => {
        const res = await req(cfg, sessionToken, `/runner/v1/releases/${encodeURIComponent(offer.configDigest)}/tools/${encodeURIComponent(toolId)}`);
        if (res.status !== 200) throw new Error(`tool script fetch failed ${res.status}: ${JSON.stringify(res.json)}`);
        const body = res.json as { entrypoint: string; entrypointDigest: string; bytesBase64: string };
        if (body.entrypointDigest !== digest) throw new Error("release tool digest disagrees with the offer pin");
        return { entrypoint: body.entrypoint, bytes: new Uint8Array(Buffer.from(body.bytesBase64, "base64")) };
      },
    });
    }
    const assignment = payload.evaluation;
    await emit("progress", { phase: "executed", ok: result.ok });
    const output = result.ok && assignment ? normalizeEvaluation(result.output,assignment) : result.output;
    const outcomeUnknown = leaseLost || abortReason !== undefined || result.cleanupConfirmed === false;
    let artifact: { artifactId: string; digest: string; bytes: number } | undefined;
    if (result.ok) {
      const outputBytes = new TextEncoder().encode(JSON.stringify(output));
      const uploaded = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/artifacts`, {
        digest: sha256Digest(outputBytes), mediaType: "application/json",
        bytesBase64: Buffer.from(outputBytes).toString("base64"),
      });
      if (uploaded.status !== 201) throw new Error(`attempt artifact upload failed ${uploaded.status}: ${JSON.stringify(uploaded.json)}`);
      artifact = uploaded.json as { artifactId: string; digest: string; bytes: number };
      await emit("effect", { phase: "output-pinned", artifact });
    }
    const done = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/complete`, {
      result: outcomeUnknown ? "unknown-outcome" : result.ok ? "succeeded" : "failed", output, jobFence: offer.jobFence, cleanupConfirmed: result.cleanupConfirmed ?? true,
    });
    if (done.status !== 200) throw new Error(`complete failed ${done.status}: ${JSON.stringify(done.json)}`);
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
        artifacts: [{ ...artifact, mediaType: "application/json", classification: "internal" }, ...toolArtifacts],
        checks: offer.authorEvidence.claimedChecks,
        approvalIds: [],
        effects: [],
        createdAt: new Date().toISOString(),
      };
      const submitted = await req(cfg, sessionToken, "/runner/v1/evidence", bundle);
      if (submitted.status !== 201) throw new Error(`evidence submit failed ${submitted.status}: ${JSON.stringify(submitted.json)}`);
      await emit("effect", { phase: "author-bundle-submitted", bundleId: bundle.bundleId, digest: (submitted.json as { digest?: string }).digest });
    }
    if (result.ok && assignment && !outcomeUnknown) {
      const checks = (output as unknown as { checks: VerificationVerdict["checks"] }).checks;
      const outcome = checks.some((c) => c.status === "failed") ? "rejected" : checks.every((c) => c.status === "passed") ? "verified" : "incomplete";
      for (const bundleDigest of assignment.bundleDigests) {
        const verdict: VerificationVerdict = { contractVersion:"brain.verdict/v1",bundleDigest,evaluatorAttemptId:offer.attemptId,evaluatorRelease:assignment.evaluatorRelease,
          independence:assignment.independence,outcome,checks,acceptedBy:cfg.runnerId,createdAt:new Date().toISOString() };
        const accepted = await req(cfg,sessionToken,"/runner/v1/verdicts",{workspaceId:offer.workspaceId,verdict});
        if (accepted.status !== 200) throw new Error(`verdict not accepted ${accepted.status}: ${JSON.stringify(accepted.json)}`);
      }
    }
    spool.discard();
    return true;
  } finally {
    clearInterval(renew);
    clearInterval(watchdog);
  }
}

export async function startSupervisor(): Promise<void> {
  const cfg: RunnerConfig = {
    governorUrl: process.env["BRAIN_GOVERNOR_URL"] ?? "http://127.0.0.1:3000",
    runnerId: process.env["BRAIN_RUNNER_ID"] ?? "runner-local-1",
    stateDir: process.env["BRAIN_RUNNER_STATE_DIR"] ?? join(process.cwd(), ".runner-state"),
    capabilities: (process.env["BRAIN_RUNNER_CAPABILITIES"] ?? "os:linux,arch:amd64,tool:fixture.echo,tool:fixture.verify,isolation:ephemeral-container").split(","),
    engines: (process.env["BRAIN_RUNNER_ENGINE"] ?? "fixture").split(",").map((id) => id.trim()).filter(Boolean),
  };
  const enrollToken = process.env["BRAIN_RUNNER_ENROLL_TOKEN"] ?? "";
  const initial = await enrollAndHello(cfg, enrollToken);
  console.log(`Brain runner ${cfg.runnerId} connected`);
  // Session TTL is 15 minutes; refresh proactively at 10 and on any 401.
  // Refresh happens only between runOnce calls so an in-flight attempt's
  // token is never revoked mid-flight; the heartbeat just flags staleness.
  const session = { token: initial.sessionToken, epoch: initial.epoch, sinceMs: Date.now(), stale: false };
  const refresh = async (): Promise<void> => {
    const next = await refreshSession(cfg);
    session.token = next.sessionToken;
    session.epoch = next.epoch;
    session.sinceMs = Date.now();
    session.stale = false;
    console.log(`Brain runner ${cfg.runnerId} session refreshed (epoch ${next.epoch})`);
  };
  let seq = 0;
  setInterval(() => {
    seq += 1;
    void availableEngines(cfg).then((engines) => req(cfg, session.token, "/runner/v1/heartbeat", { sequence: seq,
      capabilities: [...cfg.capabilities.filter((cap) => !/^engine(:|-feature:)/u.test(cap)), ...engines.map((engine) => `engine:${engine.id}`), ...engines.flatMap((engine) => engine.features.map((feature) => `engine-feature:${engine.id}:${feature}`))]
        .map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+300000).toISOString() })),
    })).then((r) => {
      if (r.status === 401) session.stale = true;
    }, () => { /* transient; claim loop surfaces errors */ });
  }, 15_000).unref();
  for (;;) {
    try {
      if (session.stale || Date.now() - session.sinceMs > 10 * 60_000) await refresh();
      const worked = await runOnce(cfg, session.token, session.epoch);
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
}
