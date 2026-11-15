import type { JsonValue } from "@brain/contracts";
import { domainDigest, sha256Digest } from "@brain/contracts";
import { releaseRecord, releaseToolAllowedHosts, releaseToolMcp, releaseToolPins } from "../configuration/index";
import { workspaceEgressHosts } from "../governance/index";
import { authorEvidenceFor, toolReleasesForPayload } from "../evidence/index";
import { putBytes, readVerified, registerArtifact } from "../artifacts/index";
import { endAttemptSession, recordAttemptCheckpoint, recordPauseProgress, recordAttemptProgress, recordAttemptSession } from "../sessions/index";
import { ensureAgentPrincipal, issueSessionCredential, revokeSessionCredentials } from "../identity/index";
import { BrainDomainError } from "../../domain/errors";
import { transitionState } from "../../domain/states";
import { failureCode, failureReasonOf, redactFailureOutput } from "../../domain/failure-reason";
import { evaluateRunner, type RunnerView } from "../../domain/placement";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";
import { isDraining } from "./drain";
import { modelRoutesForJob, recordRouteOffer, settleRouteReport } from "./model-route";
import { effectOutcomesFor, executionArtifactId, HOLD_REASON } from "./effect-hold";
import { ensureSkills, promptTaskText, skillTokens } from "./skill-selection";
import { heldEffect, retryFailedAttempt, stampAttemptDeadline, stepPolicy } from "./step-policy";
import type { JobProtocolPorts } from "./job-protocol";

/**
 * Job/attempt lifecycle: fair claim, offers as pinned execution artifacts,
 * leases and fences, event ingest, completion receipts and expiry sweeps.
 * Private files; the public surface is the module index (JobProtocol).
 */

/** Engine probe features from a batch-level engine object; absent → none. */
function engineFeaturesFromBody(engine: { features?: unknown } | undefined): string[] {
  const features = engine?.features;
  return Array.isArray(features) ? features.filter((entry): entry is string => typeof entry === "string") : [];
}

export function runnerView(s: Store, runnerId: string): RunnerView | undefined {
  const r = s.control.prepare(`SELECT id, group_id, admin_state, health, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity,
    cpu_reserved, memory_reserved, disk_reserved, slots_reserved FROM runners WHERE id=?`).get(runnerId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const caps = new Map<string, { verified: boolean; expiresAtMs: number }>();
  for (const c of s.control.prepare("SELECT capability, verified, expires_at_ms FROM runner_capabilities WHERE runner_id=?").all(runnerId) as Array<Record<string, unknown>>) {
    caps.set(String(c["capability"]), { verified: Number(c["verified"]) === 1, expiresAtMs: Number(c["expires_at_ms"]) });
  }
  const engines = (s.control.prepare("SELECT capability FROM runner_capabilities WHERE runner_id=? AND capability LIKE 'engine:%'").all(runnerId) as Array<{ capability: string }>)
    .map((e) => e.capability.slice("engine:".length));
  return {
    id: runnerId, groupId: String(r["group_id"]), adminState: String(r["admin_state"]), health: String(r["health"]),
    online: Number(r["last_heartbeat_ms"] ?? 0) > s.now() - 45_000,
    capabilities: caps,
    capacity: { cpuMillicores: Number(r["cpu_capacity"]), memoryMb: Number(r["memory_capacity"]), diskMb: Number(r["disk_capacity"]), slots: Number(r["slot_capacity"]) },
    reserved: { cpuMillicores: Number(r["cpu_reserved"]), memoryMb: Number(r["memory_reserved"]), diskMb: Number(r["disk_reserved"]), slots: Number(r["slots_reserved"]) },
    reserve: { cpuMillicores: 500, memoryMb: 1024, diskMb: 0, slots: 0 },
    // What the runner's tool sandboxes provide. What an engine provides is its own `engine-isolation:` capability, checked in placement.
    isolation: "ephemeral-container",
    engines,
  };
}

/** A group with no row is open to every workspace; a group with one takes only the workspaces it lists. */
function groupAdmits(groups: ReadonlyMap<string, readonly string[]>, groupId: string, workspaceId: string): boolean {
  const allowed = groups.get(groupId);
  return !allowed || allowed.includes(workspaceId);
}

function hostGroupFor(s: Store, organizationId: string, groupId: string, workspaceId: string): boolean {
  const row = s.control.prepare("SELECT host_tools, workspaces_json FROM runner_groups WHERE organization_id=? AND group_id=?").get(organizationId, groupId) as { host_tools: number; workspaces_json: string } | undefined;
  return !!row && row.host_tools === 1 && (JSON.parse(row.workspaces_json) as string[]).includes(workspaceId);
}

/** True when the job's agent lists a host tool: such a job is only ever offered to a host group. Cached per release and agent for one claim. */
function jobUsesHostTools(s: Store, organizationId: string, job: Record<string, unknown>, cache: Map<string, boolean>): boolean {
  const payload = s.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(String(job["id"])) as { payload_json: string } | undefined;
  if (!payload) return false;
  const uses = (JSON.parse(payload.payload_json) as { step?: { uses?: { type?: string; release?: { id: string } } } }).step?.uses;
  // A direct tool step (Try this tool) that names a host tool needs the host group just as an agent holding one does.
  if (uses?.type === "tool") return uses.release?.id.startsWith("host.") === true;
  if (uses?.type !== "agent" || !uses.release) return false;
  const key = `${String(job["config_digest"])}\n${uses.release.id}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const agent = releaseRecord(s, organizationId, String(job["config_digest"]))?.release.agents?.[uses.release.id];
  const found = (agent?.spec.tools ?? []).some((tool) => tool.id.startsWith("host."));
  cache.set(key, found);
  return found;
}

/**
 * Why a runner may not take a job, in the order the claim applies the rules; empty means it may. The claim and the resume offer (is there any
 * runner that could continue a checkpoint?) both ask it, so what is offered is exactly what a runner would be given.
 * A runner group set aside for other workspaces (ADR 0024) never sees the job; host tools need a host group bound to the workspace; then the
 * placement itself (group, isolation, capabilities, engine and its features, capacity).
 */
export function runnerRefusals(s: Store, ctx: { organizationId: string; groups: ReadonlyMap<string, readonly string[]>; hostJobs: Map<string, boolean> }, job: Record<string, unknown>, placement: import("@brain/contracts").Placement, demand: import("@brain/contracts").Resources, view: RunnerView): string[] {
  if (!groupAdmits(ctx.groups, view.groupId, String(job["workspace_id"]))) return ["runner-group-reserved"];
  if (jobUsesHostTools(s, ctx.organizationId, job, ctx.hostJobs) && !hostGroupFor(s, ctx.organizationId, view.groupId, String(job["workspace_id"]))) return ["host-tools-group-required"];
  return [...evaluateRunner(placement, demand, view, s.now()).reasons];
}

/** The runner groups of an organization and the workspaces each is set aside for, as the claim reads them. */
export function runnerGroupsOf(s: Store, organizationId: string): Map<string, string[]> {
  return new Map((s.control.prepare("SELECT group_id, workspaces_json FROM runner_groups WHERE organization_id=?").all(organizationId) as Array<{ group_id: string; workspaces_json: string }>).map((row) => [row.group_id, JSON.parse(row.workspaces_json) as string[]]));
}

export function claim(s: Store, deps: {
  isEvaluatorEligible: (runnerId: string, jobId: string) => boolean; isRunnerCurrent?: (runnerId: string) => boolean;
  missionAdmission?: (workspaceId: string, runId: string) => import("./job-protocol").MissionAdmission;
  missionReserve?: (workspaceId: string, input: { missionId?: string; runId: string; attemptId: string; microUsd: number; agentId?: string }) => void;
  contextPack?: ContextPackPort;
}, runner: { runnerId: string; epoch: number; organizationId: string }, requestId: string): JsonValue | null {
  let offer: JsonValue | null = null;
  s.inTx(s.control, () => {
    const priorClaim = s.control.prepare("SELECT attempt_id FROM runner_claim_requests WHERE runner_id=? AND runner_epoch=? AND request_id=?").get(runner.runnerId, runner.epoch, requestId) as { attempt_id: string | null } | undefined;
    if (priorClaim?.attempt_id) {
      offer = offerJson(s, priorClaim.attempt_id);
      return;
    }
    if (deps.isRunnerCurrent && !deps.isRunnerCurrent(runner.runnerId)) return;
    // Drain mode (deploys that do not interrupt work): running attempts finish, nothing new is offered until resume.
    if (isDraining(s)) return;
    const view = runnerView(s, runner.runnerId);
    if (!view) throw new BrainDomainError("UNAUTHENTICATED", "runner missing");
    // Fair paging (E047/E048/E049): scan each workspace beyond its first 100 rows with a keyset cursor so an eligible job is eventually
    // found. Each workspace is scanned on its own, best priority first, so a workspace with hundreds of urgent jobs queued cannot push
    // another workspace's jobs out of the candidate set (ADR 0041); the order between workspaces is decided below, by fairness.
    const eligible: Array<Record<string, unknown>> = [];
    const groups = runnerGroupsOf(s, runner.organizationId);
    const hostJobs = new Map<string, boolean>();
    const queuedWorkspaces = (s.control.prepare(`SELECT DISTINCT workspace_id FROM jobs WHERE organization_id=? AND state='queued' AND deadline_ms>? AND ready_at_ms<=? AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=jobs.workspace_id AND w.organization_id=jobs.organization_id AND w.status='active')`)
      .all(runner.organizationId, s.now(), s.now()) as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
    for (const workspaceId of queuedWorkspaces) {
      let after: { priority: number; created: number; id: string } | null = null;
      let found = 0;
      for (let page = 0; page < 10; page++) {
        const rows = (after === null
          ? s.control.prepare(`SELECT id, workspace_id, placement_json, version, workflow_run_id, step_id, config_digest, effect_class, priority, created_at_ms
              FROM jobs WHERE organization_id=? AND workspace_id=? AND state='queued' AND deadline_ms>? AND ready_at_ms<=? ORDER BY priority DESC, created_at_ms ASC, id ASC LIMIT 100`)
              .all(runner.organizationId, workspaceId, s.now(), s.now())
          : s.control.prepare(`SELECT id, workspace_id, placement_json, version, workflow_run_id, step_id, config_digest, effect_class, priority, created_at_ms
              FROM jobs WHERE organization_id=? AND workspace_id=? AND state='queued' AND deadline_ms>? AND ready_at_ms<=?
              AND (priority < ? OR (priority = ? AND created_at_ms > ?) OR (priority = ? AND created_at_ms = ? AND id > ?))
              ORDER BY priority DESC, created_at_ms ASC, id ASC LIMIT 100`)
              .all(runner.organizationId, workspaceId, s.now(), s.now(), after.priority, after.priority, after.created, after.priority, after.created, after.id)) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;
        for (const job of rows) {
          const placement = JSON.parse(String(job["placement_json"])) as import("@brain/contracts").Placement;
          const demand = placement.resources ?? { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 };
          if (runnerRefusals(s, { organizationId: runner.organizationId, groups, hostJobs }, job, placement, demand, view).length > 0 || !deps.isEvaluatorEligible(runner.runnerId, String(job["id"]))) continue;
          // A check or second attempt whose every route is down or out of quota waits for one (ADR 0023, ADR 0055); nothing else is held.
          const routeOffer = modelRoutesForJob(s, String(job["id"]));
          if (routeOffer.held) { recordRouteOffer(s, String(job["id"]), routeOffer); continue; }
          eligible.push(job);
          found++;
        }
        const last = rows[rows.length - 1]!;
        after = { priority: Number(last["priority"] ?? 0), created: Number(last["created_at_ms"] ?? 0), id: String(last["id"]) };
        if (found > 0 && page > 0) break;
        if (rows.length < 100) break;
      }
    }
    const inFlight = new Map<string, number>();
    for (const row of s.control.prepare(`SELECT j.workspace_id AS ws, COUNT(*) AS n FROM job_attempts a JOIN jobs j ON j.id=a.job_id
      WHERE a.state IN ('offered','running') GROUP BY j.workspace_id`).all() as Array<{ ws: string; n: number }>) {
      inFlight.set(row.ws, row.n);
    }
    // Two-stage admission (#36): mission-local limits first (member cap, then
    // budget), then shared runner capacity. Interactive work (no mission) is
    // served first; missions then take turns by fewest attempts in flight.
    const admission = new Map<string, import("./job-protocol").MissionAdmission>();
    const missionLoad = new Map<string, number>();
    if (deps.missionAdmission) {
      for (const job of eligible) {
        const decision = deps.missionAdmission(String(job["workspace_id"]), String(job["workflow_run_id"]));
        admission.set(String(job["id"]), decision);
        if (!decision.admitted) s.control.prepare("UPDATE jobs SET queue_reason=? WHERE id=?").run(`waiting: ${decision.reason}`, String(job["id"]));
      }
      for (const decision of admission.values()) if (decision.missionId) missionLoad.set(decision.missionId, decision.running);
    }
    const missionOf = (job: Record<string, unknown>) => admission.get(String(job["id"]))?.missionId;
    // Claim order (ADR 0041): the workspace with the fewest attempts in flight first, so none is starved; inside it the higher priority
    // first; then interactive work before missions, missions in turn by fewest running, and the oldest job.
    eligible.sort((a, b) => {
      const fa = inFlight.get(String(a["workspace_id"])) ?? 0;
      const fb = inFlight.get(String(b["workspace_id"])) ?? 0;
      if (fa !== fb) return fa - fb;
      const pa = Math.min(Number(a["priority"] ?? 0), 100);
      const pb = Math.min(Number(b["priority"] ?? 0), 100);
      if (pb !== pa) return pb - pa;
      const ia = missionOf(a) ? 1 : 0, ib = missionOf(b) ? 1 : 0;
      if (ia !== ib) return ia - ib;
      const ma = missionLoad.get(missionOf(a) ?? "") ?? 0, mb = missionLoad.get(missionOf(b) ?? "") ?? 0;
      if (ma !== mb) return ma - mb;
      const ca = Number(a["created_at_ms"] ?? 0) - Number(b["created_at_ms"] ?? 0);
      return ca !== 0 ? ca : String(a["id"]).localeCompare(String(b["id"]));
    });
    for (const job of eligible) {
      const decision = admission.get(String(job["id"]));
      if (decision && !decision.admitted) continue;
      const placement = JSON.parse(String(job["placement_json"])) as import("@brain/contracts").Placement;
      const demand = placement.resources ?? { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 };
      const attemptId = s.id("att");
      const leaseId = s.id("lease");
      const upd = s.control.prepare(`UPDATE runners SET cpu_reserved=cpu_reserved+?, memory_reserved=memory_reserved+?, disk_reserved=disk_reserved+?, slots_reserved=slots_reserved+?
        WHERE id=? AND cpu_capacity-500-cpu_reserved>=? AND memory_capacity-1024-memory_reserved>=? AND disk_capacity-disk_reserved>=? AND slot_capacity-slots_reserved>=?`)
        .run(demand.cpuMillicores, demand.memoryMb, demand.diskMb, demand.slots, runner.runnerId, demand.cpuMillicores, demand.memoryMb, demand.diskMb, demand.slots);
      if (upd.changes !== 1) {
        if (decision?.missionId) s.control.prepare("UPDATE jobs SET queue_reason='waiting: runner capacity' WHERE id=?").run(String(job["id"]));
        continue;
      }
      transitionState(s.control, "job", String(job["id"]), "offered", {
        rawSet: ["attempt_counter=attempt_counter+1", "job_fence=job_fence+1"], bumpVersion: true, and: { version: Number(job["version"]) },
      });
      const fresh = s.control.prepare("SELECT attempt_counter, job_fence FROM jobs WHERE id=?").get(String(job["id"])) as { attempt_counter: number; job_fence: number };
      s.control.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms)
        VALUES (?,?,?,?,?,?,?,'offered',?,?)`).run(attemptId, String(job["id"]), runner.runnerId, runner.epoch, fresh.attempt_counter, leaseId, fresh.job_fence, s.now() + 10_000, s.now() + 10_000);
      s.control.prepare("INSERT INTO capacity_reservations(attempt_id, runner_id, cpu, memory, disk, slots) VALUES (?,?,?,?,?,?)")
        .run(attemptId, runner.runnerId, Math.max(1, demand.cpuMillicores), Math.max(1, demand.memoryMb), Math.max(1, demand.diskMb), Math.max(1, demand.slots));
      s.control.prepare("INSERT INTO runner_claim_requests(runner_id, runner_epoch, request_id, attempt_id, request_digest, created_at_ms) VALUES (?,?,?,?,?,?)")
        .run(runner.runnerId, runner.epoch, requestId, attemptId, requestId, s.now());
      if (decision?.admitted && deps.missionReserve) {
        const agentId = pinnedAgentOf(s, String(job["id"]));
        deps.missionReserve(String(job["workspace_id"]), { ...(decision.missionId ? { missionId: decision.missionId } : {}), runId: String(job["workflow_run_id"]), attemptId, microUsd: decision.reserve, ...(agentId ? { agentId } : {}) });
      }
      s.control.prepare("UPDATE jobs SET queue_reason=NULL WHERE id=?").run(String(job["id"]));
      // Skills first: the ones this task loads take their share of the prompt before the context pack is sized.
      ensureSkills(s, runner.organizationId, job);
      if (deps.contextPack) ensureContextPack(s, deps.contextPack, runner.organizationId, job);
      offer = offerJson(s, attemptId);
      return;
    }
    s.control.prepare("INSERT OR IGNORE INTO runner_claim_requests(runner_id, runner_epoch, request_id, attempt_id, request_digest, created_at_ms) VALUES (?,?,?,NULL,?,?)")
      .run(runner.runnerId, runner.epoch, requestId, requestId, s.now());
  });
  return offer;
}

/** Share of an agent's token ceiling that its context pack may use. */
export const CONTEXT_BUDGET_SHARE = 0.25;
/** The whole prompt (context pack, the task's own brief and the agent's instructions) may use this share of the agent's token ceiling; the rest is for the reply. */
export const PROMPT_BUDGET_SHARE = 0.5;
const INSTRUCTION_RESERVE_TOKENS = 1500;
/**
 * A tool-using agent works by looking, not by reading its pack: the pack is re-sent with every turn of the attempt (a 25k pack over eight turns
 * is 200k tokens), so it stays small and what is cut is one read away by reference (documents.read with the artifact id).
 */
export const TOOL_CONTEXT_BUDGET_TOKENS = 4000;

/**
 * The pack's token budget: its own share of the ceiling, but never more than what the overall prompt budget leaves after the task's brief
 * (a long brief with upstream deliverables can be ~7000 tokens), the instructions and the skills this task loads. A floor keeps the facts of the brief in.
 */
export function contextBudget(maxTokens: number, taskText: string, usesTools = false, skillsTokens = 0): number {
  const own = Math.min(Math.floor(maxTokens * CONTEXT_BUDGET_SHARE), usesTools ? TOOL_CONTEXT_BUDGET_TOKENS : Infinity);
  const left = Math.floor(maxTokens * PROMPT_BUDGET_SHARE) - Math.ceil(taskText.length / 4) - INSTRUCTION_RESERVE_TOKENS - skillsTokens;
  return Math.max(256, Math.min(own, left));
}

export type ContextPackPort = (
  organizationId: string,
  workspaceId: string,
  input: { runId: string; jobId: string; agentId: string; budgetTokens: number; taskText: string; tools: ReadonlyArray<{ id: string; allowedHosts?: readonly string[] }> },
) => { text: string; manifest: { estimatedTokens: number; budgetTokens: number }; bodies: ReadonlyMap<string, string>; unavailableTools: ReadonlyArray<{ id: string; reason: string }> } | undefined;

/**
 * Builds the context pack of an agent step once, at its first offer, and pins
 * it into the job payload (which the execution artifact then freezes). The
 * manifest and the full text behind every truncation become immutable
 * artifacts of the job. A repeat claim finds the pack and leaves it alone.
 */
export function ensureContextPack(s: Store, build: ContextPackPort, organizationId: string, job: Record<string, unknown>): void {
  const jobId = String(job["id"]);
  const row = s.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { payload_json: string } | undefined;
  if (!row) return;
  const payload = JSON.parse(row.payload_json) as { step?: { task?: string; uses?: { type?: string; release?: { id: string } } }; input?: unknown; contextPack?: unknown; skills?: Array<{ text: string }> };
  const agentId = payload.step?.uses?.type === "agent" ? payload.step.uses.release?.id : undefined;
  if (!agentId || payload.contextPack) return;
  // A job whose execution artifact is already pinned (offered before this code, or by an earlier claim) keeps exactly those bytes.
  if (s.control.prepare("SELECT 1 FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(`exec-${jobId}`, organizationId)) return;
  const workspaceId = String(job["workspace_id"]);
  const release = releaseRecord(s, organizationId, String(job["config_digest"]))?.release;
  const spec = release?.agents?.[agentId]?.spec;
  const maxTokens = spec?.maxTokens ?? 0;
  // The tools this agent may call, with the hosts the release pins for web tools: the Governor decides which of them are worth offering for this task.
  const tools = (spec?.tools ?? []).map((allowed) => {
    const hosts = release?.manifest.tools?.find((tool) => tool.id === allowed.id && tool.digest === allowed.digest)?.allowedHosts;
    return { id: allowed.id, ...(hosts ? { allowedHosts: hosts } : {}) };
  });
  try {
    pinContextPack(s, build, organizationId, workspaceId, job, jobId, agentId, maxTokens, payload, tools);
  } catch {
    // A pack that cannot be built or stored must never stall the runner: the step runs with its own input only and the run page shows no pack.
  }
}

function pinContextPack(s: Store, build: ContextPackPort, organizationId: string, workspaceId: string, job: Record<string, unknown>, jobId: string, agentId: string, maxTokens: number, payload: { step?: { task?: string }; input?: unknown; contextPack?: unknown; skills?: Array<{ text: string }> }, tools: ReadonlyArray<{ id: string; allowedHosts?: readonly string[] }>): void {
  // The prompt the runner sends is this pack followed by the step's task (or its input): the pack budget leaves room for it, and the pack skips what the task already says.
  const taskText = promptTaskText(payload);
  const pack = build(organizationId, workspaceId, { runId: String(job["workflow_run_id"]), jobId, agentId, budgetTokens: contextBudget(maxTokens, taskText, tools.length > 0, skillTokens(payload.skills)), taskText, tools });
  if (!pack) return;
  const store = (artifactId: string, text: string, mediaType: string) => {
    const bytes = new TextEncoder().encode(text);
    const digest = sha256Digest(bytes);
    putBytes(s, bytes);
    registerArtifact(s, { artifactId, organizationId, workspaceId, digest, bytes: bytes.length, mediaType, classification: "internal", owner: { kind: "job", id: jobId } });
    return { artifactId, digest, bytes: bytes.length };
  };
  for (const [reference, body] of pack.bodies) store(`ctxref-${jobId}-${reference.slice("artifact:sha256:".length, "artifact:sha256:".length + 16)}`, body, "text/plain");
  const manifest = store(`ctx-${jobId}`, JSON.stringify(pack.manifest), "application/json");
  payload.contextPack = { text: pack.text, manifestArtifact: manifest, estimatedTokens: pack.manifest.estimatedTokens, budgetTokens: pack.manifest.budgetTokens, unavailableTools: pack.unavailableTools };
  s.control.prepare("UPDATE job_payloads SET payload_json=? WHERE job_id=?").run(JSON.stringify(payload), jobId);
}

// Materializes a job's execution payload as a scoped CAS artifact so the
// JobOffer references durable bytes instead of inlining the payload (T02).
export function ensureExecutionArtifact(s: Store, jobId: string, organizationId: string, workspaceId: string, payloadText: string, artifactId: string = `exec-${jobId}`): { artifactId: string; digest: string; bytes: number } {
  const bytes = new TextEncoder().encode(payloadText);
  const digest = sha256Digest(bytes);
  const existing = s.control.prepare("SELECT digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(artifactId, organizationId) as { digest: string } | undefined;
  if (existing) {
    if (existing.digest !== digest) throw new BrainDomainError("CONFLICT", "job execution artifact already pinned to different bytes");
    return { artifactId, digest, bytes: bytes.length };
  }
  putBytes(s, bytes);
  registerArtifact(s, { artifactId, organizationId, workspaceId, digest, bytes: bytes.length, mediaType: "application/json", classification: "internal", owner: { kind: "job", id: jobId } });
  return { artifactId, digest, bytes: bytes.length };
}

/** The agent definition a job's pinned payload runs (an agent step names its release); none for an eval, merge or tool step. The model never names it. */
function pinnedAgentOf(s: Store, jobId: string): string | undefined {
  const row = s.control.prepare("SELECT kind, payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { kind: string; payload_json: string } | undefined;
  if (!row || row.kind === "eval" || row.kind === "merge") return undefined;
  const uses = (JSON.parse(row.payload_json) as { step?: { uses?: { type?: string; release?: { id?: string } } } }).step?.uses;
  return uses?.type === "agent" && typeof uses.release?.id === "string" ? uses.release.id : undefined;
}

/** What a runner needs to act as a session: the credential, and the ids the model cannot know (the mission, the member and the task this attempt serves). */
export interface SessionCredential { principalId: string; credential: string; expiresAt: string; workspaceId: string; missionId: string; memberId?: string; workItemId?: string }

/** See JobProtocol.sessionCredential. Only a running attempt of an agent step that belongs to a mission acts as a session. */
export function sessionCredential(s: Store, binding: JobProtocolPorts["sessionBinding"], runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string): SessionCredential {
  const row = loadAttempt(s, attemptId);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  assertAttemptLive(s, runner, row);
  if (String(row["state"]) !== "running") throw new BrainDomainError("CONFLICT", "only a running attempt acts as a session");
  const payload = s.control.prepare("SELECT kind, payload_json FROM job_payloads WHERE job_id=?").get(String(row["job_id"])) as { kind: string; payload_json: string } | undefined;
  const usesAgent = payload && payload.kind !== "eval" && payload.kind !== "merge" && (JSON.parse(payload.payload_json) as { step?: { uses?: { type?: string } } }).step?.uses?.type === "agent";
  if (!usesAgent) throw new BrainDomainError("FORBIDDEN", "only an agent step acts as a session");
  const organizationId = String(row["organization_id"]);
  const workspaceId = String(row["workspace_id"]);
  const bound = binding?.(organizationId, workspaceId, String(row["workflow_run_id"]));
  if (!bound) throw new BrainDomainError("FORBIDDEN", "this attempt belongs to no mission, so it has no machine principal");
  const principal = ensureAgentPrincipal(s, { organizationId, workspaceId, ...bound });
  const { credential, expiresAtMs } = issueSessionCredential(s, { principalId: principal.principalId, organizationId, attemptId, jobFence: Number(row["job_fence"]) });
  return { principalId: principal.principalId, credential, expiresAt: iso(expiresAtMs), workspaceId, missionId: bound.missionId, ...(bound.memberId ? { memberId: bound.memberId } : {}), ...(bound.workItemId ? { workItemId: bound.workItemId } : {}) };
}

export function readExecutionArtifact(s: Store, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string): Uint8Array {
  const row = loadAttempt(s, attemptId);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  assertAttemptLive(s, runner, row);
  const artifactId = executionArtifactId(s, String(row["job_id"]));
  const assoc = s.control.prepare("SELECT digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(artifactId, runner.organizationId) as { digest: string } | undefined;
  if (!assoc) throw new BrainDomainError("EVIDENCE_MISSING", "execution artifact not materialized");
  return readVerified(s, assoc.digest);
}

/**
 * The saved conversation a resumed attempt continues (ADR 0068): the bytes of the checkpoint artifact its own job names, served to the runner
 * that holds the attempt and to no one else. The runner names nothing, so it cannot ask for another job's or workspace's artifact.
 */
export function readResumeCheckpoint(s: Store, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string): Uint8Array {
  const row = loadAttempt(s, attemptId);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  assertAttemptLive(s, runner, row);
  const payload = s.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(String(row["job_id"])) as { payload_json: string } | undefined;
  const state = (payload ? JSON.parse(payload.payload_json) as { resume?: { engineState?: { artifactId: string; digest: string; bytes: number } } } : {}).resume?.engineState;
  if (!state) throw new BrainDomainError("NOT_FOUND", "this attempt resumes no checkpoint");
  const assoc = s.control.prepare("SELECT digest, workspace_id FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(state.artifactId, runner.organizationId) as { digest: string; workspace_id: string } | undefined;
  if (!assoc || assoc.digest !== state.digest || assoc.workspace_id !== String(row["workspace_id"])) throw new BrainDomainError("EVIDENCE_MISSING", "the checkpoint artifact is not stored");
  return readVerified(s, assoc.digest, state.bytes);
}

export function offerJson(s: Store, attemptId: string): JsonValue {
  const row = s.control.prepare(`SELECT a.id AS attempt_id, a.job_id, a.runner_id, a.runner_epoch, a.lease_id, a.job_fence, a.attempt_no, a.offer_expires_at_ms,
    j.organization_id, j.workspace_id, j.config_digest, j.placement_json, j.workflow_run_id, j.step_id
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?`).get(attemptId) as Record<string, unknown> | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  const payloadRow = s.control.prepare("SELECT kind, payload_json FROM job_payloads WHERE job_id=?").get(String(row["job_id"])) as { kind: string; payload_json: string } | undefined;
  let artifactText = payloadRow?.payload_json ?? "{}";
  // The model routes are decided once, when the job is first offered, and stored with the payload so every later offer pins the same bytes.
  if (!s.control.prepare("SELECT 1 FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(`exec-${String(row["job_id"])}`, String(row["organization_id"]))) {
    const offer = modelRoutesForJob(s, String(row["job_id"]));
    const { routes } = offer;
    // The reason is written now, with the route the job was handed first and every route left out, and never rebuilt later.
    recordRouteOffer(s, String(row["job_id"]), offer);
    if (routes.length > 0) {
      artifactText = JSON.stringify({ ...(JSON.parse(artifactText) as Record<string, JsonValue>), modelRoutes: routes as unknown as JsonValue });
      s.control.prepare("UPDATE job_payloads SET payload_json=? WHERE job_id=?").run(artifactText, String(row["job_id"]));
    }
  }
  // A job resumed after the changes it proposed were settled (ADR 0028) is offered with what became of each one, as a new pinned artifact.
  const outcomes = effectOutcomesFor(s, String(row["job_id"]));
  if (outcomes.length > 0) artifactText = JSON.stringify({ ...(JSON.parse(artifactText) as Record<string, JsonValue>), effectOutcomes: outcomes as unknown as JsonValue });
  const artifact = ensureExecutionArtifact(s, String(row["job_id"]), String(row["organization_id"]), String(row["workspace_id"]), artifactText, executionArtifactId(s, String(row["job_id"])));
  let workflowDigest = String(row["config_digest"]);
  try {
    const ws = s.workspaceDb(String(row["workspace_id"]), String(row["organization_id"]));
    const runRow = ws.prepare("SELECT workflow_digest FROM workflow_runs WHERE id=?").get(String(row["workflow_run_id"])) as { workflow_digest: string } | undefined;
    if (runRow) workflowDigest = runRow.workflow_digest;
  } catch { /* direct jobs without a run keep the config digest */ }
  const parsedPayload = JSON.parse(artifactText) as { step?: { uses?: { type?: string } } };
  const kind = payloadRow?.kind === "eval" ? "eval"
    : payloadRow?.kind === "merge" ? "merge"
    : parsedPayload.step?.uses?.type === "agent" ? "agent" : "tool";
  const toolPins = releaseToolPins(s, String(row["config_digest"]));
  const authorEvidence = authorEvidenceFor(s, String(row["organization_id"]), String(row["workspace_id"]), String(row["workflow_run_id"]), String(row["config_digest"]));
  return {
    contractVersion: "brain.job-offer/v1", jobId: String(row["job_id"]), workflowRunId: String(row["workflow_run_id"]), attemptId,
    runnerId: String(row["runner_id"]), runnerEpoch: Number(row["runner_epoch"]), leaseId: String(row["lease_id"]),
    jobFence: Number(row["job_fence"]), organizationId: String(row["organization_id"]), workspaceId: String(row["workspace_id"]),
    attemptNumber: Number(row["attempt_no"]), offerExpiresAt: iso(Number(row["offer_expires_at_ms"])),
    configDigest: String(row["config_digest"]), workflowDigest,
    placement: JSON.parse(String(row["placement_json"])),
    execution: { kind, artifact: { artifactId: artifact.artifactId, digest: artifact.digest, bytes: artifact.bytes, mediaType: "application/json", classification: "internal" } },
    toolPins, toolAllowedHosts: releaseToolAllowedHosts(s, String(row["config_digest"])), toolMcp: releaseToolMcp(s, String(row["config_digest"])),
    egressHosts: workspaceEgressHosts(s, String(row["workspace_id"])),
    sourceRevision: authorEvidence.sourceRevision,
    primitiveVersions: authorEvidence.primitiveVersions,
    authorEvidence: { toolReleases: toolReleasesForPayload(JSON.parse(artifactText) as JsonValue), claimedChecks: authorEvidence.claimedChecks },
    grantRef: `grant-${attemptId}`,
  } as unknown as JsonValue;
}

export function loadAttempt(s: Store, attemptId: string): Record<string, unknown> {
  const row = s.control.prepare(`SELECT a.*, j.organization_id, j.workspace_id, j.workflow_run_id, j.step_id, j.job_fence AS current_job_fence,j.state AS job_state, j.version AS job_version
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?`).get(attemptId) as Record<string, unknown> | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  return row;
}

export function assertAttemptLive(s: Store, runner: { runnerId: string; epoch: number }, row: Record<string, unknown>, leaseId?: string, jobFence?: number): void {
  if (String(row["runner_id"]) !== runner.runnerId) throw new BrainDomainError("FORBIDDEN", "attempt belongs to another runner");
  if (Number(row["runner_epoch"]) !== runner.epoch) throw new BrainDomainError("LEASE_LOST", "runner epoch fenced");
  const currentRunner = s.control.prepare("SELECT session_epoch,admin_state FROM runners WHERE id=?").get(runner.runnerId) as { session_epoch: number; admin_state: string } | undefined;
  if (!currentRunner || currentRunner.session_epoch !== runner.epoch || ["quarantined","disabled"].includes(currentRunner.admin_state) || row["job_fence"] !== row["current_job_fence"]) throw new BrainDomainError("LEASE_LOST", "runner or job is fenced");
  if (leaseId && String(row["lease_id"]) !== leaseId) throw new BrainDomainError("LEASE_LOST", "lease mismatch");
  if (jobFence !== undefined && Number(row["job_fence"]) !== jobFence) throw new BrainDomainError("LEASE_LOST", "job fence stale");
  if (Number(row["lease_expires_at_ms"]) <= s.now() && String(row["state"]) === "running") throw new BrainDomainError("LEASE_LOST", "lease expired");
  s.assertWorkspaceActive(String(row["workspace_id"]), String(row["organization_id"]));
}

export function ackAttempt(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  let result: JsonValue = null;
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, String(body["leaseId"] ?? ""), Number(body["jobFence"] ?? row["job_fence"]));
    if (String(row["state"]) === "running") { result = { attemptId, leaseExpiresAt: iso(Number(row["lease_expires_at_ms"])) } as unknown as JsonValue; return; }
    if (String(row["state"]) !== "offered") throw new BrainDomainError("CONFLICT", "attempt not offered");
    if (Number(row["offer_expires_at_ms"]) <= s.now()) throw new BrainDomainError("LEASE_LOST", "offer expired");
    const expires = s.now() + 60_000;
    transitionState(s.control, "attempt", attemptId, "running", { set: { lease_expires_at_ms: expires } });
    transitionState(s.control, "job", String(row["job_id"]), "running", { bumpVersion: true });
    stampAttemptDeadline(s, String(row["job_id"]), attemptId);
    {
      const engine = body["engine"] as { id?: string; adapterDigest?: string; features?: unknown } | undefined;
      recordAttemptSession(s, {
        organizationId: String(row["organization_id"]), workspaceId: String(row["workspace_id"]),
        jobId: String(row["job_id"]), attemptId,
        engineId: String(engine?.id ?? "unknown"), adapterDigest: String(engine?.adapterDigest ?? `sha256:${"0".repeat(64)}`),
        features: engineFeaturesFromBody(engine), runId: String(row["workflow_run_id"]),
      });
    }
    result = { attemptId, leaseId: String(row["lease_id"]), jobFence: Number(row["job_fence"]), leaseExpiresAt: iso(expires) } as unknown as JsonValue;
  });
  return result;
}

export function renewAttempt(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  let expires = 0;
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, String(body["leaseId"] ?? ""), Number(body["jobFence"] ?? row["job_fence"]));
    if (String(row["state"]) !== "running") throw new BrainDomainError("CONFLICT", "attempt not running");
    expires = s.now() + 60_000;
    s.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(expires, attemptId);
  });
  return { attemptId, leaseExpiresAt: iso(expires) } as unknown as JsonValue;
}

export function attemptEvents(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  const events = (body["events"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (events.length > 128) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "event batch exceeds 128");
  // E063: malformed stream items are contained — rejected with diagnostics
  // before any sequence advance, never coerced (NaN would poison lastSeq).
  for (const ev of events) {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      throw new BrainDomainError("INVALID_CONTRACT", "attempt event must be an object");
    }
    const seqRaw = (ev as { sequence?: unknown }).sequence;
    if (seqRaw !== undefined && (!Number.isSafeInteger(seqRaw) || (seqRaw as number) < 1)) {
      throw new BrainDomainError("INVALID_CONTRACT", "attempt event sequence must be a positive safe integer");
    }
    if (JSON.stringify(ev).length > 64 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "attempt event exceeds 64 KiB");
  }
  let lastSeq = 0;
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, String(body["leaseId"] ?? row["lease_id"]), Number(body["jobFence"] ?? row["job_fence"]));
    lastSeq = Number(row["last_event_seq"]);
    for (const ev of events) {
      const seq = Number((ev as { sequence?: number }).sequence ?? (lastSeq + 1));
      if (seq <= lastSeq) continue;
      const stored = s.control.prepare("INSERT OR IGNORE INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, seq, JSON.stringify(ev));
      // Tool calls are counted when their event is first stored; a replayed batch inserts nothing and so counts nothing twice.
      if (stored.changes === 1) recordToolCall(s, row, attemptId, ev);
      // The runner reports a held or released engine as a progress event; the Governor dates it on its own clock (ADR 0058).
      if (stored.changes === 1 && (ev as { kind?: unknown }).kind === "progress") {
        const phase = ((ev as { payload?: { phase?: unknown } }).payload)?.phase;
        if (typeof phase === "string") {
          const heldMs = recordPauseProgress(s, attemptId, phase);
          // The step's timeout does not run while the engine is held (ADR 0058): its deadline moves by the held time.
          if (heldMs > 0) s.control.prepare("UPDATE job_attempts SET deadline_ms=deadline_ms+? WHERE id=? AND deadline_ms IS NOT NULL").run(heldMs, attemptId);
        }
      }
      lastSeq = seq;
    }
    s.control.prepare("UPDATE job_attempts SET last_event_seq=? WHERE id=?").run(lastSeq, attemptId);
    // Keep the session view's cursor current so the live feed resumes at the
    // authoritative sequence instead of replaying the whole transcript.
    const eng = body["engine"] as { id?: unknown; adapterDigest?: unknown; features?: unknown; model?: unknown } | undefined;
    // What the runner reports about the attempt is kept once, as reported: the usage ledger attributes the attempt's spend to it (ADR 0051).
    if (eng && typeof eng.id === "string" && eng.id.length > 0) {
      s.control.prepare("UPDATE job_attempts SET reported_engine=COALESCE(reported_engine,?), reported_model=COALESCE(reported_model,?) WHERE id=?")
        .run(eng.id.slice(0, 64), typeof eng.model === "string" && eng.model.length > 0 ? eng.model.slice(0, 128) : null, attemptId);
    }
    recordAttemptProgress(s, {
      organizationId: String(row["organization_id"]), workspaceId: String(row["workspace_id"]), attemptId, lastSequence: lastSeq,
      engine: eng && typeof eng.id === "string" && eng.id.length > 0
        ? { id: eng.id, adapterDigest: typeof eng.adapterDigest === "string" ? eng.adapterDigest : undefined, features: engineFeaturesFromBody(eng) }
        : undefined,
    });
  });
  return { attemptId, lastCommittedSequence: lastSeq } as unknown as JsonValue;
}

/** Keeps the tool catalog's call counts current: a proposed call opens a row, its result marks it failed or finished. */
function recordToolCall(s: Store, attempt: Record<string, unknown>, attemptId: string, ev: Record<string, unknown>): void {
  const engineEvent = ev["payload"] as { kind?: string; occurredAt?: string; payload?: { proposalId?: unknown; tool?: { id?: unknown }; receipt?: { result?: unknown; finishedAt?: unknown; stdout?: { digest?: unknown } } } } | undefined;
  const body = engineEvent?.payload;
  if (!engineEvent || !body || typeof body.proposalId !== "string") return;
  if (engineEvent.kind === "tool.proposed" && typeof body.tool?.id === "string") {
    s.control.prepare("INSERT OR IGNORE INTO tool_calls(attempt_id, proposal_id, organization_id, workspace_id, run_id, tool_id, proposed_at) VALUES (?,?,?,?,?,?,?)")
      .run(attemptId, body.proposalId, String(attempt["organization_id"]), String(attempt["workspace_id"]), String(attempt["workflow_run_id"]), body.tool.id, String(engineEvent.occurredAt ?? ""));
  } else if (engineEvent.kind === "tool.result") {
    const finished = typeof body.receipt?.finishedAt === "string" ? body.receipt.finishedAt : String(engineEvent.occurredAt ?? "");
    const failed = body.receipt?.result === "failed";
    s.control.prepare("UPDATE tool_calls SET failed=?, finished_at=?, failure_message=? WHERE attempt_id=? AND proposal_id=?")
      .run(failed ? 1 : 0, finished, failed ? failureMessage(s, body.receipt?.stdout?.digest) ?? null : null, attemptId, body.proposalId);
  }
}

/** The plain-words error a failed tool call recorded in its result artifact ({"error": "..."}), for the registry's "last error". */
function failureMessage(s: Store, digest: unknown): string | undefined {
  if (typeof digest !== "string") return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(readVerified(s, digest))) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim().slice(0, 300) : undefined;
  } catch { return undefined; }
}

export function releaseReservation(s: Store, attemptId: string): void {
  const res = s.control.prepare("SELECT runner_id, cpu, memory, disk, slots, released_at_ms FROM capacity_reservations WHERE attempt_id=?").get(attemptId) as
    | { runner_id: string; cpu: number; memory: number; disk: number; slots: number; released_at_ms: number | null } | undefined;
  if (!res || res.released_at_ms) return;
  s.control.prepare("UPDATE runners SET cpu_reserved=MAX(0,cpu_reserved-?), memory_reserved=MAX(0,memory_reserved-?), disk_reserved=MAX(0,disk_reserved-?), slots_reserved=MAX(0,slots_reserved-?) WHERE id=?")
    .run(res.cpu, res.memory, res.disk, res.slots, res.runner_id);
  s.control.prepare("UPDATE capacity_reservations SET released_at_ms=? WHERE attempt_id=?").run(s.now(), attemptId);
}

export function completeAttempt(s: Store, deps: { completeStep: (organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean) => void }, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, body: Record<string, unknown>): JsonValue {
  const result = String(body["result"] ?? "failed");
  if (!["succeeded","failed","unknown-outcome"].includes(result) || !Number.isSafeInteger(body["jobFence"]) || typeof body["cleanupConfirmed"] !== "boolean") throw new BrainDomainError("INVALID_CONTRACT", "completion requires a valid result, fence and cleanup status");
  const output = (body["output"] ?? null) as JsonValue;
  let jobState = "";
  let runId = ""; let stepId = ""; let workspaceId = ""; let jobId = ""; let isAct = false; let attemptFailed = false;
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    runId = String(row["workflow_run_id"]); stepId = String(row["step_id"]); workspaceId = String(row["workspace_id"]); jobId = String(row["job_id"]);
    isAct = (s.control.prepare("SELECT kind FROM job_payloads WHERE job_id=?").get(jobId) as { kind: string } | undefined)?.kind === "act";
    const receiptDigest = domainDigest("brain:receipt:v1", body as unknown as JsonValue);
    assertAttemptLive(s, runner, row, undefined, Number(body["jobFence"]));
    if (row["organization_id"] !== runner.organizationId) throw new BrainDomainError("FORBIDDEN", "attempt tenant mismatch");
    if (row["receipt_digest"] === receiptDigest) { jobState=String(row["job_state"]); return; }
    if (row["receipt_digest"] && String(row["receipt_digest"]) !== receiptDigest && ["verifying", "succeeded"].includes(String(row["state"]))) {
      throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "different receipt for completed attempt");
    }
    if (row["state"] !== "running" || row["job_state"] !== "running") throw new BrainDomainError("CONFLICT", "attempt cannot accept a new completion receipt");
    const cleanup = body["cleanupConfirmed"] === true ? 1 : 0;
    if (result === "unknown-outcome" || result === "unknown") {
      markPlatformInterruption(s, attemptId);
      transitionState(s.control, "attempt", attemptId, "outcome_unknown", { set: { receipt_digest: receiptDigest, cleanup_confirmed: cleanup } });
      transitionState(s.control, "job", String(row["job_id"]), "outcome_unknown", { bumpVersion: true });
      jobState = "outcome_unknown";
      if (restartInterruptedReadJob(s, String(row["job_id"]), attemptId)) jobState = "queued";
    } else if (result === "succeeded") {
      transitionState(s.control, "attempt", attemptId, "verifying", { set: { receipt_digest: receiptDigest, cleanup_confirmed: cleanup } });
      transitionState(s.control, "job", String(row["job_id"]), "verifying", { bumpVersion: true });
      jobState = "verifying";
      const held = body["held"] === true && !isAct && (s.control.prepare("SELECT COUNT(*) AS n FROM effect_calls WHERE attempt_id=?").get(attemptId) as { n: number }).n > 0;
      if (isAct) {
        // A held change has nothing to verify: its permit and receipt are the evidence, carried by the bundle of the job that proposed it.
        transitionState(s.control, "attempt", attemptId, "succeeded");
        transitionState(s.control, "job", String(row["job_id"]), "succeeded", { bumpVersion: true });
        jobState = "succeeded";
      } else if (held) {
        // The attempt proposed changes and ends here (ADR 0028): it holds no slot and no lease while people decide. Its job waits, blocked,
        // until every proposed change is settled, then runs a fresh attempt that is told what happened. No evidence yet: the bundle is
        // written by that last attempt, so it can carry the receipts.
        transitionState(s.control, "attempt", attemptId, "succeeded");
        transitionState(s.control, "job", String(row["job_id"]), "blocked", { set: { queue_reason: HOLD_REASON }, bumpVersion: true });
        jobState = "blocked";
      } else {
        s.control.prepare("INSERT OR REPLACE INTO job_outputs(job_id, output_json) VALUES (?,?)").run(String(row["job_id"]), JSON.stringify(output));
      }
    } else {
      transitionState(s.control, "attempt", attemptId, "failed", { set: { receipt_digest: receiptDigest, cleanup_confirmed: cleanup } });
      const reason = failureReasonOf(output);
      recordAttemptFailure(s, attemptId, Number(row["last_event_seq"]), reason);
      // The step may be offered again (its retry, ADR 0046); the job then waits in the queue and the run does not hear of the failure.
      jobState = retryFailedAttempt(s, { jobId: String(row["job_id"]), reason }) ? "queued" : "failed";
      if (jobState === "failed") transitionState(s.control, "job", String(row["job_id"]), "failed", { bumpVersion: true });
      attemptFailed = true;
    }
    if (cleanup === 1) releaseReservation(s, attemptId);
    settleRouteReport(s, { attemptId, jobId, workspaceId, report: body["modelRoutes"] });
    endAttemptSession(s, { organizationId: String(row["organization_id"]), workspaceId, attemptId, failed: attemptFailed });
    // An engine that can resume saved its conversation and the runner uploaded it before completing; the session records the checkpoint (ADR 0068).
    if (body["checkpoint"] !== undefined) recordAttemptCheckpoint(s, { organizationId: String(row["organization_id"]), workspaceId, attemptId, checkpoint: body["checkpoint"] });
    revokeSessionCredentials(s, attemptId);
    for (const keyRow of s.control.prepare("SELECT resource_key FROM resource_leases WHERE attempt_id=?").all(attemptId) as Array<{ resource_key: string }>) {
      void keyRow; // unresolved guards persist until reconciled; compute release is separate
    }
  });
  s.emit(s.control, { organizationId: runner.organizationId, workspaceId, aggregateType: "job", aggregateId: jobId, eventType: "job.updated", payload: { attemptId, jobState }, destinations: [`workspace:${workspaceId}`] });
  // A held act job belongs to no workflow step: its outcome reaches the task through the job that proposed it.
  if (jobState === "failed" && !isAct) deps.completeStep(runner.organizationId, workspaceId, runId, stepId, redactFailureOutput(output), false);
  return { attemptId, jobState, acceptedForVerification: jobState === "verifying" } as unknown as JsonValue;
}

/**
 * Why the attempt failed, said once where people look: the redacted, short error of the failed step is kept on the attempt and written to
 * the attempt's log as an error-level `attempt.failed` record (the run inspector, Logs and the failure class all read it from here).
 */
function recordAttemptFailure(s: Store, attemptId: string, lastSeq: number, reason: string | undefined): void {
  if (!reason) return;
  const seq = lastSeq + 1;
  s.control.prepare("UPDATE job_attempts SET failure_reason=?, last_event_seq=? WHERE id=?").run(reason, seq, attemptId);
  const event = { sequence: seq, kind: "failed", payload: { reason, code: failureCode(reason), occurredAt: s.nowIso() } };
  s.control.prepare("INSERT OR IGNORE INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, seq, JSON.stringify(event));
}

export function releaseAttempt(s: Store, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
  s.inTx(s.control, () => {
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row, body["leaseId"] === undefined ? undefined : String(body["leaseId"]), body["jobFence"] === undefined ? undefined : Number(body["jobFence"]));
    const cleanup = body["cleanupConfirmed"] === true;
    if (cleanup) s.control.prepare("UPDATE job_attempts SET cleanup_confirmed=1 WHERE id=?").run(attemptId);
    if (cleanup) releaseReservation(s, attemptId);
    if (String(row["state"]) === "offered") {
      transitionState(s.control, "attempt", attemptId, "declined");
      transitionState(s.control, "job", String(row["job_id"]), "queued", { bumpVersion: true });
      releaseReservation(s, attemptId);
    }
  });
  return { attemptId, released: true } as unknown as JsonValue;
}

/** Interruptions that count against a read-only job before the Governor stops restarting it by itself. */
const MAX_INTERRUPTION_RESTARTS = 5;
/** Safety cap on all attempts of one job, platform interruptions included, so a restart loop can never run forever. */
const MAX_TOTAL_ATTEMPTS = 20;

/** How many attempts of the job were interrupted or failed for a reason of their own (not a platform restart). */
export function countedInterruptions(s: Store, jobId: string): number {
  return (s.control.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE job_id=? AND state IN ('failed','outcome_unknown') AND interruption IS NULL").get(jobId) as { n: number }).n;
}

/** How many attempts of the job ended without a result, whatever the cause; the number a person is told. */
export function interruptionTotal(s: Store, jobId: string): number {
  return (s.control.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE job_id=? AND state IN ('failed','outcome_unknown')").get(jobId) as { n: number }).n;
}

/**
 * Whether the Governor may queue the job for another attempt by itself. An attempt that the platform interrupted (a
 * Governor or runner restart, a lease lost while the runner process was replaced) never consumes the budget of
 * MAX_INTERRUPTION_RESTARTS; only the safety cap of MAX_TOTAL_ATTEMPTS bounds it.
 */
export function restartBudgetLeft(s: Store, jobId: string, attemptId?: string): boolean {
  const job = s.control.prepare("SELECT attempt_counter FROM jobs WHERE id=?").get(jobId) as { attempt_counter: number } | undefined;
  if (!job || job.attempt_counter >= MAX_TOTAL_ATTEMPTS) return false;
  if (attemptId && (s.control.prepare("SELECT interruption FROM job_attempts WHERE id=?").get(attemptId) as { interruption: string | null } | undefined)?.interruption === "platform") return true;
  return countedInterruptions(s, jobId) < MAX_INTERRUPTION_RESTARTS;
}

/** Records that the platform, not the attempt, ended it. */
export function markPlatformInterruption(s: Store, attemptId: string): void {
  s.control.prepare("UPDATE job_attempts SET interruption='platform' WHERE id=? AND interruption IS NULL").run(attemptId);
}

/**
 * An agent or evaluator job that only reads, and never held an effect permit or resource lease, has nothing to reconcile after an
 * interruption (runner restart, lost lease, unknown outcome): its attempt is concluded as interrupted and the job queues
 * for a fresh attempt. This is not a failure of the work, so no run failure is reported and no failed attempt counts.
 * Returns true when the job was restarted.
 */
export function restartInterruptedReadJob(s: Store, jobId: string, attemptId: string): boolean {
  const job = s.control.prepare("SELECT state FROM jobs WHERE id=?").get(jobId) as { state: string } | undefined;
  if (!job || job.state !== "outcome_unknown" || !restartBudgetLeft(s, jobId, attemptId)) return false;
  if (!isReadOnlyReasoningJob(s, jobId, attemptId)) return false;
  transitionState(s.control, "attempt", attemptId, "failed");
  transitionState(s.control, "job", jobId, "queued", { set: { queue_reason: "RESTARTED_AFTER_INTERRUPTION" }, bumpVersion: true });
  releaseReservation(s, attemptId);
  return true;
}

/** An agent or evaluator job with effect class read that never held an effect permit or resource lease: a second run is harmless. */
export function isReadOnlyReasoningJob(s: Store, jobId: string, attemptId: string): boolean {
  const job = s.control.prepare("SELECT effect_class FROM jobs WHERE id=?").get(jobId) as { effect_class: string } | undefined;
  if (!job || job.effect_class !== "read") return false;
  const effects = s.control.prepare("SELECT (SELECT COUNT(*) FROM effect_permits WHERE attempt_id=?) + (SELECT COUNT(*) FROM resource_leases WHERE attempt_id=?) AS n").get(attemptId, attemptId) as { n: number };
  if (effects.n > 0) return false;
  // Only reasoning (agent) and evaluator steps restart themselves: they hold no effect of their own and a second run is harmless.
  const payload = s.control.prepare("SELECT kind, payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { kind: string; payload_json: string } | undefined;
  const usesType = payload ? (JSON.parse(payload.payload_json) as { step?: { uses?: { type?: string } } }).step?.uses?.type : undefined;
  return !!payload && (payload.kind === "eval" || usesType === "agent");
}

export { MAX_INTERRUPTION_RESTARTS, MAX_TOTAL_ATTEMPTS };

export function expireLeases(s: Store): number {
  let count = 0;
  s.inTx(s.control, () => {
    const offered = s.control.prepare("SELECT id, job_id FROM job_attempts WHERE state='offered' AND offer_expires_at_ms<=?").all(s.now()) as Array<{ id: string; job_id: string }>;
    for (const a of offered) {
      transitionState(s.control, "attempt", a.id, "expired");
      transitionState(s.control, "job", a.job_id, "queued", { set: { queue_reason: "WAITING_FOR_RUNNER" }, bumpVersion: true });
      releaseReservation(s, a.id);
      count++;
    }
    const running = s.control.prepare("SELECT id, job_id FROM job_attempts WHERE state='running' AND lease_expires_at_ms<=?").all(s.now()) as Array<{ id: string; job_id: string }>;
    for (const a of running) {
      // The runner stopped renewing the lease: its process was replaced or the Governor was down. That is the platform's doing.
      markPlatformInterruption(s, a.id);
      revokeSessionCredentials(s, a.id);
      transitionState(s.control, "attempt", a.id, "outcome_unknown");
      transitionState(s.control, "job", a.job_id, "outcome_unknown", { bumpVersion: true });
      restartInterruptedReadJob(s, a.job_id, a.id);
      count++;
    }
  });
  return count;
}

/**
 * Ends the running attempts that passed the deadline their step's `timeoutSeconds` set when they started (ADR 0046). The runner finds its
 * attempt fenced at its next lease renewal and stops. An attempt that took no effect permit or lease has changed nothing, so it fails
 * like any failed attempt: the step may be offered again, else the step fails with a plain reason. One that may have changed a
 * target is left outcome unknown for reconciliation, never retried. Idempotent: an ended attempt is no longer running.
 */
export function expireAttemptDeadlines(s: Store, deps: { completeStep: (organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean) => void }): number {
  const due = s.control.prepare(`SELECT a.id AS attemptId, a.job_id AS jobId, j.organization_id AS organizationId, j.workspace_id AS workspaceId, j.workflow_run_id AS runId, j.step_id AS stepId
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.state='running' AND a.deadline_ms IS NOT NULL AND a.deadline_ms<=?
      AND NOT EXISTS (SELECT 1 FROM attempt_pauses p WHERE p.attempt_id=a.id AND p.paused_at_ms IS NOT NULL AND p.resumed_at_ms IS NULL) ORDER BY a.deadline_ms, a.id LIMIT 200`).all(s.now()) as Array<{ attemptId: string; jobId: string; organizationId: string; workspaceId: string; runId: string; stepId: string }>;
  let count = 0;
  const failures: Array<{ due: (typeof due)[number]; message: string }> = [];
  for (const item of due) {
    const ended = s.inTx(s.control, () => {
      const row = s.control.prepare("SELECT a.state, a.last_event_seq AS lastSeq, j.state AS jobState FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?").get(item.attemptId) as { state: string; lastSeq: number; jobState: string } | undefined;
      if (!row || row.state !== "running" || row.jobState !== "running") return false;
      const { timeoutSeconds, cappedBy } = stepPolicy(s, item.jobId);
      const message = `The step timed out after ${timeoutSeconds ?? 0} seconds${cappedBy ? ` (the longest runtime policy ${cappedBy} allows)` : ""}.`;
      if (heldEffect(s, item.attemptId)) {
        // It may have changed something: only reconciliation settles it (E056), as for a runner that vanished.
        transitionState(s.control, "attempt", item.attemptId, "outcome_unknown");
        transitionState(s.control, "job", item.jobId, "outcome_unknown", { bumpVersion: true });
      } else {
        transitionState(s.control, "attempt", item.attemptId, "failed");
        recordAttemptFailure(s, item.attemptId, row.lastSeq, message);
        if (!retryFailedAttempt(s, { jobId: item.jobId, reason: message })) {
          transitionState(s.control, "job", item.jobId, "failed", { bumpVersion: true });
          failures.push({ due: item, message });
        }
        releaseReservation(s, item.attemptId);
      }
      endAttemptSession(s, { organizationId: item.organizationId, workspaceId: item.workspaceId, attemptId: item.attemptId, failed: true });
      revokeSessionCredentials(s, item.attemptId);
      return true;
    });
    if (!ended) continue;
    count++;
    s.emit(s.control, { organizationId: item.organizationId, workspaceId: item.workspaceId, aggregateType: "job", aggregateId: item.jobId, eventType: "job.updated", payload: { attemptId: item.attemptId, jobState: (s.control.prepare("SELECT state FROM jobs WHERE id=?").get(item.jobId) as { state: string }).state, timedOut: true }, destinations: [`workspace:${item.workspaceId}`] });
  }
  for (const { due: item, message } of failures) deps.completeStep(item.organizationId, item.workspaceId, item.runId, item.stepId, { error: message, code: "STEP_TIMEOUT" } as unknown as JsonValue, false);
  return count;
}
