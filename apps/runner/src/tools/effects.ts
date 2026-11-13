import type { JsonValue } from "@brain/contracts";
import { GovernorProtocolError, type GovernorClient } from "../governor-client";
import type { LauncherClient } from "../launcher-client";
import type { BrokerResult } from "./brokers";

/**
 * Effect tools on the runner (ADR 0024, ADR 0028). A call that changes something outside Brain is only proposed by the attempt that wants
 * it: the attempt ends and the Governor holds the call as its own job. After a person approved it, that held job's attempt (here) takes
 * the one permit the approval allows, starts the call, does the work through a broker (the trusted launcher for the host, the Governor
 * for ticket, message and pull request) and reports how it ended. A refusal, an expiry or a permit already used is a plain failed call;
 * nothing was changed.
 */

/** Effect tools whose work is a named privileged command on the host; the launcher owns the argv. */
export const LAUNCHER_EFFECTS: Readonly<Record<string, { command: string; argument: string }>> = {
  "host.restart": { command: "docker.restart", argument: "container" },
  "host.reload": { command: "service.reload", argument: "service" },
};
/** Effect tools the Governor performs because the credentials live there. */
export const GOVERNOR_EFFECTS: ReadonlySet<string> = new Set(["ticket.create", "message.send", "git.open-pr"]);

export type EffectClient = Pick<GovernorClient, "effectRequest" | "effectPermit" | "effectStart" | "effectRun" | "effectFinish" | "validatePermit">;

export interface EffectCall {
  readonly proposalId: string;
  readonly tool: { id: string; digest: string };
  readonly input: Record<string, unknown>;
}

export function reasonOf(error: unknown): string {
  if (error instanceof GovernorProtocolError) {
    const body = error.body as { detail?: string; title?: string } | null;
    return body?.detail ?? body?.title ?? `the Governor refused (${error.status})`;
  }
  return error instanceof Error ? error.message : "the call could not be sent";
}

/** What the proposing attempt learns from the proposal. A held change is not a result: the answer says so, and what to do next. */
export type Proposal = { readonly ok: true; readonly held: boolean; readonly output: Record<string, unknown> } | { readonly ok: false; readonly error: string };

/**
 * Proposes a change and moves on (ADR 0028). The attempt does not wait for the decision: the Governor records the approval, holds the
 * change as its own job and runs it after the decision. A change this task already proposed (same tool, same arguments) is answered with
 * what became of it, so a resumed attempt never asks twice. A refusal (a container off the allow-list, a runner group that may not touch
 * the host) is a normal failed call with a plain reason.
 */
export async function proposeEffect(client: Pick<EffectClient, "effectRequest">, attemptId: string, call: EffectCall): Promise<Proposal> {
  try {
    const proposed = await client.effectRequest(attemptId, { proposalId: call.proposalId, tool: call.tool, input: call.input });
    if (proposed.outcome || (proposed.duplicate && !proposed.held)) {
      const how: Record<string, string> = { applied: "was approved and made", absent: "was approved but did not happen; nothing was changed", declined: "was declined; nothing was changed", expired: "expired unanswered; nothing was changed", revoked: "was withdrawn; nothing was changed", cancelled: "was cancelled; nothing was changed" };
      return { ok: true, held: false, output: { status: "already-decided", outcome: proposed.outcome ?? proposed.state, summary: proposed.summary, ...(proposed.result ? { result: proposed.result } : {}), note: `This change ${how[proposed.outcome ?? ""] ?? `is ${proposed.state}`}. Do not propose it again; say in your report what became of it.` } };
    }
    return { ok: true, held: true, output: { status: "awaiting-approval", approvalId: proposed.approvalId, summary: proposed.summary, expiresAt: proposed.expiresAt, note: "Recorded. A person decides this change and, if they approve it, Brain makes it after you finish: you cannot see its result now. Do not call this tool again for the same change. Finish your report now and say plainly that the change is proposed and waits for approval." } };
  } catch (error) {
    return { ok: false, error: `The change was not proposed: ${reasonOf(error)}` };
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
