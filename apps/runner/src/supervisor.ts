import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { domainDigest, sha256Digest } from "@brain/contracts";
import type { EvaluationAssignment, JsonValue, VerificationVerdict } from "@brain/contracts";
import { executeToolPayload, normalizeFixtureEvaluation } from "./tools/invoke";
import { EventSpool } from "./spool";

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
  const offer = claim.json as { attemptId: string; jobId: string; workspaceId: string; leaseId: string; jobFence: number; execution: { kind: string; artifact: { artifactId: string; digest: string; bytes: number } } };
  const ack = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/ack`, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  if (ack.status !== 200) throw new Error(`ack failed ${ack.status}`);
  // Execution input travels as a digest-pinned CAS artifact, never inline.
  const artifactRes = await reqBytes(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/artifact`);
  if (artifactRes.status !== 200) throw new Error(`execution artifact fetch failed ${artifactRes.status}`);
  if (sha256Digest(artifactRes.bytes) !== offer.execution.artifact.digest || artifactRes.bytes.length !== offer.execution.artifact.bytes) {
    throw new Error("execution artifact digest/size mismatch; refusing to run");
  }
  const payload = JSON.parse(new TextDecoder().decode(artifactRes.bytes)) as { kind?: string; input?: Record<string, unknown>; step?: Record<string, unknown>; evaluation?: EvaluationAssignment };
  const deadline = Date.now() + 55_000;
  let leaseLost = false;
  const spool = new EventSpool();
  let eventSeq = 0;
  const flushEvents = async (): Promise<void> => {
    const batch = spool.drain(128);
    if (batch.length === 0) return;
    await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/events`, {
      leaseId: offer.leaseId, jobFence: offer.jobFence,
      events: batch.map((e) => ({ sequence: e.sequence, kind: e.kind, payload: e.payload })),
    });
  };
  const emit = async (kind: string, eventPayload: unknown): Promise<void> => {
    eventSeq += 1;
    const pushed = spool.push({ sequence: eventSeq, kind, payload: eventPayload });
    if (pushed === "backpressure") throw new Error("event spool full; stopping bounded instead of growing memory");
    await flushEvents();
  };
  const renew = setInterval(() => {
    void req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/renew`, { leaseId: offer.leaseId, jobFence: offer.jobFence })
      .then((r) => { if (r.status !== 200) leaseLost = true; })
      .catch(() => { leaseLost = true; });
  }, 15_000);
  try {
    await emit("progress", { phase: "started", artifactId: offer.execution.artifact.artifactId });
    const result = await executeToolPayload({ payload, execution: offer.execution, workspaceId: offer.workspaceId } as unknown as { payload: { input?: Record<string, unknown>; step?: Record<string, unknown> }; execution: { kind: string }; workspaceId: string }, cfg);
    const assignment = payload.evaluation;
    await emit("progress", { phase: "executed", ok: result.ok });
    const output = result.ok && assignment ? normalizeFixtureEvaluation(result.output,assignment) : result.output;
    void deadline;
    // A lost lease means the effect may have happened without authority to
    // report it: never claim success, surface outcome_unknown instead.
    const done = await req(cfg, sessionToken, `/runner/v1/attempts/${offer.attemptId}/complete`, {
      result: leaseLost ? "unknown-outcome" : result.ok ? "succeeded" : "failed", output, jobFence: offer.jobFence, cleanupConfirmed: true,
    });
    if (done.status !== 200) throw new Error(`complete failed ${done.status}: ${JSON.stringify(done.json)}`);
    if (result.ok && assignment) {
      const checks = (output as unknown as { checks: VerificationVerdict["checks"] }).checks;
      const outcome = checks.some((c) => c.status === "failed") ? "rejected" : checks.every((c) => c.status === "passed") ? "verified" : "incomplete";
      for (const bundleDigest of assignment.bundleDigests) {
        const verdict: VerificationVerdict = { contractVersion:"brain.verdict/v1",bundleDigest,evaluatorAttemptId:offer.attemptId,evaluatorRelease:assignment.evaluatorRelease,
          independence:assignment.independence,outcome,checks,acceptedBy:cfg.runnerId,createdAt:new Date().toISOString() };
        const accepted = await req(cfg,sessionToken,"/runner/v1/verdicts",{workspaceId:offer.workspaceId,verdict});
        if (accepted.status !== 200) throw new Error(`verdict not accepted ${accepted.status}: ${JSON.stringify(accepted.json)}`);
      }
    }
    return true;
  } finally {
    clearInterval(renew);
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
