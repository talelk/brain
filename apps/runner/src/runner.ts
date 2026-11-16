import type { RunnerState } from "@brain/contracts";
import { join } from "node:path";
import { type AttemptContext, runAttempt } from "./attempt";
import type { RunnerConfig } from "./config";
import type { AbortCause } from "./engines/run";
import { ENGINE_SANDBOX_IMAGE } from "./engines/sandboxed";
import { createEngine, engineHosting, nativeToolsAllowed } from "./engines/select";
import { GovernorClient, GovernorError } from "./governor-client";
import { loadOrCreateKeys, readCredential, type RunnerKeys, signNonce, writeCredential } from "./keys";

export const RUNNER_VERSION = "brain-runner/0.1.0";
/** The capability a runner states itself, never the operator: an agent's native tools can run here. */
const NATIVE_TOOLS = "native-tools";

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
  private sandboxAvailable = false;

  private constructor(readonly cfg: RunnerConfig, readonly client: GovernorClient, private readonly keys: RunnerKeys, readonly runnerId: string) {}

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
    try { await runAttempt(context, offer, abort); } finally { this.running.delete(offer.attemptId); }
    return true;
  }

  /** Heartbeats and claims until the signal aborts; attempts that are running then are stopped. */
  async run(signal: AbortSignal): Promise<void> {
    const pause = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(done, ms); function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
    const beat = async (): Promise<void> => {
      while (!signal.aborted) {
        await this.heartbeat().catch((error: unknown) => { if (!(error instanceof GovernorError && error.status === 401)) console.error("runner heartbeat failed:", error instanceof Error ? error.message : error); });
        await pause(this.heartbeatMs);
      }
    };
    const slot = async (): Promise<void> => {
      while (!signal.aborted) {
        try { if (!(await this.runOnce())) await pause(2000); }
        catch (error) { console.error("runner attempt failed:", error instanceof Error ? error.message : error); await pause(3000); }
      }
    };
    signal.addEventListener("abort", () => { for (const attempt of this.running.values()) attempt.abort("stopped" satisfies AbortCause); }, { once: true });
    await Promise.all([beat(), ...Array.from({ length: this.cfg.slots }, () => slot())]);
  }
}
