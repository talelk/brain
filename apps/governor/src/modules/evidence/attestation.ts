import type { ActorContext, EvaluationAssignment, JsonValue, VerificationVerdict, Workflow } from "@brain/contracts";
import type { Store } from "../../application/store";
import { hasWorkspaceMembership } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { transitionState } from "../../domain/states";
import { agentBinding } from "../identity/index";

type Db = ReturnType<Store["workspaceDb"]>;
export type Attesters = NonNullable<Extract<Workflow["spec"]["jobs"][string], { kind: "eval" }>["attesters"]>;

/** The terminal states of a run: nothing waits for a person in a run that ended. */
const ENDED = ["succeeded", "partial", "failed", "cancelled"];

export interface AttestationRow { id: string; run_id: string; step_id: string; assignment_json: string; attesters_json: string; created_at_ms: number }

/**
 * Raises the request for a person to attest an independence-L3 evaluation (ADR 0069): the step waits on the request, the run is
 * suspended like a gate, and Needs you derives the blocking item. One row per eval step and one transaction, so a crash leaves either
 * a pending step the next pass raises again or a complete request, never half of one.
 */
export function requestAttestation(s: Store, ws: Db, input: { runId: string; stepId: string; assignment: EvaluationAssignment; attesters: Attesters | undefined; organizationId: string; workspaceId: string }): string | undefined {
  const id = s.id("attest");
  let raised = false;
  s.inTx(ws, () => {
    if (ws.prepare("UPDATE workflow_steps SET state='waiting', job_id=? WHERE run_id=? AND step_id=? AND state='pending'").run(id, input.runId, input.stepId).changes !== 1) return;
    ws.prepare("INSERT INTO evaluation_attestations(id,run_id,step_id,assignment_json,attesters_json,created_at_ms) VALUES (?,?,?,?,?,?)").run(id, input.runId, input.stepId, JSON.stringify(input.assignment), JSON.stringify(input.attesters ?? {}), s.now());
    const run = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(input.runId) as { state: string };
    if (run.state === "running") transitionState(ws, "run", input.runId, "suspended", { rawSet: ["wait_generation=wait_generation+1"], bumpVersion: true });
    s.emit(ws, { aggregateType: "evaluation", aggregateId: id, eventType: "evaluation.attestationRequested", payload: { resourceId: id, version: 1, state: "open" } });
    raised = true;
  });
  return raised ? id : undefined;
}

export const attestationRow = (ws: Db, id: string): AttestationRow | undefined =>
  ws.prepare("SELECT id,run_id,step_id,assignment_json,attesters_json,created_at_ms FROM evaluation_attestations WHERE id=?").get(id) as AttestationRow | undefined;

/** The people whose work a run is: whoever started it, owns its mission, or started a session or delegation that did it. Machine principals count as the person they act for. */
export function authorsOfRun(s: Store, ws: Db, runId: string): Set<string> {
  const people = new Set<string>();
  const add = (id: string | null | undefined): void => {
    if (!id) return;
    people.add(id);
    const binding = agentBinding(s, id);
    if (binding) people.add(binding.actingFor);
  };
  add((ws.prepare("SELECT actor_id FROM run_inputs WHERE run_id=?").get(runId) as { actor_id: string } | undefined)?.actor_id);
  const missions = new Set<string>();
  const items = new Set<string>();
  for (const link of ws.prepare("SELECT mission_id, work_item_id FROM execution_links WHERE run_id=?").all(runId) as Array<{ mission_id: string; work_item_id: string }>) { missions.add(link.mission_id); items.add(link.work_item_id); }
  for (const delegated of ws.prepare("SELECT r.mission_id, r.delegating_principal, d.work_item_id, d.parent_session_id FROM delegation_runs r JOIN delegations d ON d.id=r.delegation_id WHERE r.run_id=?").all(runId) as Array<{ mission_id: string; delegating_principal: string; work_item_id: string; parent_session_id: string }>) {
    missions.add(delegated.mission_id); items.add(delegated.work_item_id); add(delegated.delegating_principal);
    for (const session of ws.prepare("SELECT created_by FROM sessions WHERE id=? OR root_session_id=(SELECT root_session_id FROM sessions WHERE id=?)").all(delegated.parent_session_id, delegated.parent_session_id) as Array<{ created_by: string }>) add(session.created_by);
  }
  for (const missionId of missions) add((ws.prepare("SELECT owner_id FROM missions WHERE id=?").get(missionId) as { owner_id: string } | undefined)?.owner_id);
  const jobIds = (s.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=?").all(runId) as Array<{ id: string }>).map((row) => row.id);
  const sessions = [
    ...jobIds.flatMap((jobId) => ws.prepare("SELECT created_by FROM sessions WHERE job_id=?").all(jobId) as Array<{ created_by: string }>),
    ...[...items].flatMap((itemId) => ws.prepare("SELECT created_by FROM sessions WHERE work_item_id=?").all(itemId) as Array<{ created_by: string }>),
  ];
  for (const session of sessions) add(session.created_by);
  return people;
}

/** Why this person may not attest, in plain words; undefined when they may. Everything is read now, so a transferred mission or a revoked role counts. */
export function attesterProblem(s: Store, ws: Db, input: { organizationId: string; workspaceId: string; actor: ActorContext; row: AttestationRow }): string | undefined {
  const { actor, row } = input;
  if (actor.kind !== "human") return "Only a person can attest evidence.";
  if (!hasWorkspaceMembership(s, actor.actorId, input.organizationId, input.workspaceId)) return "You are not a member of this workspace.";
  if (authorsOfRun(s, ws, row.run_id).has(actor.actorId)) return "You started or own this work, so you cannot be its independent evaluator.";
  const declared = JSON.parse(row.attesters_json) as { role?: string; people?: string[] };
  const named = declared.people?.includes(actor.actorId) === true;
  const roles = (s.control.prepare("SELECT role FROM workspace_memberships WHERE workspace_id=? AND organization_id=? AND principal_id=? AND revoked_at_ms IS NULL").all(input.workspaceId, input.organizationId, actor.actorId) as Array<{ role: string }>).map((entry) => entry.role);
  if (declared.role || declared.people) {
    if (!named && !(declared.role && roles.includes(declared.role))) return "This step names who may attest it, and you are not among them.";
  } else if (!actor.scopes.includes("mission:write")) return "Attesting needs permission to do mission work in this workspace.";
  return undefined;
}

/** Who Needs you tells about a request: the people the step names that are not authors, or every member who may do mission work when it names none. */
export function attestersFor(s: Store, ws: Db, organizationId: string, workspaceId: string, row: AttestationRow): string[] {
  const declared = JSON.parse(row.attesters_json) as { role?: string; people?: string[] };
  const authors = authorsOfRun(s, ws, row.run_id);
  const members = (s.control.prepare("SELECT DISTINCT principal_id, role FROM workspace_memberships WHERE workspace_id=? AND organization_id=? AND revoked_at_ms IS NULL").all(workspaceId, organizationId) as Array<{ principal_id: string; role: string }>);
  const wants = (m: { principal_id: string; role: string }): boolean => declared.role || declared.people
    ? declared.people?.includes(m.principal_id) === true || m.role === declared.role
    : m.role === "operator" || m.role === "workspace-lead";
  return [...new Set(members.filter((m) => wants(m) && !authors.has(m.principal_id)).map((m) => m.principal_id))];
}

/** The mission and task a run serves, and a title for the request. */
function contextOf(ws: Db, runId: string): { missionId?: string; workItemId?: string; title: string } {
  const link = ws.prepare("SELECT l.mission_id, l.work_item_id, w.title FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.run_id=? ORDER BY l.created_at_ms DESC LIMIT 1").get(runId) as { mission_id: string; work_item_id: string; title: string } | undefined
    ?? ws.prepare("SELECT r.mission_id, d.work_item_id, w.title FROM delegation_runs r JOIN delegations d ON d.id=r.delegation_id JOIN work_items w ON w.id=d.work_item_id WHERE r.run_id=?").get(runId) as { mission_id: string; work_item_id: string; title: string } | undefined;
  if (link) return { missionId: link.mission_id, workItemId: link.work_item_id, title: link.title };
  const workflow = ws.prepare("SELECT workflow_json FROM run_inputs WHERE run_id=?").get(runId) as { workflow_json: string } | undefined;
  return { title: workflow ? (JSON.parse(workflow.workflow_json) as Workflow).metadata.id : "a workflow run" };
}

export interface OpenAttestation { id: string; runId: string; missionId?: string; title: string; createdAtMs: number; attesters: string[] }

/** The requests still waiting for a person: no verdict on their bundles and a run that has not ended. Derived, never stored as a flag. */
export function openAttestations(s: Store, ws: Db, organizationId: string, workspaceId: string): OpenAttestation[] {
  const open: OpenAttestation[] = [];
  for (const row of ws.prepare("SELECT a.id,a.run_id,a.step_id,a.assignment_json,a.attesters_json,a.created_at_ms FROM evaluation_attestations a JOIN workflow_runs r ON r.id=a.run_id WHERE r.state NOT IN ('succeeded','partial','failed','cancelled') ORDER BY a.created_at_ms,a.id").all() as unknown as AttestationRow[]) {
    const first = (JSON.parse(row.assignment_json) as EvaluationAssignment).bundleDigests[0]!;
    if (ws.prepare("SELECT 1 FROM verification_verdicts WHERE bundle_digest=? AND evaluator_attempt_id=?").get(first, row.id)) continue;
    const context = contextOf(ws, row.run_id);
    open.push({ id: row.id, runId: row.run_id, ...(context.missionId ? { missionId: context.missionId } : {}), title: context.title, createdAtMs: row.created_at_ms, attesters: attestersFor(s, ws, organizationId, workspaceId, row) });
  }
  return open;
}

/** attestations.get: the request as the person sees it, with whether they may answer it and why not. */
export function attestationView(s: Store, actor: ActorContext, workspaceId: string, attestationId: string): JsonValue {
  const ws = s.workspaceDb(workspaceId, actor.organizationId);
  const row = attestationRow(ws, attestationId);
  if (!row) throw new BrainDomainError("NOT_FOUND", "attestation request not found");
  const assignment = JSON.parse(row.assignment_json) as EvaluationAssignment;
  const run = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(row.run_id) as { state: string };
  const verdictRow = ws.prepare("SELECT manifest_json, created_at_ms FROM verification_verdicts WHERE bundle_digest=? AND evaluator_attempt_id=?").get(assignment.bundleDigests[0], row.id) as { manifest_json: string; created_at_ms: number } | undefined;
  const verdict = verdictRow ? JSON.parse(verdictRow.manifest_json) as VerificationVerdict : undefined;
  const claimed = new Map<string, { status: string; detail: string }>();
  const bundleRow = ws.prepare("SELECT manifest_json FROM evidence_bundles WHERE digest=?").get(assignment.bundleDigests[0]) as { manifest_json: string } | undefined;
  for (const check of bundleRow ? (JSON.parse(bundleRow.manifest_json) as { checks: Array<{ checkId: string; status: string; detail: string }> }).checks : []) claimed.set(check.checkId, { status: check.status, detail: check.detail });
  const context = contextOf(ws, row.run_id);
  const problem = verdict ? "This evaluation has already been attested." : ENDED.includes(run.state) ? "This run has ended." : attesterProblem(s, ws, { organizationId: actor.organizationId, workspaceId, actor, row });
  return {
    attestationId: row.id, workspaceId, runId: row.run_id, stepId: row.step_id, ...(context.missionId ? { missionId: context.missionId } : {}), ...(context.workItemId ? { workItemId: context.workItemId } : {}),
    title: context.title, state: verdict ? "attested" : ENDED.includes(run.state) ? "closed" : "open", requestedAt: iso(row.created_at_ms), independence: "L3",
    attesters: JSON.parse(row.attesters_json), bundleDigests: assignment.bundleDigests,
    requiredChecks: assignment.requiredChecks.map((checkId) => ({ checkId, criterionId: assignment.criteria[checkId]!, ...(claimed.get(checkId) ? { claimed: claimed.get(checkId) } : {}) })),
    canAttest: problem === undefined, ...(problem ? { cannotAttestReason: problem } : {}),
    ...(verdict && verdictRow ? { verdict: { outcome: verdict.outcome, attestedBy: verdict.acceptedBy, attestedAt: iso(verdictRow.created_at_ms), independence: "L3" } } : {}),
  } as unknown as JsonValue;
}
