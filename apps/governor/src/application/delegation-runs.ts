import { scopeMethods, systemActor } from "./actor-context";
import type { JsonValue, Workflow, WorkflowCatalogEntry } from "@brain/contracts";
import { payloadValidator } from "@brain/contracts/validate";
import { BrainDomainError } from "../domain/errors";
import { dispatchActor } from "../modules/identity/index";
import { isDraining } from "../modules/jobs/index";
import type { MissionService } from "../modules/missions/index";
import { wayOfWorking } from "../modules/missions/index";
import { delegatedRunEnded, delegationFailed, delegationStarted, pendingDelegations } from "../modules/sessions/index";
import { GENERAL_TASK_WORKFLOW, workItemSituation } from "../modules/workflows/index";
import type { Store } from "./store";

interface Ports {
  readonly store: Store;
  readonly missions: MissionService;
  catalog(organizationId: string): readonly WorkflowCatalogEntry[];
  loadWorkflow(organizationId: string, workflowId: string): { workflow: Workflow; configDigest: string };
  startRun(input: { organizationId: string; workspaceId: string; actorId: string; workflowId: string; workflow: Workflow; configDigest: string; runInput: JsonValue; executionKey: string; priority: number }): { runId: string };
}

/**
 * Starts the run of every delegated child that has none (ADR 0053). A delegation commits a child session and a pending run; this starts
 * the run through the workflow engine, so the child's job is created, admitted against the mission's member cap and budget, placed and
 * claimed like any task's. It runs after the delegating command commits, and on every maintenance pass: a crash between the two leaves
 * a pending row and the next pass starts it (the run's execution key is the delegation, so it can never start twice). The parent never
 * waits for it.
 */
export class DelegationRuns {
  constructor(private readonly ports: Ports) {
    scopeMethods(this, { sweep: systemActor("delegation"), sweepAll: systemActor("delegation") });
  }

  /** Starts what is pending in one workspace and settles delegations whose run ended without being heard (a restart, a cancelled run). */
  sweep(organizationId: string, workspaceId: string): number {
    const { store } = this.ports;
    const db = store.workspaceDb(workspaceId, organizationId);
    this.settleEnded(organizationId, workspaceId);
    if (isDraining(store)) return 0;
    let started = 0;
    for (const pending of pendingDelegations(db)) {
      const reason = this.refusal(db, pending.missionId, pending.parentSessionId);
      if (reason) { delegationFailed(store, organizationId, workspaceId, pending.delegationId, reason); continue; }
      const mission = db.prepare("SELECT owner_id FROM missions WHERE id=?").get(pending.missionId) as { owner_id: string };
      const actor = dispatchActor(store, { organizationId, workspaceId, missionId: pending.missionId, memberId: pending.memberId, actingFor: mission.owner_id });
      try {
        const way = this.workflowFor(organizationId, workspaceId, pending.situation);
        const { runId } = this.ports.startRun({
          organizationId, workspaceId, actorId: actor.actorId, workflowId: way.workflowId, workflow: way.workflow, configDigest: way.configDigest, runInput: way.input,
          executionKey: `delegation-${pending.delegationId}`, priority: this.ports.missions.jobPriorityOf(actor, workspaceId, pending.workItemId),
        });
        delegationStarted(store, db, { delegationId: pending.delegationId, runId });
        started++;
      } catch (error) {
        // A Governor fault is retried by the next pass; a refusal (no way of working fits, the workspace is suspended) is the child's failure, told to the parent.
        if (!(error instanceof BrainDomainError)) throw error;
        delegationFailed(store, organizationId, workspaceId, pending.delegationId, `The delegated work could not start: ${error.message}`);
      }
    }
    return started;
  }

  /** Every active workspace; one workspace never blocks another. */
  sweepAll(): number {
    let started = 0;
    for (const ws of this.ports.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE status='active'").all() as Array<{ id: string; organization_id: string }>) {
      try { started += this.sweep(ws.organization_id, ws.id); } catch { /* the next pass retries */ }
    }
    return started;
  }

  /** Why a pending child must not start, in plain words, or undefined when it may. */
  private refusal(db: ReturnType<Store["workspaceDb"]>, missionId: string, parentSessionId: string): string | undefined {
    const mission = db.prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string } | undefined;
    if (!mission || mission.state === "closed") return "The mission was closed before the delegated work started.";
    const parent = db.prepare("SELECT state FROM sessions WHERE id=?").get(parentSessionId) as { state: string } | undefined;
    return parent?.state === "failed" ? "The parent session failed before the delegated work started." : undefined;
  }

  /**
   * The way of working a sub-task runs on, chosen as a task's own is when it names none (auto-start): the workspace's way of working, then
   * the general task workflow. It must take the sub-task as plain words (a `situation`); one that cannot is skipped.
   */
  private workflowFor(organizationId: string, workspaceId: string, task: string): { workflowId: string; workflow: Workflow; configDigest: string; input: JsonValue } {
    const input = { situation: workItemSituation(task, []) } as JsonValue;
    const catalog = this.ports.catalog(organizationId);
    const candidates = [...new Set([wayOfWorking(this.ports.store, workspaceId)?.workflowId, GENERAL_TASK_WORKFLOW].filter((id): id is string => id !== undefined))];
    let problem = "no way of working is available in this workspace";
    for (const workflowId of candidates) {
      const entry = catalog.find((candidate) => candidate.release.id === workflowId);
      if (!entry) { problem = `workflow ${workflowId} is not in the active release`; continue; }
      if (!entry.inputSchema) { problem = `workflow ${workflowId} declares no input schema`; continue; }
      const checked = payloadValidator(entry.inputSchema as object)(input);
      if (!checked.ok) { problem = checked.errors.join("; "); continue; }
      return { workflowId, ...this.ports.loadWorkflow(organizationId, workflowId), input };
    }
    throw new BrainDomainError("NOT_FOUND", `no way of working can take a sub-task in plain words: ${problem}`);
  }

  /** A child whose run ended while nobody was listening (the Governor restarted, the run was cancelled) is settled from the run's own state. */
  private settleEnded(organizationId: string, workspaceId: string): void {
    const db = this.ports.store.workspaceDb(workspaceId, organizationId);
    for (const row of db.prepare("SELECT r.run_id AS runId, w.state AS state FROM delegation_runs r JOIN workflow_runs w ON w.id=r.run_id WHERE r.state='running' AND w.state IN ('succeeded','failed','cancelled','partial')").all() as Array<{ runId: string; state: string }>) {
      delegatedRunEnded(this.ports.store, organizationId, workspaceId, row.runId, row.state === "succeeded" ? { ok: true } : { ok: false, diagnostic: `The run ${row.state === "cancelled" ? "was cancelled" : "did not succeed"}` });
    }
  }
}
