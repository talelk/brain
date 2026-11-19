import type { RunnerState } from "@brain/contracts";
import { join } from "node:path";
import { type AttemptContext, runAttempt } from "./attempt";
import { sweepCaches } from "./cache";
import type { RunnerConfig } from "./config";
import type { AbortCause } from "./engines/run";
import { ENGINE_SANDBOX_IMAGE } from "./engines/sandboxed";
import { createEngine, engineHosting, nativeToolsAllowed } from "./engines/select";
import { GovernorClient, GovernorError } from "./governor-client";
import { loadOrCreateKeys, readCredential, type RunnerKeys, signNonce, writeCredential } from "./keys";

/** The reason a request did not get through, as one short phrase: the error code of the connection (ECONNREFUSED, ETIMEDOUT) before its message. */
export function causeOf(error: unknown): string {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The Governor being unreachable, told once: one line when it begins, one when it ends, and the pause between tries grows meanwhile. */
export class Outage {
  private since: number | undefined;
  private failures = 0;
  constructor(private readonly governorUrl: string, private readonly nowMs: () => number = Date.now, private readonly write: (line: string) => void = console.error) {}
  /** What went wrong, from where; logged only when it is the first failure of an outage. Returns how long to wait before trying again. */
  failed(source: string, error: unknown, attemptId?: string): number {
    this.failures++;
    if (this.since === undefined) {
      this.since = this.nowMs();
      this.write(`runner ${source} failed: ${causeOf(error)} at ${this.governorUrl}${attemptId ? ` (attempt ${attemptId})` : ""}; retrying with backoff`);
    }
    return Math.min(30_000, 3000 * 2 ** Math.min(this.failures - 1, 4));
  }
  /** A request got through. */
  ok(): void {
    if (this.since !== undefined) this.write(`runner reconnected after ${Math.round((this.nowMs() - this.since) / 1000)} s`);
    this.since = undefined;
    this.failures = 0;
  }
}

export const RUNNER_VERSION = "brain-runner/0.1.0";
/** The capability a runner states itself, never the operator: an agent's native tools can run here. */
const NATIVE_TOOLS = "native-tools";
const SWEEP_EVERY_MS = 6 * 3_600_000;

/**
 * A runner: one enrolled identity, its session with the Governor, and the attempts it runs. `Runner.connect` enrols on the first start
 * (a one-use token and the runner's public key), then proves the key by signing a challenge and says hello. `run` keeps the session
 * alive, heartbeats and claims work in as many loops as the runner has slots; `runOnce` claims and runs a single attempt, which is how a
 * test drives a runner step by step.
 */
export class Runner {
  private readonly running = new Map<string, AbortController>();
  private sessionExpiresAt = 0;
  private heartbeatMs = 15_000;
  private sweptAt = 0;
  private sandboxAvailable = false;
  private readonly outage: Outage;
  private readonly failedAttempts = new WeakMap<object, string>();

  private constructor(readonly cfg: RunnerConfig, readonly client: GovernorClient, private readonly keys: RunnerKeys, readonly runnerId: string) { this.outage = new Outage(cfg.governorUrl); }

  static async connect(cfg: RunnerConfig): Promise<Runner> {
    const keys = loadOrCreateKeys(cfg.stateDir);
    const client = new GovernorClient({ governorUrl: cfg.governorUrl, blobDir: join(cfg.stateDir, "blobs"), ...(cfg.transport ? { transport: cfg.transport } : {}) });
    let runnerId = readCredential(cfg.stateDir);
    if (!runnerId) {
      if (!cfg.enrollToken) throw new Error("this runner is not enrolled yet: start it once with BRAIN_RUNNER_ENROLL_TOKEN set to a token from the Governor");
      runnerId = (await client.enroll({ token: cfg.enrollToken, name: cfg.name, publicKeyPem: keys.publicKeyPem })).runnerId;
      writeCredential(cfg.stateDir, runnerId);
    }
    const runner = new Runner(cfg, client, keys, runnerId);
    await runner.hello();
    client.reauthenticate = () => runner.hello();
    return runner;
  }

  /** Whether engines can run in sandboxes right now: a launcher that answers, with Docker up and the engine image built. */
  private async probeSandbox(): Promise<boolean> {
    if (!this.cfg.launcher) return false;
    try { const health = await this.cfg.launcher.health(); return health.docker && !health.missingImages.includes(ENGINE_SANDBOX_IMAGE); } catch { return false; }
  }

  /**
   * What the runner tells the Governor it is: the engines that can start here, the operator's capabilities, and `native-tools` when at
   * least one of those engines can be given its own tools (it runs sandboxed, or it is the fixture).
   */
  private async state(): Promise<RunnerState> {
    this.sandboxAvailable = await this.probeSandbox();
    const engines: string[] = [];
    for (const id of this.cfg.engines) {
      const hosting = engineHosting(id, this.sandboxAvailable);
      // An engine that runs in a sandbox is in the sandbox image; one that runs here is asked whether it can start.
      if (hosting === "sandboxed" ? createEngine(id) !== undefined : hosting !== "unavailable" && (await createEngine(id)?.probe().catch(() => undefined))?.ready === true) engines.push(id);
    }
    const native = engines.some((id) => nativeToolsAllowed(engineHosting(id, this.sandboxAvailable)));
    // The fixture answers for the engines it stands in for: the Governor offers this runner the agents written for them.
    if (engines.includes("fixture")) engines.push(...(this.cfg.fixtureFor ?? []).filter((id) => !engines.includes(id)));
    const capabilities = [...new Set([...this.cfg.capabilities.filter((name) => name !== NATIVE_TOOLS), ...(native ? [NATIVE_TOOLS] : [])])];
    return { capabilities, engines, slots: this.cfg.slots, freeSlots: Math.max(0, this.cfg.slots - this.running.size), version: RUNNER_VERSION };
  }

  /** Proves the enrolled key by challenge and takes a new session token. Running attempts keep running: only the token changes. */
  async hello(): Promise<void> {
    const challenge = await this.client.challenge({ runnerId: this.runnerId });
    const session = await this.client.hello({ ...(await this.state()), runnerId: this.runnerId, challengeId: challenge.challengeId, signature: signNonce(challenge.nonce, this.keys.privateKeyPem) });
    this.client.setToken(session.sessionToken);
    this.sessionExpiresAt = session.expiresAt;
    this.heartbeatMs = Math.max(1000, session.heartbeatMs);
  }

  /** One heartbeat: what the runner is and runs; the attempts the Governor names in its answer are stopped. */
  async heartbeat(): Promise<void> {
    // What the runner keeps between attempts is a cache, forgotten after a week, and only while nothing runs.
    if (this.running.size === 0 && Date.now() - this.sweptAt > SWEEP_EVERY_MS) { this.sweptAt = Date.now(); sweepCaches(this.cfg.stateDir); }
    // The session is renewed well before it ends, so no request of a running attempt meets an expired token.
    if (Date.now() > this.sessionExpiresAt - Math.max(60_000, this.heartbeatMs * 3)) await this.hello();
    const answer = await this.client.heartbeat({ ...(await this.state()), running: [...this.running.keys()] });
    for (const attemptId of answer.stop) this.running.get(attemptId)?.abort("stopped" satisfies AbortCause);
  }

  /** Claims one attempt and runs it to its end. False when there was no work. */
  async runOnce(): Promise<boolean> {
    const { offer } = await this.client.claim({ freeSlots: Math.max(0, this.cfg.slots - this.running.size) });
    if (!offer) return false;
    const abort = new AbortController();
    this.running.set(offer.attemptId, abort);
    const context: AttemptContext = { cfg: this.cfg, client: this.client, privateKeyPem: this.keys.privateKeyPem, sandboxAvailable: this.sandboxAvailable };
    try { await runAttempt(context, offer, abort); }
    catch (error) { if (typeof error === "object" && error !== null) this.failedAttempts.set(error, offer.attemptId); throw error; }
    finally { this.running.delete(offer.attemptId); }
    return true;
  }

  /** Heartbeats and claims until the signal aborts; attempts that are running then are stopped, and `run` returns once they have ended (or after a grace period). */
  async run(signal: AbortSignal): Promise<void> {
    const pause = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(done, ms); function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
    const beat = async (): Promise<void> => {
      while (!signal.aborted) {
        let wait = this.heartbeatMs;
        try { await this.heartbeat(); this.outage.ok(); }
        catch (error) {
          if (isUnreachable(error)) wait = Math.max(wait, this.outage.failed("heartbeat", error));
          else if (!(error instanceof GovernorError && error.status === 401)) console.error(`runner heartbeat failed: ${causeOf(error)}`);
        }
        await pause(wait);
      }
    };
    const slot = async (): Promise<void> => {
      while (!signal.aborted) {
        try { const worked = await this.runOnce(); this.outage.ok(); if (!worked) await pause(2000); }
        catch (error) {
          if (isUnreachable(error)) await pause(this.outage.failed("attempt", error, typeof error === "object" && error !== null ? this.failedAttempts.get(error) : undefined));
          else { console.error(`runner attempt failed: ${error instanceof Error ? error.message : String(error)}`); await pause(3000); }
        }
      }
    };
    const grace = new Promise<void>((resolve) => signal.addEventListener("abort", () => { for (const attempt of this.running.values()) attempt.abort("lease" satisfies AbortCause); setTimeout(resolve, 10_000).unref(); }, { once: true }));
    await Promise.race([Promise.all([beat(), ...Array.from({ length: this.cfg.slots }, () => slot())]), grace]);
  }
}

/** A request that never reached the Governor (a refused or dropped connection, a timeout) rather than one it answered. */
const isUnreachable = (error: unknown): boolean => !(error instanceof GovernorError) && error instanceof Error && (error.name === "TypeError" || error.name === "TimeoutError" || error.name === "AbortError" || /fetch failed|ECONN|ETIMEDOUT/u.test(causeOf(error)));
