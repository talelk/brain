import type { ArtifactRef, JsonValue } from "@brain/contracts";
import type { GovernorClient } from "../governor-client";
import type { LauncherClient } from "../launcher-client";
import type { RunnerConfig } from "../supervisor";
import { executeToolPayload } from "./invoke";
import { prepareMcpCall, type McpDeclaration } from "./mcp";
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
  /** External MCP tools of the pinned release and the workspace's egress hosts (ADR 0062). */
  readonly toolMcp?: Record<string, McpDeclaration> | undefined;
  readonly egressHosts?: readonly string[] | undefined;
}

export async function performHeldEffect(context: ActContext, payload: ActPayload): Promise<{ ok: boolean; output: JsonValue; receipt?: ArtifactRef }> {
  const tool = payload.step?.uses?.release;
  const proposalId = payload.act?.proposalId;
  if (!tool || !proposalId || !payload.input || !payload.step?.target) return { ok: false, output: { error: "the held change carries no tool, proposal or arguments; nothing was run" } as unknown as JsonValue };
  const call: EffectCall = { proposalId, tool, input: payload.input };
  const { client, attemptId } = context;
  // An approved external MCP call is prepared before the permit is taken: a host the workspace does not allow, or a missing header secret,
  // ends the job with nothing started and the permit unused.
  const declaration = context.toolMcp?.[tool.id];
  const mcp = declaration ? prepareMcpCall(declaration, context.workspaceId, context.egressHosts) : undefined;
  if (mcp && !mcp.ok) return { ok: false, output: { error: `The change was not made: ${mcp.error}` } as unknown as JsonValue };
  const body = { proposalId, tool, input: payload.input };
  let gate: { token: string; invocationId: string };
  try {
    const permit = await client.effectPermit(attemptId, body);
    await client.effectStart(attemptId, { ...body, token: permit.token });
    gate = { token: permit.token, invocationId: permit.invocationId };
  } catch (error) {
    return { ok: false, output: { error: `The change was not made: ${reasonOf(error)}` } as unknown as JsonValue };
  }
  if (mcp?.ok) return finishMcpEffect(context, payload, call, gate, mcp.call);
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

/** Failures that happened before the call could have reached the server: nothing changed. */
const BEFORE_THE_CALL = /^tool exit 2\b|no longer current at the broker boundary|not pinned|runs only in the launcher|cannot be privileged/u;

/**
 * An approved external MCP call (ADR 0062): the pinned client runs in the sandbox granted only the declared server host, with the call's
 * permit checked once more at the broker boundary. The script's own answer is already shaped and scrubbed, so there is no second step.
 */
async function finishMcpEffect(context: ActContext, payload: ActPayload, call: EffectCall, gate: { token: string; invocationId: string }, mcp: NonNullable<Parameters<typeof executeToolPayload>[0]["mcp"]>): Promise<{ ok: boolean; output: JsonValue; receipt?: ArtifactRef }> {
  const { client, attemptId } = context;
  const executed = await executeToolPayload({
    offer: { payload: { input: payload.input as Record<string, unknown>, invocationId: gate.invocationId, step: { uses: { type: "tool", release: call.tool }, effectClass: "write", target: payload.step!.target } }, execution: { kind: "tool" }, workspaceId: context.workspaceId },
    cfg: context.cfg, signal: context.signal, launcher: context.launcher, permit: { token: gate.token, permitId: gate.invocationId }, toolPins: context.toolPins, mcp,
    validatePermit: (token, id) => client.validatePermit(token, id),
    fetchPinnedTool: (toolId, digest) => context.client.toolScript(context.configDigest, toolId, digest),
  });
  const message = executed.ok ? "" : String((executed.output as { error?: unknown } | null)?.error ?? "");
  const outcome = executed.ok ? "applied" as const : BEFORE_THE_CALL.test(message) ? "absent" as const : "unknown" as const;
  const bytes = new TextEncoder().encode(JSON.stringify(executed.output));
  const uploaded = await client.uploadArtifact(attemptId, bytes, "application/json");
  const receipt = { ...uploaded, mediaType: "application/json", classification: "internal" as const };
  await client.effectFinish(attemptId, { proposalId: call.proposalId, outcome, receiptDigest: receipt.digest });
  return { ok: outcome === "applied", output: { outcome, receipt: receipt.digest, result: executed.output } as unknown as JsonValue, receipt };
}
