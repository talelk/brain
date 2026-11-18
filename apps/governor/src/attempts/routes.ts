import { modelsOf } from "../workspace/platform";
import {
  ATTEMPT_COMPLETED_EVENT, BrainError, hmacSha256Hex, isDigest, LIMIT_NAMES, MAX_ATTEMPTS, receiptShapeProblem, receiptSignatureOk, resultDigest, RUNNER_ROUTES, secretName,
  type ApprovalPollResponse, type ArtifactUploadResponse, type AttemptFailure, type ClaimResponse, type CompleteResponse, type EventsResponse, type JsonValue, type LeaseResponse, type ModelTokenResponse,
  type RunReceipt, type SecretResponse, type ToolCallResponse,
} from "@brain/contracts";
import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Governor } from "../app";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { append, markChanged, SYSTEM } from "../events";
import { backoffMs } from "../tasks/decide";
import { withLimit } from "./limits";
import { attemptEnded, closeAttempt, settle } from "../tasks/orchestrator";
import { attemptOf, payloadOf, queueAttempt, setState, taskOf, type AttemptRow } from "../tasks/store";
import { runBrainTool } from "../tools/brain";
import { inputProblem } from "../tools/schema";
import { authorizeCall, callRowId, expireApprovals, finishCall, openCall } from "../trust/approvals";
import { linkArtifact, putArtifact, readArtifact } from "../trust/artifacts";
import { readSecret } from "../trust/secrets";
import { microUsd, reserveUsage, settleUsage } from "../trust/usage";
import { manifestOf } from "../workspace/store";
import { buildOffer, missing, OFFER_FOR_MS } from "./offer";
import { blockOf, dispatchOrder, standing } from "../tasks/queue";
import { body, runnerOf } from "./runners";

/** The queue and the life of an attempt on a runner (docs/architecture.md section 6): claim, lease, events, tool calls, completion. */
const LEASE_MS = 60_000;
const MODEL_TOKEN_FOR_MS = 3600_000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const fence = z.int().min(0);
const text = z.string().max(2_000_000);
const commits = z.record(z.string(), z.string().max(100));
const call = { fence, callId: z.string().min(1).max(100), tool: z.string().min(1).max(100), input: z.json(), baseCommits: commits.optional() };
const eventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), phase: z.enum(["setup", "engine", "upload"]), detail: text }),
  z.object({ kind: z.literal("text"), channel: z.enum(["assistant", "diagnostic"]), text }),
  z.object({ kind: z.literal("native.call"), callId: z.string().max(200), name: z.string().max(200), input: z.json() }),
  z.object({ kind: z.literal("native.result"), callId: z.string().max(200), ok: z.boolean(), output: text }),
  z.object({ kind: z.literal("tool.call"), callId: z.string().max(100), tool: z.string().max(100), effect: z.enum(["read", "write", "privileged"]), input: z.json() }),
  z.object({ kind: z.literal("tool.result"), callId: z.string().max(100), outcome: z.enum(["succeeded", "failed", "held", "rejected"]), output: z.json() }),
  z.object({ kind: z.literal("usage"), inputTokens: z.int().min(0), outputTokens: z.int().min(0), cachedInputTokens: z.int().min(0), microUsd: z.int().min(0) }),
]);
const usage = z.strictObject({ inputTokens: z.int().min(0), outputTokens: z.int().min(0), cachedInputTokens: z.int().min(0), microUsd: z.int().min(0) });
const blobRef = z.strictObject({ digest: z.string().refine(isDigest), bytes: z.int().min(0) });
const completion = z.strictObject({
  fence, outcome: z.enum(["succeeded", "failed", "held"]), result: text, output: z.json().optional(),
  failure: z.strictObject({ reason: z.enum(["engine", "model-refused", "setup", "timeout", "limit", "stopped", "runner"]), detail: text, infrastructure: z.boolean(), limit: z.strictObject({ name: z.enum(LIMIT_NAMES), value: z.number(), used: z.number().nullable(), agent: z.string().max(100).optional() }).optional() }).optional(),
  usage, engine: z.string().max(100), workingCopy: blobRef.optional(), baseCommits: commits,
  receipt: z.strictObject({ receipt: z.unknown(), signature: z.string().min(1).max(500) }),
});

/** The attempt a request is about, when the caller is the runner that holds it under the fence it names. */
function heldAttempt(gov: Gov, c: Context, fenceGiven: number): AttemptRow {
  const runnerId = runnerOf(gov, c);
  const attempt = gov.db.prepare("SELECT * FROM attempts WHERE id=?").get(c.req.param("id")) as AttemptRow | undefined;
  if (!attempt) throw new BrainError("NOT_FOUND", "Attempt not found");
  if (attempt.runner_id !== runnerId || attempt.fence !== fenceGiven || (attempt.state !== "offered" && attempt.state !== "running")) throw new BrainError("LEASE_LOST", "This attempt is no longer this runner's to run");
  return attempt;
}

/**
 * Keeps the commits a runner says its attempt's working copy stands on, from the first call that carries them: the goal's other tasks are
 * then given the same commits without waiting for this attempt to end.
 */
function noteCommits(gov: Gov, attempt: AttemptRow, baseCommits: Readonly<Record<string, string>> | undefined): void {
  if (baseCommits && Object.keys(baseCommits).length > 0) gov.db.prepare("UPDATE attempts SET base_commits_json=? WHERE id=? AND base_commits_json IS NULL").run(JSON.stringify(baseCommits), attempt.id);
}

/** A token for the model gateway, bound to the attempt and its fence. It holds its own proof, so nothing is stored. */
export function modelToken(gov: Gov, attemptId: string, attemptFence: number, expiresAt: number): string {
  const bound = `${attemptId}.${attemptFence}.${expiresAt}`;
  return `bmt_${bound}.${hmacSha256Hex(gov.keys.digests, Buffer.from(`model-token\n${bound}`))}`;
}
/** The running attempt a model token speaks for; undefined when the token is not valid any more. */
export function attemptOfModelToken(gov: Gov, token: string): AttemptRow | undefined {
  const [attemptId = "", attemptFence = "", expiresAt = "", proof = ""] = token.startsWith("bmt_") ? token.slice(4).split(".") : [];
  const expected = Buffer.from(modelToken(gov, attemptId, Number(attemptFence), Number(expiresAt)));
  if (proof === "" || expected.length !== token.length || !timingSafeEqual(expected, Buffer.from(token)) || Number(expiresAt) <= gov.clock.nowMs()) return undefined;
  const attempt = gov.db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId) as AttemptRow | undefined;
  return attempt?.state === "running" && attempt.fence === Number(attemptFence) ? attempt : undefined;
}

/** Takes an attempt back from its runner, which is refused from then on, and puts it in the queue again (its next offer moves the fence); after five such tries in all it fails. */
export function releaseAttempt(gov: Gov, attemptId: string, why: string): void {
  const { db } = gov;
  const attempt = attemptOf(db, attemptId);
  const failure: AttemptFailure = { reason: "runner", detail: why, infrastructure: true };
  if (attempt.tries + 1 >= MAX_ATTEMPTS) {
    closeAttempt(gov, attempt, "failed", { ...failure, limit: { name: "attempts", value: MAX_ATTEMPTS, used: attempt.tries + 1 } });
    return attemptEnded(gov, attempt.id);
  }
  db.prepare("UPDATE attempts SET state='queued', runner_id=NULL, tries=tries+1, available_at_ms=?, offer_expires_at_ms=NULL, lease_expires_at_ms=NULL WHERE id=?").run(gov.clock.nowMs() + backoffMs(attempt.tries + 1), attempt.id);
  expireApprovals(gov, { attemptId: attempt.id }, why);
  append(db, { type: "attempt.requeued", workspaceId: attempt.workspace_id, subject: `attempt:${attempt.id}`, payload: { taskId: attempt.task_id, why, tries: attempt.tries + 1 }, actor: SYSTEM });
  const task = taskOf(db, attempt.task_id);
  if (attempt.kind === "work" && (task.state === "running" || task.state === "needs_you")) setState(gov, task, "ready");
  settle(gov, attempt.workspace_id);
}

/** Takes back every attempt whose offer was not acknowledged or whose lease ran out. */
export function sweepAttempts(gov: Gov): void {
  tx(gov.db, () => {
    const now = gov.clock.nowMs();
    for (const row of gov.db.prepare("SELECT id, state FROM attempts WHERE (state='offered' AND offer_expires_at_ms<=?) OR (state='running' AND lease_expires_at_ms<=?)").all(now, now) as Array<{ id: string; state: string }>) {
      releaseAttempt(gov, row.id, row.state === "offered" ? "The runner did not acknowledge the offer" : "The runner stopped renewing its lease");
    }
  });
}

/** The first queued attempt, in the order of `dispatchOrder` (tasks/queue.ts), that nothing holds back (`blockOf`) and the runner has what it needs for. */
function claim(gov: Gov, runnerId: string): AttemptRow | undefined {
  const { db } = gov;
  const now = gov.clock.nowMs();
  const row = db.prepare("SELECT capabilities_json, engines_json FROM runners WHERE id=?").get(runnerId) as { capabilities_json: string; engines_json: string };
  const runner = { capabilities: new Set(JSON.parse(row.capabilities_json) as string[]), engines: new Set(JSON.parse(row.engines_json) as string[]) };
  const at = standing(gov);
  for (const entry of dispatchOrder(gov)) {
    const { attempt, task } = entry;
    const manifest = manifestOf(gov, task.snapshot_digest);
    const agent = manifest.agents[attempt.agent];
    if (!agent || missing(manifest, attempt, runner) !== null || blockOf(gov, entry, at) !== null) continue;
    db.prepare("UPDATE attempts SET state='offered', runner_id=?, fence=fence+1, offer_expires_at_ms=? WHERE id=?").run(runnerId, now + OFFER_FOR_MS, attempt.id);
    reserveUsage(gov, attempt, agent.model ?? modelsOf(gov, attempt.workspace_id, manifest).models[0]?.name ?? null, microUsd(agent.limits.spend_usd));
    db.prepare("UPDATE tasks SET started_at_ms=COALESCE(started_at_ms, ?) WHERE id=?").run(now, task.id);
    if (attempt.kind === "work" && task.state === "ready") setState(gov, task, "running");
    append(db, { type: "attempt.offered", workspaceId: attempt.workspace_id, subject: `attempt:${attempt.id}`, payload: { taskId: task.id, runnerId, fence: attempt.fence + 1 }, actor: { kind: "runner", id: runnerId } });
    return attemptOf(db, attempt.id);
  }
  return undefined;
}

/** The stored bytes a runner may fetch: what the snapshots of the attempts it holds name, and what their offers named. */
function mayFetch(gov: Gov, runnerId: string, digest: string): boolean {
  for (const attempt of gov.db.prepare("SELECT * FROM attempts WHERE runner_id=? AND state IN ('offered','running')").all(runnerId) as AttemptRow[]) {
    const snapshot = taskOf(gov.db, attempt.task_id).snapshot_digest;
    const manifest = manifestOf(gov, snapshot);
    if (digest === snapshot || payloadOf(attempt).offered?.includes(digest) || Object.values(manifest.agents).some((agent) => agent.prompt.digest === digest)
      || Object.values(manifest.tools).some((tool) => tool.files.some((file) => file.digest === digest))) return true;
  }
  return false;
}

export function registerAttempts(governor: Governor): void {
  const { gov, app } = governor;
  const { db } = gov;

  app.post(RUNNER_ROUTES.claim, async (c) => {
    const runnerId = runnerOf(gov, c);
    const input = await body(c, z.strictObject({ freeSlots: z.int().min(0) }));
    return c.json(tx(db, (): ClaimResponse => {
      const attempt = input.freeSlots > 0 ? claim(gov, runnerId) : undefined;
      return { offer: attempt ? buildOffer(gov, attempt) : null };
    }));
  });

  app.post(RUNNER_ROUTES.ack, async (c) => {
    const input = await body(c, z.strictObject({ fence, engine: z.string().min(1).max(100) }));
    const attempt = heldAttempt(gov, c, input.fence);
    const leaseExpiresAt = gov.clock.nowMs() + LEASE_MS;
    db.prepare("UPDATE attempts SET state='running', engine=?, lease_expires_at_ms=?, offer_expires_at_ms=NULL, started_at_ms=COALESCE(started_at_ms, ?) WHERE id=?").run(input.engine, leaseExpiresAt, gov.clock.nowMs(), attempt.id);
    markChanged(db, attempt.workspace_id);
    return c.json({ leaseExpiresAt, stop: false } satisfies LeaseResponse);
  });

  app.post(RUNNER_ROUTES.renew, async (c) => {
    const input = await body(c, z.strictObject({ fence }));
    const stopped = db.prepare("SELECT 1 FROM attempts WHERE id=? AND runner_id=? AND fence=? AND state='stopped'").get(c.req.param("id"), runnerOf(gov, c), input.fence);
    if (stopped) return c.json({ leaseExpiresAt: gov.clock.nowMs(), stop: true } satisfies LeaseResponse);
    const attempt = heldAttempt(gov, c, input.fence);
    if (attempt.state !== "running") throw new BrainError("CONFLICT", "Acknowledge the offer first");
    const leaseExpiresAt = gov.clock.nowMs() + LEASE_MS;
    db.prepare("UPDATE attempts SET lease_expires_at_ms=? WHERE id=?").run(leaseExpiresAt, attempt.id);
    return c.json({ leaseExpiresAt, stop: false } satisfies LeaseResponse);
  });

  app.post(RUNNER_ROUTES.events, async (c) => {
    const input = await body(c, z.strictObject({ fence, events: z.array(z.intersection(eventBody, z.object({ seq: z.int().min(0), at: z.number() }))).max(1000) }));
    const attempt = heldAttempt(gov, c, input.fence);
    return c.json(tx(db, (): EventsResponse => {
      for (const { seq, at, ...event } of input.events) {
        if (db.prepare("INSERT OR IGNORE INTO attempt_events(attempt_id, seq, at_ms, kind, body_json) VALUES (?,?,?,?,?)").run(attempt.id, seq, at, event.kind, JSON.stringify(event)).changes === 0) continue;
        // A call the runner ran itself (a `read` tool, or one approved at once) is recorded from what it reports.
        if (event.kind === "tool.call") openCall(gov, attempt, event.callId, event);
        else if (event.kind === "tool.result") finishCall(gov, callRowId(attempt, event.callId), event.outcome, event.output);
      }
      markChanged(db, attempt.workspace_id);
      return { through: (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM attempt_events WHERE attempt_id=?").get(attempt.id) as { seq: number }).seq };
    }));
  });

  app.post(RUNNER_ROUTES.artifacts, async (c) => {
    const query = z.object({ fence: z.coerce.number().int(), name: z.string().min(1).max(300), kind: z.enum(["patch", "output", "log"]), mediaType: z.string().min(1).max(200) }).safeParse(c.req.query());
    if (!query.success) throw new BrainError("INVALID_INPUT", "An upload names fence, name, kind and mediaType");
    const attempt = heldAttempt(gov, c, query.data.fence);
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new BrainError("INVALID_INPUT", "The file is too large to keep");
    return c.json(tx(db, (): ArtifactUploadResponse => {
      const digest = putArtifact(gov, bytes);
      linkArtifact(db, { digest, workspaceId: attempt.workspace_id, taskId: attempt.task_id, attemptId: attempt.id, name: query.data.name, kind: query.data.kind, mediaType: query.data.mediaType }, gov.clock.nowMs());
      markChanged(db, attempt.workspace_id);
      return { digest, bytes: bytes.length };
    }));
  });

  app.post(RUNNER_ROUTES.toolCall, async (c) => {
    const input = await body(c, z.strictObject(call));
    const attempt = heldAttempt(gov, c, input.fence);
    noteCommits(gov, attempt, input.baseCommits);
    const manifest = manifestOf(gov, taskOf(db, attempt.task_id).snapshot_digest);
    const tool = manifest.agents[attempt.agent]?.tools.includes(input.tool) ? manifest.tools[input.tool] : undefined;
    if (!tool || tool.runs === "brain") throw new BrainError("FORBIDDEN", `The agent ${attempt.agent} has no tool ${input.tool} that a runner runs`);
    const problem = inputProblem(tool.input_schema, input.input);
    if (problem) throw new BrainError("INVALID_INPUT", `The input of ${input.tool} is not valid: ${problem}`);
    const decision = tx(db, () => authorizeCall(gov, attempt, { callId: input.callId, tool: input.tool, effect: tool.effect, input: input.input }));
    return c.json({ callId: input.callId, state: decision.state, ...(decision.approvalId ? { approvalId: decision.approvalId } : {}), ...(decision.reason ? { reason: decision.reason } : {}) } satisfies ToolCallResponse);
  });

  app.get(RUNNER_ROUTES.approval, (c) => {
    const attempt = heldAttempt(gov, c, Number(c.req.query("fence")));
    // An attempt reads the approvals of its own calls; an `act` attempt, the one approval it carries out.
    const approvalId = c.req.param("approvalId");
    const row = db.prepare("SELECT state, reason FROM approvals WHERE id=? AND (attempt_id=? OR ?)").get(approvalId, attempt.id, payloadOf(attempt).act?.approvalId === approvalId ? 1 : 0) as { state: ApprovalPollResponse["state"]; reason: string | null } | undefined;
    if (!row) throw new BrainError("NOT_FOUND", "Approval not found");
    return c.json({ state: row.state, ...(row.reason ? { reason: row.reason } : {}) } satisfies ApprovalPollResponse);
  });

  app.post(RUNNER_ROUTES.brainTool, async (c) => {
    const input = await body(c, z.strictObject(call));
    const attempt = heldAttempt(gov, c, input.fence);
    noteCommits(gov, attempt, input.baseCommits);
    const { baseCommits, ...request } = input;
    return c.json(await runBrainTool(gov, attempt, { ...request, ...(baseCommits ? { baseCommits } : {}) }));
  });

  app.post(RUNNER_ROUTES.secret, async (c) => {
    const input = await body(c, z.strictObject({ fence, name: z.string().min(1).max(100), use: z.union([z.strictObject({ tool: z.string() }), z.strictObject({ project: z.string() })]) }));
    const attempt = heldAttempt(gov, c, input.fence);
    const manifest = manifestOf(gov, taskOf(db, attempt.task_id).snapshot_digest);
    // Only a secret a tool of this agent declares, or the credential of a project.
    const allowed = "tool" in input.use
      ? manifest.agents[attempt.agent]?.tools.includes(input.use.tool) && manifest.tools[input.use.tool]?.secrets.includes(input.name)
      : manifest.projects.some((project) => "project" in input.use && project.name === input.use.project && project.credential !== undefined && secretName(project.credential) === input.name);
    if (!allowed) throw new BrainError("FORBIDDEN", `This attempt may not read the secret ${input.name}`);
    const value = readSecret(gov, attempt.workspace_id, input.name);
    if (value === undefined) throw new BrainError("NOT_FOUND", `The secret ${input.name} is not set`);
    tx(db, () => append(db, { type: "secret.leased", workspaceId: attempt.workspace_id, subject: `secret:${input.name}`, payload: { name: input.name, use: input.use, taskId: attempt.task_id }, actor: { kind: "agent", id: attempt.agent, attemptId: attempt.id } }));
    return c.json({ value } satisfies SecretResponse);
  });

  app.post(RUNNER_ROUTES.modelToken, async (c) => {
    const input = await body(c, z.strictObject({ fence }));
    const attempt = heldAttempt(gov, c, input.fence);
    const expiresAt = gov.clock.nowMs() + MODEL_TOKEN_FOR_MS;
    return c.json({ token: modelToken(gov, attempt.id, attempt.fence, expiresAt), expiresAt } satisfies ModelTokenResponse);
  });

  app.post(RUNNER_ROUTES.complete, async (c) => {
    const runnerId = runnerOf(gov, c);
    const input = await body(c, completion);
    const { receipt, signature } = input.receipt;
    const known = db.prepare("SELECT state, receipt_signature FROM attempts WHERE id=? AND runner_id=?").get(c.req.param("id"), runnerId) as { state: string; receipt_signature: string | null } | undefined;
    // A completion sent again, because its answer was lost, is accepted once more and changes nothing.
    if (known?.receipt_signature === signature && known.state === input.outcome) return c.json({ accepted: true } satisfies CompleteResponse);
    const attempt = heldAttempt(gov, c, input.fence);
    const task = taskOf(db, attempt.task_id);
    const output = input.output ?? null;
    const shape = receiptShapeProblem(receipt);
    if (shape) throw new BrainError("INVALID_INPUT", `The receipt is not valid: ${shape}`);
    const signed = receipt as RunReceipt;
    const key = (db.prepare("SELECT public_key_pem AS pem FROM runners WHERE id=?").get(runnerId) as { pem: string }).pem;
    if (signed.attemptId !== attempt.id || signed.fence !== attempt.fence || signed.snapshotDigest !== task.snapshot_digest || signed.resultDigest !== resultDigest(input.result, output) || !receiptSignatureOk(signed, signature, key)) {
      throw new BrainError("FORBIDDEN", "The receipt does not match this attempt, its result, or the runner's key");
    }
    if (input.workingCopy && !db.prepare("SELECT 1 FROM artifact_links WHERE digest=? AND attempt_id=?").get(input.workingCopy.digest, attempt.id)) throw new BrainError("INVALID_INPUT", "The working-copy patch was not uploaded by this attempt");
    const failure: AttemptFailure | null = input.outcome === "failed" ? withLimit(gov, attempt, input.failure ?? { reason: "engine", detail: input.result, infrastructure: false }, input.usage) : null;
    tx(db, () => {
      const now = gov.clock.nowMs();
      db.prepare(`UPDATE attempts SET state=?, result=?, output_json=?, failure_json=?, receipt_json=?, receipt_signature=?, working_copy=?, base_commits_json=?, engine=?, finished_at_ms=?,
        lease_expires_at_ms=NULL, offer_expires_at_ms=NULL WHERE id=?`).run(
        input.outcome, input.result, output === null ? null : JSON.stringify(output), failure ? JSON.stringify(failure) : null, JSON.stringify(signed), signature, input.workingCopy?.digest ?? null,
        Object.keys(input.baseCommits).length > 0 ? JSON.stringify(input.baseCommits) : null, input.engine, now, attempt.id,
      );
      settleUsage(gov, attempt.id, input.usage);
      // An `act` attempt ends with how its one call went, also when the call failed.
      const acted = payloadOf(attempt).act;
      const report = acted && output !== null && typeof output === "object" && !Array.isArray(output) ? (output as { outcome?: unknown; output?: JsonValue }) : undefined;
      if (acted && (report?.outcome === "succeeded" || report?.outcome === "failed" || report?.outcome === "rejected")) finishCall(gov, acted.callId, report.outcome, report.output ?? null);
      // A call still waiting for a person stays open only when the attempt ended `held` for it; anything else unfinished did not happen.
      if (input.outcome === "held") db.prepare("UPDATE tool_calls SET outcome='held' WHERE attempt_id=? AND outcome='pending' AND approval_id IN (SELECT id FROM approvals WHERE state IN ('pending','approved'))").run(attempt.id);
      else expireApprovals(gov, { attemptId: attempt.id }, "The attempt ended before a person decided");
      // Approved in the moment the runner gave up waiting: the call is still carried out, as for an approval that comes later.
      for (const held of db.prepare("SELECT c.id, c.tool, c.input_json, c.approval_id FROM tool_calls c JOIN approvals p ON p.id = c.approval_id WHERE c.attempt_id=? AND c.outcome='held' AND p.state='approved'").all(attempt.id) as Array<{ id: string; tool: string; input_json: string; approval_id: string }>) {
        queueAttempt(gov, { task, kind: "act", agent: attempt.agent, payload: { act: { callId: held.id, approvalId: held.approval_id, tool: held.tool, input: JSON.parse(held.input_json) as JsonValue } } });
      }
      db.prepare("UPDATE tool_calls SET outcome='failed', output_json=?, finished_at_ms=? WHERE attempt_id=? AND outcome='pending'").run(JSON.stringify({ error: "The attempt ended before the call finished" }), now, attempt.id);
      append(db, {
        type: ATTEMPT_COMPLETED_EVENT, workspaceId: attempt.workspace_id, subject: `attempt:${attempt.id}`,
        payload: { taskId: task.id, outcome: input.outcome, runnerId, receipt: signed as unknown as JsonValue, signature, usage: input.usage }, actor: { kind: "runner", id: runnerId },
      });
      attemptEnded(gov, attempt.id);
    });
    return c.json({ accepted: true } satisfies CompleteResponse);
  });

  app.get(RUNNER_ROUTES.blob, (c) => {
    const digest = c.req.param("digest");
    if (!isDigest(digest) || !mayFetch(gov, runnerOf(gov, c), digest)) throw new BrainError("NOT_FOUND", "No such stored content for this runner");
    return new Response(Buffer.from(readArtifact(gov, digest)), { headers: { "content-type": "application/octet-stream" } });
  });

  governor.every(5_000, () => sweepAttempts(gov));
}
