import { approvalSubjectDigest, domainDigest } from "@brain/contracts";
import type { ActionSubject, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { transitionState } from "../../domain/states";
import type { Store } from "../../application/store";
import type { BrainAuth } from "../identity/index";
import { operationAdmissionRefusal, releaseRecord } from "../configuration/index";
import { payloadValidator } from "@brain/contracts/validate";
import { assertAttemptLive, createActJob, effectResultFor, loadAttempt } from "../jobs/index";
import { originOfRun } from "../missions/index";
import { issuePermit, validatePermit } from "./permits";
import { withRisk } from "./risk";

/**
 * Effect tools and permits per call (ADR 0024). An agent that wants to change something outside Brain proposes the call; the call stops
 * and the Governor records an approval whose subject is that exact call (tool, arguments digest, target, attempt). A person grants or
 * refuses it. A grant lets the Governor issue ONE permit bound to that call; it is consumed when the call starts, so a replay, another
 * call, other arguments or another attempt get nothing. Refusal or expiry fails the call and nothing is changed.
 */

export interface EffectPorts {
  /** Tells the people who can decide that an approval waits, with a deep link to that one decision. */
  notifyApprovers(input: { organizationId: string; workspaceId: string }): void;
  /** A plain reason when the tool's connector is not set up on this server (ticketing, messages, pull requests); undefined when it is. */
  unavailable(toolId: string, context: { organizationId: string; workspaceId: string }): string | undefined;
}

type Runner = { runnerId: string; epoch: number; organizationId: string };
type Input = Readonly<Record<string, unknown>>;

interface Policy {
  /** Reaches the demos host: allowed only on a runner group marked for host tools and bound to this workspace. */
  readonly host: boolean;
  summary(input: Input): string;
  /** The thing the call touches; two calls on the same one never overlap. */
  resource(input: Input): string | undefined;
  /** Throws a plain reason when the input names something outside the owner's allow-list or is malformed. */
  check(input: Input, allow: EffectAllowList): void;
}

export interface EffectAllowList { readonly containers: readonly string[]; readonly services: readonly string[]; readonly approvalMinutes: number; readonly egressHosts: readonly string[] }

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u;
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** What each effect tool may do is decided here, by the operator's code; a model or a Tool document cannot widen it. */
const POLICIES: Readonly<Record<string, Policy>> = {
  "host.restart": {
    host: true,
    summary: (input) => `Restart the container "${text(input["container"], 63)}" on the demos host`,
    resource: (input) => `container:${text(input["container"], 63)}`,
    check: (input, allow) => {
      const name = text(input["container"], 63);
      if (!NAME.test(name)) throw new BrainDomainError("INVALID_ARGUMENT", "container must be a container name");
      if (!allow.containers.includes(name)) throw new BrainDomainError("FORBIDDEN", `the container ${name} is not on this workspace's allow-list of restartable containers${allow.containers.length ? ` (${allow.containers.join(", ")})` : " (it is empty)"}; the owner adds it under the workspace's effect settings`);
    },
  },
  "host.reload": {
    host: true,
    summary: (input) => `Reload the service "${text(input["service"], 80)}" on the demos host`,
    resource: (input) => `service:${text(input["service"], 80)}`,
    check: (input, allow) => {
      const name = text(input["service"], 80);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_@-]{0,79}$/u.test(name)) throw new BrainDomainError("INVALID_ARGUMENT", "service must be a service name");
      if (!allow.services.includes(name)) throw new BrainDomainError("FORBIDDEN", `the service ${name} is not on this workspace's allow-list of reloadable services${allow.services.length ? ` (${allow.services.join(", ")})` : " (it is empty)"}`);
    },
  },
  "ticket.create": {
    host: false,
    summary: (input) => `Create a ticket: "${text(input["title"], 120)}"`,
    resource: () => undefined,
    check: (input) => { if (!text(input["title"], 200).trim()) throw new BrainDomainError("INVALID_ARGUMENT", "a ticket needs a title"); },
  },
  "message.send": {
    host: false,
    summary: (input) => `Send this message to the team channel: "${text(input["text"], 160)}"`,
    resource: () => undefined,
    check: (input) => { if (!text(input["text"], 2000).trim()) throw new BrainDomainError("INVALID_ARGUMENT", "a message needs text"); },
  },
  "git.open-pr": {
    host: false,
    summary: (input) => `Open a pull request "${text(input["title"], 120)}" from branch ${text(input["branch"], 80)} with ${Array.isArray(input["files"]) ? input["files"].length : 0} changed file(s)`,
    resource: (input) => `branch:${text(input["branch"], 80)}`,
    check: (input) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,79}$/u.test(text(input["branch"], 80)) || text(input["branch"], 80).includes("..")) throw new BrainDomainError("INVALID_ARGUMENT", "branch must be a plain branch name");
      if (!text(input["title"], 200).trim()) throw new BrainDomainError("INVALID_ARGUMENT", "a pull request needs a title");
    },
  },
};

function isEffectTool(toolId: string): boolean { return toolId in POLICIES; }

/**
 * An external MCP tool's policy (ADR 0064) comes from its pinned declaration, not from operator code per tool: the admin declared the
 * server host and the effect class, and the approval says exactly what will be sent. The arguments must satisfy the pinned input schema.
 */
function mcpPolicy(mcp: { host: string; tool: string }, inputSchema: object | undefined): Policy {
  return {
    host: false,
    summary: (input) => `Call the external tool "${mcp.tool}" on ${mcp.host} with ${JSON.stringify(input).slice(0, 300)}`,
    resource: () => `mcp:${mcp.host}:${mcp.tool}`,
    check: (input) => {
      if (!inputSchema) throw new BrainDomainError("FORBIDDEN", `the pinned input schema of ${mcp.tool} is missing, so the call cannot be checked`);
      const checked = payloadValidator(inputSchema)(input);
      if (!checked.ok) throw new BrainDomainError("INVALID_ARGUMENT", `the arguments do not match the tool's pinned input schema: ${checked.errors.slice(0, 3).join("; ")}`);
    },
  };
}

/** The digest of the arguments of a call; the runner computes the same value with the same function. */
export function effectInputDigest(input: Input): string {
  return domainDigest("brain:effect-input:v1", input as unknown as JsonValue);
}

export function effectAllowList(s: Store, workspaceId: string): EffectAllowList {
  const row = s.control.prepare("SELECT containers_json, services_json, approval_minutes, egress_hosts_json FROM workspace_effect_policy WHERE workspace_id=?").get(workspaceId) as { containers_json: string; services_json: string; approval_minutes: number; egress_hosts_json: string } | undefined;
  return row ? { containers: JSON.parse(row.containers_json) as string[], services: JSON.parse(row.services_json) as string[], approvalMinutes: row.approval_minutes, egressHosts: JSON.parse(row.egress_hosts_json) as string[] } : { containers: [], services: [], approvalMinutes: 30, egressHosts: [] };
}

/** The hosts a sandboxed tool of this workspace may reach through the egress proxy (ADR 0037); none means no network at all. */
export function workspaceEgressHosts(s: Store, workspaceId: string): string[] { return [...effectAllowList(s, workspaceId).egressHosts]; }

/**
 * One egress entry as the proxy matches it: a lower-case DNS name or IPv4 address, optionally with a port. An entry without a port
 * allows 80 and 443. Anything else (a scheme, a path, a wildcard, a bad port) is refused so the list says exactly what is reachable.
 */
export function normalizeEgressHost(raw: string): string {
  const entry = raw.trim().toLowerCase();
  const colon = entry.lastIndexOf(":");
  const host = colon < 0 ? entry : entry.slice(0, colon);
  const portText = colon < 0 ? undefined : entry.slice(colon + 1);
  const port = portText === undefined ? undefined : Number(portText);
  const nameOk = host.length >= 1 && host.length <= 253 && /^[a-z0-9.-]+$/u.test(host) && /^[a-z0-9]/u.test(host) && /[a-z0-9]$/u.test(host) && !/\.\.|\.-|-\./u.test(host);
  if (!nameOk || (portText !== undefined && (!/^[0-9]{1,5}$/u.test(portText) || port! < 1 || port! > 65535))) {
    throw new BrainDomainError("INVALID_ARGUMENT", `"${raw.trim()}" is not a host the proxy can allow: write a name or IPv4 address, optionally followed by :port (no scheme, path or wildcard)`);
  }
  return entry;
}

/** The runner groups the owner set aside, and whether this one may run host tools for this workspace. */
function runnerGroupAllowsHostTools(s: Store, organizationId: string, groupId: string, workspaceId: string): boolean {
  const row = s.control.prepare("SELECT host_tools, workspaces_json FROM runner_groups WHERE organization_id=? AND group_id=?").get(organizationId, groupId) as { host_tools: number; workspaces_json: string } | undefined;
  return !!row && row.host_tools === 1 && (JSON.parse(row.workspaces_json) as string[]).includes(workspaceId);
}

interface AttemptContext {
  readonly row: Record<string, unknown>; readonly organizationId: string; readonly workspaceId: string;
  readonly configDigest: string; readonly target: { targetId: string; environmentId: string; preconditionDigest: string };
  /** The agent whose allowlist backs the call: the step's own agent, or (for an act job) the agent that proposed it. */
  readonly agent: { id: string; digest: string };
  readonly effectClass: string;
  /** The pinned declaration of an external MCP tool, with its pinned input schema (ADR 0064). */
  readonly mcp?: { host: string; tool: string; inputSchema: object | undefined };
  /** True for the attempt of a held act job (ADR 0028): the only attempt that may take a permit and run the call. */
  readonly isAct: boolean;
}

/** An act job's payload: the call an approved proposal will make, with the job and attempt that proposed it. */
interface ActPayload { readonly proposalId: string; readonly approvalId: string; readonly parentJobId: string; readonly parentAttemptId: string; readonly agent: { id: string; digest: string } }

/**
 * The attempt, live and the runner's own, with the pinned tool: an agent step whose agent lists exactly this tool at this digest, declared
 * non-read, or the held act job of such a proposal (checked against the agent that proposed it).
 */
function attemptContext(s: Store, runner: Runner, attemptId: string, tool: { id: string; digest: string }): AttemptContext {
  const row = loadAttempt(s, attemptId);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  assertAttemptLive(s, runner, row);
  const organizationId = String(row["organization_id"]);
  const workspaceId = String(row["workspace_id"]);
  const payload = s.control.prepare("SELECT kind, payload_json FROM job_payloads WHERE job_id=?").get(String(row["job_id"])) as { kind: string; payload_json: string } | undefined;
  const parsed = payload ? JSON.parse(payload.payload_json) as { step?: { uses?: { type?: string; release?: { id: string; digest: string } } }; act?: ActPayload } : undefined;
  const isAct = payload?.kind === "act";
  const agentRef = isAct ? parsed?.act?.agent : parsed?.step?.uses?.type === "agent" ? parsed.step.uses.release : undefined;
  const configDigest = (s.control.prepare("SELECT config_digest FROM jobs WHERE id=?").get(String(row["job_id"])) as { config_digest: string }).config_digest;
  const release = releaseRecord(s, organizationId, configDigest)?.release;
  const agent = agentRef ? release?.agents?.[agentRef.id] : undefined;
  if (!agentRef || !agent || !agent.spec.tools.some((allowed) => allowed.id === tool.id && allowed.digest === tool.digest)) throw new BrainDomainError("FORBIDDEN", `this attempt's agent does not allow ${tool.id} at that digest`);
  const declared = release?.manifest.tools?.find((candidate) => candidate.id === tool.id && candidate.digest === tool.digest);
  if (!declared || declared.effectClass === "read") throw new BrainDomainError("FORBIDDEN", `${tool.id} is not an effect tool of the pinned release`);
  if (!declared.mcp && !isEffectTool(tool.id)) throw new BrainDomainError("FORBIDDEN", `${tool.id} has no effect policy on this server, so it cannot run`);
  const mcp = declared.mcp ? { host: declared.mcp.host, tool: declared.mcp.tool, inputSchema: release?.schemas?.[declared.inputSchemaRef] as object | undefined } : undefined;
  return { row, ...(mcp ? { mcp } : {}), organizationId, workspaceId, configDigest, agent: agentRef, effectClass: declared.effectClass, isAct, target: { targetId: `tool:${declared.id}`, environmentId: declared.allowedEnvironments?.[0] ?? "local", preconditionDigest: declared.digest } };
}

/** How many changes one task may propose in all (a model that keeps asking is stopped; a person can start the task again). */
const MAX_CALLS_PER_JOB = 10;

interface CallRow {
  attempt_id: string; proposal_id: string; organization_id: string; workspace_id: string; approval_id: string; tool_id: string; input_digest: string;
  resource_key: string; created_at_ms: number; parent_job_id: string; act_job_id: string; outcome: string | null; settled_at_ms: number | null;
}

function expireIfDue(s: Store, approvalId: string): string {
  const row = s.control.prepare("SELECT state, expires_at_ms FROM approval_requests WHERE id=?").get(approvalId) as { state: string; expires_at_ms: number } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "approval not found");
  if (row.state === "pending" && row.expires_at_ms <= s.now()) {
    transitionState(s.control, "approval", approvalId, "expired", { bumpVersion: true });
    return "expired";
  }
  return row.state;
}

export interface EffectRequestBody { readonly proposalId?: unknown; readonly tool?: { id?: unknown; digest?: unknown }; readonly input?: unknown }

function parseBody(body: EffectRequestBody): { proposalId: string; tool: { id: string; digest: string }; input: Input } {
  const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
  const tool = { id: typeof body.tool?.id === "string" ? body.tool.id : "", digest: typeof body.tool?.digest === "string" ? body.tool.digest : "" };
  if (!proposalId || !tool.id || !tool.digest || !body.input || typeof body.input !== "object" || Array.isArray(body.input)) throw new BrainDomainError("INVALID_ARGUMENT", "proposalId, tool and input are required");
  return { proposalId, tool, input: body.input as Input };
}

/**
 * An agent proposed an effect call: check everything the Governor can check now (the tool, the owner's allow-list, the runner group) and
 * record the approval of this exact call. Asking again for the same proposal returns the same approval.
 */
export function requestEffect(s: Store, ports: EffectPorts, runner: Runner, attemptId: string, body: EffectRequestBody): JsonValue {
  const { proposalId, tool, input } = parseBody(body);
  const context = attemptContext(s, runner, attemptId, tool);
  const refuse = (code: "FORBIDDEN" | "INVALID_ARGUMENT", reason: string): never => {
    s.emit(s.control, {
      organizationId: context.organizationId, workspaceId: context.workspaceId, aggregateType: "attempt", aggregateId: attemptId, eventType: "effect.refused",
      payload: { attemptId, toolId: tool.id, reason, message: `An effect call was declined before anyone was asked: ${tool.id}. ${reason}` }, destinations: [`workspace:${context.workspaceId}`],
    });
    throw new BrainDomainError(code, reason);
  };
  const policy = context.mcp ? mcpPolicy(context.mcp, context.mcp.inputSchema) : POLICIES[tool.id]!;
  // A held change is made by its own act job, never by the attempt that proposed it: an act attempt cannot propose another change.
  if (context.isAct) return refuse("FORBIDDEN", "an approved change cannot propose further changes");
  const parentJobId = String(context.row["job_id"]);
  const existing = s.control.prepare("SELECT * FROM effect_calls WHERE attempt_id=? AND proposal_id=?").get(attemptId, proposalId) as CallRow | undefined;
  if (existing) return describeCall(s, existing);
  // Asking again for the same change (same tool, same arguments) never makes a second approval: the answer is the first one's state, so a
  // model that keeps proposing, or a resumed attempt that repeats itself, is told what became of the change and cannot loop.
  const repeated = s.control.prepare("SELECT * FROM effect_calls WHERE parent_job_id=? AND tool_id=? AND input_digest=? ORDER BY created_at_ms LIMIT 1").get(parentJobId, tool.id, effectInputDigest(input)) as CallRow | undefined;
  if (repeated) return { ...(describeCall(s, repeated) as Record<string, JsonValue>), duplicate: true } as unknown as JsonValue;
  if ((s.control.prepare("SELECT COUNT(*) AS n FROM effect_calls WHERE parent_job_id=?").get(parentJobId) as { n: number }).n >= MAX_CALLS_PER_JOB) return refuse("FORBIDDEN", `this task already proposed ${MAX_CALLS_PER_JOB} changes; no more are taken`);
  try {
    if (policy.host) {
      const group = (s.control.prepare("SELECT group_id FROM runners WHERE id=?").get(runner.runnerId) as { group_id: string }).group_id;
      if (!runnerGroupAllowsHostTools(s, context.organizationId, group, context.workspaceId)) throw new BrainDomainError("FORBIDDEN", `host tools run only on the runner group the owner set aside for this workspace; this runner is in the group "${group}"`);
    }
    // The release's own policy comes first and names its layer: a denied operation, or one its allow-list leaves out, is never proposed (ADR 0067).
    const refusal = operationAdmissionRefusal(s, context.organizationId, context.configDigest, tool.id);
    if (refusal) throw new BrainDomainError("FORBIDDEN", refusal.message);
    policy.check(input, effectAllowList(s, context.workspaceId));
    const missing = ports.unavailable(tool.id, { organizationId: context.organizationId, workspaceId: context.workspaceId });
    if (missing) throw new BrainDomainError("FORBIDDEN", missing);
  } catch (error) {
    if (error instanceof BrainDomainError && (error.code === "FORBIDDEN" || error.code === "INVALID_ARGUMENT")) return refuse(error.code, error.message);
    throw error;
  }
  const summary = policy.summary(input);
  const allow = effectAllowList(s, context.workspaceId);
  const expiresAtMs = s.now() + allow.approvalMinutes * 60_000;
  const resource = policy.resource(input) ?? "";
  const approvalId = s.id("apr");
  const actJobId = s.id("job");
  const subject: ActionSubject = withRisk(s, {
    organizationId: context.organizationId, workspaceId: context.workspaceId, operation: `effect.${tool.id}`.slice(0, 64),
    tool, inputDigest: effectInputDigest(input), target: context.target,
    artifactDigest: tool.digest, policyDigest: domainDigest("brain:effect-policy:v1", { containers: allow.containers, services: allow.services } as unknown as JsonValue),
    configDigest: context.configDigest,
    // The approval names the held act job that will make this call (ADR 0028), the proposing attempt for the record, and the proposal.
    effectBounds: { summary, arguments: input as unknown as JsonValue, attemptId, actJobId, proposalId, once: true },
    expiresAt: iso(expiresAtMs), nonce: proposalId.slice(0, 120),
    // Where the call was asked, bound with the rest (ADR 0049): the run of the proposing task and the work item and mission it serves.
    origin: originOfRun(s.workspaceDb(context.workspaceId, context.organizationId), String((s.control.prepare("SELECT workflow_run_id FROM jobs WHERE id=?").get(parentJobId) as { workflow_run_id: string }).workflow_run_id)),
  }, { organizationId: context.organizationId, workspaceId: context.workspaceId });
  s.inTx(s.control, () => {
    // The requester is the platform, never the person who started the mission. Whether the owner may decide their own mission's call is the
    // release policy's separationOfDuties (ADR 0067): where a layer requires it, the owner and the person who started the run may not.
    s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
      VALUES (?,?,?,?,?,?,'pending',?,?)`).run(approvalId, context.organizationId, context.workspaceId, "system:effect-call", approvalDigest(subject), JSON.stringify(subject), expiresAtMs, s.now());
    // The held act job: blocked (no runner can claim it) until the approval is decided, with the parent's placement, so it runs in the group
    // that may touch the host. It carries the call itself; the permit it will take is bound to this job and no other.
    const act: ActPayload = { proposalId, approvalId, parentJobId, parentAttemptId: attemptId, agent: context.agent };
    createActJob(s, { id: actJobId, organizationId: context.organizationId, workspaceId: context.workspaceId, approvalId, parentJobId, configDigest: context.configDigest, effectClass: context.effectClass, approvalExpiresAtMs: expiresAtMs,
      payload: { kind: "act", input: input as unknown as JsonValue, act: act as unknown as JsonValue, step: { uses: { type: "tool", release: tool }, effectClass: "read", target: context.target } as unknown as JsonValue } });
    s.control.prepare("INSERT INTO effect_calls(attempt_id, proposal_id, organization_id, workspace_id, approval_id, tool_id, input_digest, resource_key, created_at_ms, parent_job_id, act_job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(attemptId, proposalId, context.organizationId, context.workspaceId, approvalId, tool.id, subject.inputDigest, resource, s.now(), parentJobId, actJobId);
    s.emit(s.control, { organizationId: context.organizationId, workspaceId: context.workspaceId, aggregateType: "approval", aggregateId: approvalId, eventType: "approval.requested", payload: { approvalId, subjectDigest: approvalDigest(subject), effect: tool.id } });
  });
  ports.notifyApprovers({ organizationId: context.organizationId, workspaceId: context.workspaceId });
  return { approvalId, state: "pending", expiresAt: subject.expiresAt, summary, held: true } as unknown as JsonValue;
}

function approvalDigest(subject: ActionSubject): string { return approvalSubjectDigest(subject as unknown as JsonValue); }

/** Where a proposed call stands: what the approval says, and what became of the change once it was settled. */
function describeCall(s: Store, call: CallRow): JsonValue {
  const state = call.settled_at_ms === null ? expireIfDue(s, call.approval_id) : (s.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(call.approval_id) as { state: string }).state;
  const approval = s.control.prepare("SELECT expires_at_ms, subject_json FROM approval_requests WHERE id=?").get(call.approval_id) as { expires_at_ms: number; subject_json: string };
  const summary = (JSON.parse(approval.subject_json) as ActionSubject).effectBounds["summary"];
  const result = call.outcome === "applied" ? effectResultFor(s, call.approval_id) : undefined;
  return { approvalId: call.approval_id, state, ...(call.outcome ? { outcome: call.outcome } : {}), ...(result ? { result } : {}), expiresAt: iso(approval.expires_at_ms), summary: typeof summary === "string" ? summary : "", held: call.settled_at_ms === null } as unknown as JsonValue;
}

/** The call an act attempt makes: found by the act job it belongs to (the only attempt that may take a permit), else by the proposing attempt. */
function callOf(s: Store, context: AttemptContext, attemptId: string, proposalId: string): CallRow | undefined {
  return context.isAct
    ? s.control.prepare("SELECT * FROM effect_calls WHERE act_job_id=? AND proposal_id=?").get(String(context.row["job_id"]), proposalId) as CallRow | undefined
    : s.control.prepare("SELECT * FROM effect_calls WHERE attempt_id=? AND proposal_id=?").get(attemptId, proposalId) as CallRow | undefined;
}

/**
 * What binds a permit to its call: the approval's own subject must name this tool, these arguments, this held act job and this proposal.
 * Only the act job's own attempt is bound; the attempt that proposed the call can never take its permit.
 */
function boundApproval(s: Store, context: AttemptContext, attemptId: string, proposalId: string, tool: { id: string; digest: string }, input: Input): { approvalId: string; subjectDigest: string; resource: string } {
  const call = callOf(s, context, attemptId, proposalId);
  if (!call) throw new BrainDomainError("APPROVAL_REQUIRED", "this call was never proposed for approval");
  if (!context.isAct || call.act_job_id !== String(context.row["job_id"])) throw new BrainDomainError("FORBIDDEN", "only the held job of an approved proposal may make the change");
  const approval = s.control.prepare("SELECT subject_json, subject_digest FROM approval_requests WHERE id=? AND organization_id=?").get(call.approval_id, context.organizationId) as { subject_json: string; subject_digest: string } | undefined;
  if (!approval) throw new BrainDomainError("NOT_FOUND", "approval not found");
  const subject = JSON.parse(approval.subject_json) as ActionSubject;
  const bounds = subject.effectBounds;
  if (approvalDigest(subject) !== approval.subject_digest) throw new BrainDomainError("CONFLICT", "approval subject was altered");
  if (subject.tool.id !== tool.id || subject.tool.digest !== tool.digest || call.tool_id !== tool.id) throw new BrainDomainError("CONFLICT", "the approval names a different tool");
  if (subject.inputDigest !== effectInputDigest(input) || call.input_digest !== subject.inputDigest) throw new BrainDomainError("CONFLICT", "the arguments differ from the ones the owner approved; nothing was run");
  if (subject.workspaceId !== context.workspaceId || subject.organizationId !== context.organizationId || bounds["actJobId"] !== String(context.row["job_id"]) || bounds["proposalId"] !== proposalId || subject.configDigest !== context.configDigest) throw new BrainDomainError("CONFLICT", "the approval belongs to a different call");
  return { approvalId: call.approval_id, subjectDigest: approval.subject_digest, resource: call.resource_key };
}

/** Issues the one permit of an approved call. Fails while the approval is pending, refused, expired, revoked or already used. */
export function issueEffectPermit(s: Store, deps: { auth: BrainAuth }, runner: Runner, attemptId: string, body: EffectRequestBody): JsonValue {
  const { proposalId, tool, input } = parseBody(body);
  const context = attemptContext(s, runner, attemptId, tool);
  const bound = boundApproval(s, context, attemptId, proposalId, tool, input);
  const state = expireIfDue(s, bound.approvalId);
  if (state !== "approved") throw new BrainDomainError(state === "pending" ? "APPROVAL_REQUIRED" : state === "expired" ? "APPROVAL_EXPIRED" : "FORBIDDEN", `the approval is ${state}`);
  return issuePermit(s, deps, runner, attemptId, {
    invocationId: `inv-${bound.approvalId}`, subjectDigest: bound.subjectDigest, approvalId: bound.approvalId, resourceKeys: bound.resource ? [bound.resource] : [],
  });
}

/** Consumes the permit just before the effect runs: exactly one start per permit, and the arguments are checked once more. */
export function startEffect(s: Store, deps: { auth: BrainAuth }, runner: Runner, attemptId: string, body: EffectRequestBody & { token?: unknown }): JsonValue {
  const { proposalId, tool, input } = parseBody(body);
  const context = attemptContext(s, runner, attemptId, tool);
  const bound = boundApproval(s, context, attemptId, proposalId, tool, input);
  const invocationId = `inv-${bound.approvalId}`;
  if (!validatePermit(s, deps, String(body.token ?? ""), invocationId)) throw new BrainDomainError("APPROVAL_REQUIRED", "the permit is not current");
  const started = s.control.prepare("UPDATE effect_permits SET state='started' WHERE invocation_id=? AND attempt_id=? AND state='issued'").run(invocationId, attemptId);
  if (started.changes !== 1) throw new BrainDomainError("CONFLICT", "this permit was already used; a call runs once");
  s.emit(s.control, { organizationId: context.organizationId, workspaceId: context.workspaceId, aggregateType: "approval", aggregateId: bound.approvalId, eventType: "effect.started", payload: { approvalId: bound.approvalId, toolId: tool.id, attemptId } });
  return { invocationId, state: "started" } as unknown as JsonValue;
}

/**
 * For effects the Governor itself performs (ticket, message, pull request: the credentials live here): the call must be started and its
 * permit current, and the run itself happens once. Returns what the connector needs.
 */
export function beginGovernorRun(s: Store, deps: { auth: BrainAuth }, runner: Runner, attemptId: string, body: EffectRequestBody & { token?: unknown }): { organizationId: string; workspaceId: string; toolId: string; input: Input; approvalId: string; invocationId: string; runId: string | undefined } {
  const { proposalId, tool, input } = parseBody(body);
  const context = attemptContext(s, runner, attemptId, tool);
  const bound = boundApproval(s, context, attemptId, proposalId, tool, input);
  const invocationId = `inv-${bound.approvalId}`;
  if (!validatePermit(s, deps, String(body.token ?? ""), invocationId)) throw new BrainDomainError("APPROVAL_REQUIRED", "the permit is not current");
  const claimed = s.control.prepare("UPDATE effect_permits SET receipt_digest='running' WHERE invocation_id=? AND attempt_id=? AND state='started' AND receipt_digest IS NULL").run(invocationId, attemptId);
  if (claimed.changes !== 1) throw new BrainDomainError("CONFLICT", "this call was already performed or has not started");
  // The run of the task that proposed the change: where the work item it serves is found.
  const proposer = callOf(s, context, attemptId, proposalId)?.parent_job_id;
  const run = proposer ? (s.control.prepare("SELECT workflow_run_id FROM jobs WHERE id=?").get(proposer) as { workflow_run_id: string } | undefined)?.workflow_run_id : undefined;
  return { organizationId: context.organizationId, workspaceId: context.workspaceId, toolId: tool.id, input, approvalId: bound.approvalId, invocationId, runId: run };
}

export type EffectOutcome = "applied" | "absent" | "unknown";

/** Records how the call ended: the permit's final state and the reconciled receipt the evidence bundle will carry. */
export function finishEffect(s: Store, runner: Runner, attemptId: string, body: { proposalId?: unknown; outcome?: unknown; receiptDigest?: unknown }): JsonValue {
  const row = loadAttempt(s, attemptId);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  assertAttemptLive(s, runner, row);
  const proposalId = String(body.proposalId ?? "");
  const outcome = body.outcome as EffectOutcome;
  const receiptDigest = String(body.receiptDigest ?? "");
  if (!["applied", "absent", "unknown"].includes(outcome) || !/^sha256:[0-9a-f]{64}$/u.test(receiptDigest)) throw new BrainDomainError("INVALID_ARGUMENT", "outcome and receiptDigest are required");
  // Only the held act job's own attempt finishes a call.
  const call = s.control.prepare("SELECT approval_id, tool_id, workspace_id, organization_id FROM effect_calls WHERE act_job_id=? AND proposal_id=?").get(String(row["job_id"]), proposalId) as { approval_id: string; tool_id: string; workspace_id: string; organization_id: string } | undefined;
  if (!call) throw new BrainDomainError("NOT_FOUND", "no such effect call");
  const invocationId = `inv-${call.approval_id}`;
  const updated = s.control.prepare("UPDATE effect_permits SET state=?, receipt_digest=? WHERE invocation_id=? AND attempt_id=? AND state='started'").run(outcome, receiptDigest, invocationId, attemptId);
  if (updated.changes !== 1) throw new BrainDomainError("CONFLICT", "the call is not running");
  // A reconciled receipt (applied or certainly absent) ends the guard on the target; an unknown outcome keeps it until a person reconciles.
  if (outcome !== "unknown") s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE invocation_id=?").run(s.now(), invocationId);
  const ws = s.workspaceDb(call.workspace_id, call.organization_id);
  ws.prepare("INSERT OR IGNORE INTO domain_operation_receipts(invocation_id, connector_id, target_key, operation, outcome, receipt_digest, observed_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(invocationId, "effect-tools", `tool:${call.tool_id}`, `effect.${call.tool_id}`.slice(0, 64), outcome, receiptDigest, s.now());
  s.emit(s.control, { organizationId: call.organization_id, workspaceId: call.workspace_id, aggregateType: "approval", aggregateId: call.approval_id, eventType: "effect.finished", payload: { approvalId: call.approval_id, toolId: call.tool_id, outcome, attemptId } });
  return { invocationId, outcome } as unknown as JsonValue;
}
