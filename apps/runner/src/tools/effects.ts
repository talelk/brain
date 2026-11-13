import type { JsonValue } from "@brain/contracts";
import { GovernorProtocolError, type GovernorClient } from "../governor-client";
import type { LauncherClient } from "../launcher-client";
import type { BrokerResult } from "./brokers";

/**
 * Effect tools on the runner (ADR 0024). A call that changes something outside Brain stops here until a person decided it. The runner
 * proposes the call, waits (without spending the attempt's time limit), takes the one permit an approval allows, starts the call, does
 * the work through a broker (the trusted launcher for the host, the Governor for ticket, message and pull request) and reports how it
 * ended. A refusal, an expiry or a permit that was already used is a normal failed call with a plain reason; nothing was changed.
 */

/** Effect tools whose work is a named privileged command on the host; the launcher owns the argv. */
export const LAUNCHER_EFFECTS: Readonly<Record<string, { command: string; argument: string }>> = {
  "host.restart": { command: "docker.restart", argument: "container" },
  "host.reload": { command: "service.reload", argument: "service" },
};
/** Effect tools the Governor performs because the credentials live there. */
export const GOVERNOR_EFFECTS: ReadonlySet<string> = new Set(["ticket.create", "message.send", "git.open-pr"]);

export type EffectClient = Pick<GovernorClient, "effectRequest" | "effectStatus" | "effectPermit" | "effectStart" | "effectRun" | "effectFinish" | "validatePermit">;

export interface EffectCall {
  readonly proposalId: string;
  readonly tool: { id: string; digest: string };
  readonly input: Record<string, unknown>;
}

export interface EffectWait {
  /** How often the decision is looked up. */
  readonly pollMs: number;
  /** Runs a wait outside the attempt's time limit. */
  readonly hold: <T>(work: Promise<T>) => Promise<T>;
  readonly signal: AbortSignal;
  /** Tells the person watching the mission what the call is waiting for. */
  readonly progress: (detail: string) => Promise<void>;
}

export type Gate = { readonly ok: true; readonly token: string; readonly invocationId: string; readonly approvalId: string } | { readonly ok: false; readonly error: string };

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); };
  signal.addEventListener("abort", abort, { once: true });
});

function reasonOf(error: unknown): string {
  if (error instanceof GovernorProtocolError) {
    const body = error.body as { detail?: string; title?: string } | null;
    return body?.detail ?? body?.title ?? `the Governor refused (${error.status})`;
  }
  return error instanceof Error ? error.message : "the call could not be sent";
}

/**
 * Stops the call at the gate: proposes it, waits for the decision and, once approved, takes the permit and starts the call. Returns
 * either what the broker needs to go on, or the plain reason the call did not run.
 */
export async function effectGate(client: EffectClient, attemptId: string, call: EffectCall, wait: EffectWait): Promise<Gate> {
  const body = { proposalId: call.proposalId, tool: call.tool, input: call.input };
  let approvalId: string;
  try {
    const proposed = await client.effectRequest(attemptId, body);
    approvalId = proposed.approvalId;
    let state = proposed.state;
    if (state === "pending") {
      await wait.progress(`waiting for a person to decide: ${proposed.summary}`);
      let lastNote = Date.now();
      const decided = await wait.hold((async () => {
        for (;;) {
          await sleep(wait.pollMs, wait.signal);
          const status = await client.effectStatus(attemptId, call.proposalId);
          if (status.state !== "pending") return status.state;
          if (Date.now() - lastNote > 30_000) { lastNote = Date.now(); await wait.progress(`still waiting for a person to decide: ${proposed.summary}`); }
        }
      })());
      state = decided;
    }
    if (state !== "approved") {
      const why = state === "rejected" ? "The owner declined this change." : state === "expired" ? "Nobody answered before the approval expired." : `The approval is ${state}.`;
      return { ok: false, error: `${why} Nothing was changed. Do not retry the same change; report that it was not approved.` };
    }
    const permit = await client.effectPermit(attemptId, body);
    await client.effectStart(attemptId, { ...body, token: permit.token });
    return { ok: true, token: permit.token, invocationId: permit.invocationId, approvalId };
  } catch (error) {
    if (wait.signal.aborted) throw error;
    return { ok: false, error: `The change was not made: ${reasonOf(error)}` };
  }
}

export type EffectRun = { readonly result: BrokerResult; readonly outcome: "applied" | "absent" | "unknown" };

/**
 * Does the work of a started call. The outcome is what the evidence records: applied when the work reported success, absent when it
 * was refused or failed before anything could have changed, unknown when it may have changed something and nobody can tell.
 */
export async function runEffect(client: EffectClient, launcher: Pick<LauncherClient, "hostCommand"> | undefined, attemptId: string, call: EffectCall, gate: { token: string; invocationId: string }): Promise<EffectRun> {
  const launcherEffect = LAUNCHER_EFFECTS[call.tool.id];
  if (launcherEffect) {
    if (!launcher) return { result: { ok: false, error: "host changes need the trusted launcher on this runner; none is configured" }, outcome: "absent" };
    const value = call.input[launcherEffect.argument];
    if (typeof value !== "string") return { result: { ok: false, error: `${launcherEffect.argument} must be text` }, outcome: "absent" };
    // The permit is checked once more at the last moment before the launcher is asked, exactly as for every other effect.
    if (!(await client.validatePermit(gate.token, gate.invocationId))) return { result: { ok: false, error: "the permit is no longer current; nothing was run" }, outcome: "absent" };
    try {
      const ran = await launcher.hostCommand(launcherEffect.command, { [launcherEffect.argument]: value }, "privileged", gate.invocationId);
      const data = { command: launcherEffect.command, exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, timedOut: ran.timedOut } as unknown as JsonValue;
      return { result: { ok: true, data }, outcome: ran.timedOut ? "unknown" : ran.exitCode === 0 ? "applied" : "absent" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "the launcher refused";
      // A refusal answered by the launcher (it names the reason) ran nothing; a broken connection may have run it.
      const refused = /already ran|not declared|privileged|does not match|not accepted|needs the invocationId|forbidden/u.test(message);
      return { result: { ok: false, error: message }, outcome: refused ? "absent" : "unknown" };
    }
  }
  if (GOVERNOR_EFFECTS.has(call.tool.id)) {
    try {
      const data = await client.effectRun(attemptId, { proposalId: call.proposalId, tool: call.tool, input: call.input, token: gate.token });
      return { result: { ok: true, data: data as JsonValue }, outcome: "applied" };
    } catch (error) {
      const unsure = error instanceof GovernorProtocolError ? error.status >= 500 : true;
      return { result: { ok: false, error: reasonOf(error) }, outcome: unsure ? "unknown" : "absent" };
    }
  }
  return { result: { ok: false, error: `${call.tool.id} has no effect broker on this runner` }, outcome: "absent" };
}
