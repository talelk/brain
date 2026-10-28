import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { domainDigest, sha256Digest } from "@brain/contracts";
import type { EvaluationAssignment, JsonValue, VerificationVerdict } from "@brain/contracts";
import { executeToolPayload, normalizeFixtureEvaluation } from "./tools/invoke";
import { DurableEventSpool } from "./spool-durable";
import { LauncherClient } from "./launcher-client";
import { runAgentExecution, selectEngine } from "./engines/run";

export interface RunnerConfig {
  readonly governorUrl: string;
  readonly runnerId: string;
  readonly stateDir: string;
  readonly capabilities: readonly string[];
  readonly groupToolsDir?: string;
  readonly transport?: typeof fetch;
}

async function req(cfg: RunnerConfig, token: string | undefined, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await (cfg.transport ?? fetch)(`${cfg.governorUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
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

async function challengeHello(cfg: RunnerConfig, credential: string): Promise<{ sessionToken: string; epoch: number }> {
  const keys = loadOrCreateKeys(cfg.stateDir);
  const chal = await req(cfg, undefined, "/runner/v1/challenges", { runnerId: cfg.runnerId, credential });
  if (chal.status !== 201) throw new Error(`challenge failed ${chal.status}`);
  const { challengeId, nonce } = chal.json as { challengeId: string; nonce: string };
  const bootNonce = `boot-${Date.now()}`;
  const helloBody = {
    contractVersion: "brain.runner/v1", runnerId: cfg.runnerId, bootNonce, runtimeVersion: "brain-runner/0.1.0",
    configDigest: `sha256:${"0".repeat(64)}`,
    capabilities: cfg.capabilities.map((capability) => ({ capability, observedAt: new Date().toISOString(), source: "runner-probe", verified: true, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() })),
    engines: [{ id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: [] }],
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

export async function runOnce(cfg: RunnerConfig, sessionToken: string): Promise<boolean> {
  const claim = await req(cfg, sessionToken, "/runner/v1/claim", { requestId: `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  if (claim.status === 204) return false;
  if (claim.status !== 200) throw new Error(`claim failed ${claim.status}: ${JSON.stringify(claim.json)}`);
  const offer = claim.json as { attemptId: string; jobId: string; workspaceId: string; leaseId: string; jobFence: number; configDigest: string; toolPins?: Record<string, string>; execution: { kind: string; artifact: { artifactId: string; digest: string; bytes: number } } };
  const ack = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/ack`, { leaseId: offer.leaseId, jobFence: offer.jobFence });
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
  // A failed events POST leaves the journal untouched: the same batch replays
  // on the next flush, in order, after the Governor acknowledges the batch.
  const flushEvents = async (): Promise<void> => {
    const batch = spool.peek(128);
    if (batch.length === 0) return;
    const sent = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/events`, {
      leaseId: offer.leaseId, jobFence: offer.jobFence,
      events: batch.map((e) => ({ sequence: e.sequence, kind: e.kind, payload: e.payload })),
    });
    if (sent.status === 200) spool.commit(batch.map((e) => e.sequence));
    else if (sent.status === 409 || sent.status === 410) spool.discard(); // attempt fenced server-side: journal is dead
  };
  const emit = async (kind: string, eventPayload: unknown): Promise<void> => {
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
    // T24: agent-kind executions run through the configured engine adapter;
    // tool/eval/merge kinds run the governed tool path.
    const engineConfigured = process.env["BRAIN_RUNNER_ENGINE"];
    if (offer.execution.kind === "agent") {
      const engine = selectEngine(engineConfigured);
      if (!engine) {
        const failed = { ok: false, output: { error: `no engine installed on this runner (BRAIN_RUNNER_ENGINE=${engineConfigured ?? "unset"}); agent execution refused` } as unknown as JsonValue };
        const doneFailed = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/complete`, {
          result: "failed", output: failed.output, jobFence: offer.jobFence, cleanupConfirmed: true,
        });
        if (doneFailed.status !== 200) throw new Error(`complete failed ${doneFailed.status}`);
        return true;
      }
      const agentResult = await runAgentExecution({
        engine, attemptId: offer.attemptId, jobFence: offer.jobFence, leaseId: offer.leaseId,
        runnerId: cfg.runnerId, organizationId: (offer as { organizationId?: string }).organizationId ?? "", workspaceId: offer.workspaceId,
        jobId: offer.jobId, configDigest: offer.configDigest,
        task: String((payload.step as { task?: string } | undefined)?.task ?? (payload.input as { message?: string } | undefined)?.message ?? "agent run"),
        modelId: engineConfigured, timeoutMs: 300_000,
        emit, signal: controller.signal,
      });
      const doneAgent = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/complete`, {
        result: leaseLost || abortReason !== undefined ? "unknown-outcome" : agentResult.ok ? "succeeded" : "failed",
        output: agentResult.output, jobFence: offer.jobFence, cleanupConfirmed: true,
      });
      if (doneAgent.status !== 200) throw new Error(`complete failed ${doneAgent.status}`);
      spool.discard();
      return true;
    }
    const launcher = LauncherClient.configured() ? LauncherClient.fromEnv() : undefined;
    const toolPins = (offer as { toolPins?: Record<string, string> }).toolPins;
    const result = await executeToolPayload({
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
    const assignment = payload.evaluation;
    await emit("progress", { phase: "executed", ok: result.ok });
    const output = result.ok && assignment ? normalizeFixtureEvaluation(result.output,assignment) : result.output;
    // Durable output trail: the exact result bytes are pinned in the CAS and
    // bound to the attempt, independent of the inline completion body.
    if (result.ok) {
      const outputBytes = new TextEncoder().encode(JSON.stringify(output));
      await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/artifacts`, {
        digest: sha256Digest(outputBytes), mediaType: "application/json",
        bytesBase64: Buffer.from(outputBytes).toString("base64"),
      }).then((r) => {
        if (r.status !== 201) throw new Error(`attempt artifact upload failed ${r.status}: ${JSON.stringify(r.json)}`);
        return emit("effect", { phase: "output-pinned", artifact: r.json });
      }).catch((e: unknown) => { void emit("error", { phase: "output-pin-failed", detail: e instanceof Error ? e.message : "upload failed" }); });
    }
    // A lost lease or a fired deadline means the effect may have happened
    // without authority to report it: never claim success, surface
    // outcome_unknown instead.
    const outcomeUnknown = leaseLost || abortReason !== undefined;
    const done = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/complete`, {
      result: outcomeUnknown ? "unknown-outcome" : result.ok ? "succeeded" : "failed", output, jobFence: offer.jobFence, cleanupConfirmed: true,
    });
    if (done.status !== 200) throw new Error(`complete failed ${done.status}: ${JSON.stringify(done.json)}`);
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
    capabilities: (process.env["BRAIN_RUNNER_CAPABILITIES"] ?? "os:linux,arch:amd64,tool:fixture.echo,tool:fixture.verify,engine:fixture,isolation:ephemeral-container").split(","),
  };
  const enrollToken = process.env["BRAIN_RUNNER_ENROLL_TOKEN"] ?? "";
  const initial = await enrollAndHello(cfg, enrollToken);
  console.log(`Brain runner ${cfg.runnerId} connected`);
  // Session TTL is 15 minutes; refresh proactively at 10 and on any 401.
  // Refresh happens only between runOnce calls so an in-flight attempt's
  // token is never revoked mid-flight; the heartbeat just flags staleness.
  const session = { token: initial.sessionToken, sinceMs: Date.now(), stale: false };
  const refresh = async (): Promise<void> => {
    const next = await refreshSession(cfg);
    session.token = next.sessionToken;
    session.sinceMs = Date.now();
    session.stale = false;
    console.log(`Brain runner ${cfg.runnerId} session refreshed (epoch ${next.epoch})`);
  };
  let seq = 0;
  setInterval(() => {
    seq += 1;
    void req(cfg, session.token, "/runner/v1/heartbeat", { sequence: seq }).then((r) => {
      if (r.status === 401) session.stale = true;
    }, () => { /* transient; claim loop surfaces errors */ });
  }, 15_000).unref();
  for (;;) {
    try {
      if (session.stale || Date.now() - session.sinceMs > 10 * 60_000) await refresh();
      const worked = await runOnce(cfg, session.token);
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
