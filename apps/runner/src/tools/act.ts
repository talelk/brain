import type { ArtifactRef, JsonValue } from "@brain/contracts";
import type { GovernorClient } from "../governor-client";
import type { LauncherClient } from "../launcher-client";
import type { RunnerConfig } from "../supervisor";
import { executeToolPayload } from "./invoke";
import { reasonOf, runEffect, type EffectClient, type EffectCall } from "./effects";

/**
 * The attempt of a held act job (ADR 0028): the approved change, made after the person decided, by an attempt that owns it. It takes the
 * one permit the approval allows (bound to this job's own attempt), starts the call, does the work through its broker and reports how it
 * ended with a receipt artifact. If the approval is no longer current, or the permit was already used, nothing is run and the job fails
 * with the plain reason: a change is never made on stale authority.
 */
export interface ActPayload {
  readonly input?: Record<string, unknown>;
  readonly act?: { proposalId: string; approvalId: string };
  readonly step?: { uses?: { release?: { id: string; digest: string } }; target?: { targetId: string; environmentId: string; preconditionDigest: string } };
}

export interface ActContext {
  readonly client: EffectClient & Pick<GovernorClient, "uploadArtifact" | "toolScript">;
  readonly cfg: RunnerConfig;
  readonly launcher: LauncherClient | undefined;
  readonly signal: AbortSignal;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly configDigest: string;
  readonly toolPins: Record<string, string> | undefined;
}

export async function performHeldEffect(context: ActContext, payload: ActPayload): Promise<{ ok: boolean; output: JsonValue; receipt?: ArtifactRef }> {
  const tool = payload.step?.uses?.release;
  const proposalId = payload.act?.proposalId;
  if (!tool || !proposalId || !payload.input || !payload.step?.target) return { ok: false, output: { error: "the held change carries no tool, proposal or arguments; nothing was run" } as unknown as JsonValue };
  const call: EffectCall = { proposalId, tool, input: payload.input };
  const { client, attemptId } = context;
  const body = { proposalId, tool, input: payload.input };
  let gate: { token: string; invocationId: string };
  try {
    const permit = await client.effectPermit(attemptId, body);
    await client.effectStart(attemptId, { ...body, token: permit.token });
    gate = { token: permit.token, invocationId: permit.invocationId };
  } catch (error) {
    return { ok: false, output: { error: `The change was not made: ${reasonOf(error)}` } as unknown as JsonValue };
  }
  const run = await runEffect(client, context.launcher, attemptId, call, gate);
  // Shaping the answer takes no authority (the change is done): the pinned tool script runs as a read step in the read sandbox with no
  // permit, so a slow change cannot outlive the permit's short validity and the report is always redacted.
  const shaped = run.result.ok
    ? await executeToolPayload({
      offer: { payload: { input: { ...payload.input, broker: run.result.data }, invocationId: gate.invocationId, step: { uses: { type: "tool", release: tool }, effectClass: "read", target: payload.step.target } }, execution: { kind: "tool" }, workspaceId: context.workspaceId },
      cfg: context.cfg, signal: context.signal, launcher: context.launcher, permit: undefined, toolPins: context.toolPins,
      validatePermit: (token, id) => client.validatePermit(token, id),
      fetchPinnedTool: (toolId, digest) => context.client.toolScript(context.configDigest, toolId, digest),
    })
    : { ok: false, output: { error: run.result.error } as unknown as JsonValue };
  let executed: { ok: boolean; output: JsonValue } = shaped;
  if (run.result.ok && !shaped.ok) {
    // The call is only a success when the change was applied; a report that could not be shaped still says what ran. Never the raw output:
    // it was not redacted. Only the status the launcher reported.
    const raw = run.result.data as { command?: unknown; exitCode?: unknown };
    executed = { ok: true, output: { command: raw.command ?? null, exitCode: raw.exitCode ?? null, note: "the change ran; its output could not be shaped, so it is not shown" } as unknown as JsonValue };
  }
  if (run.outcome !== "applied" && executed.ok) executed = { ok: false, output: { error: "the change did not complete", result: executed.output } as unknown as JsonValue };
  const bytes = new TextEncoder().encode(JSON.stringify(executed.output));
  const uploaded = await client.uploadArtifact(attemptId, bytes, "application/json");
  const receipt = { ...uploaded, mediaType: "application/json", classification: "internal" as const };
  // The permit's final state and the receipt the evidence bundle of the proposing job will carry.
  await client.effectFinish(attemptId, { proposalId, outcome: run.outcome, receiptDigest: receipt.digest });
  return { ok: run.outcome === "applied" && executed.ok, output: { outcome: run.outcome, receipt: receipt.digest, result: executed.output } as unknown as JsonValue, receipt };
}
