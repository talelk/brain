import type { ActorContext, CommandReceipt, JsonValue, WorkflowCatalogEntry } from "@brain/contracts";
import { payloadValidator } from "@brain/contracts/validate";
import { BrainDomainError } from "../domain/errors";
import type { MissionService } from "../modules/missions/index";
import { workItemSituation } from "../modules/workflows/index";
import type { Store } from "./store";

/** Command types after which ready work may have appeared or a blocker may have cleared. */
export const AUTO_START_TRIGGERS: ReadonlySet<string> = new Set([
  "plan.confirm", "plan.propose", "workItem.transition", "mission.policy.set", "mission.resume", "mission.budget.set", "mission.create",
]);

interface Ports {
  readonly store: Store;
  readonly missions: MissionService;
  /** The command funnel's run: the same dispatch path a person's Start uses. */
  dispatch(actor: ActorContext, command: unknown): Promise<{ receipt: CommandReceipt }>;
  catalog(organizationId: string): readonly WorkflowCatalogEntry[];
}

/**
 * Starts ready work for missions whose auto-start switch is on (ADR 0004: the
 * Governor reacts to events and dispatches a fresh bounded run per work item;
 * nothing is held while it waits). It reuses `workflow.dispatch` with the work
 * item, so budgets, member caps, evidence and run identity are unchanged.
 *
 * Inputs are never invented: a task starts only when it names a workflow and the
 * input the manual Start form would pre-fill from the card (its title and
 * criteria) satisfies that workflow's input schema. Anything else stays `ready`
 * with a visible "Needs input before it can start" next action. The member cap
 * bounds in-progress work and a spent budget holds new starts; both leave a
 * visible note and resolve on the next event or maintenance pass.
 *
 * The sweep is idempotent: each start has a command id derived from the work
 * item and its failed attempts, so a replay never starts a second run.
 */
export class AutoStart {
  private sweeping: Promise<void> | undefined;
  private again = false;

  constructor(private readonly ports: Ports) {}

  /** Runs a sweep for one workspace; concurrent calls coalesce into one follow-up pass. */
  sweep(organizationId: string, workspaceId: string): Promise<void> {
    if (this.sweeping) { this.again = true; return this.sweeping; }
    this.sweeping = (async () => {
      try {
        do {
          this.again = false;
          await this.pass(organizationId, workspaceId);
        } while (this.again);
      } finally { this.sweeping = undefined; }
    })();
    return this.sweeping;
  }

  /** Sweeps every active workspace (maintenance pass); one workspace never blocks another. */
  async sweepAll(): Promise<void> {
    const workspaces = this.ports.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE status='active'").all() as Array<{ id: string; organization_id: string }>;
    for (const ws of workspaces) {
      try { await this.sweep(ws.organization_id, ws.id); } catch { /* the next pass retries */ }
    }
  }

  private async pass(organizationId: string, workspaceId: string): Promise<void> {
    this.ports.missions.reconcileFinished(organizationId, workspaceId);
    await this.startReady(organizationId, workspaceId);
    this.ports.missions.completeFinishedMissions(organizationId, workspaceId);
  }

  private async startReady(organizationId: string, workspaceId: string): Promise<void> {
    const { missions } = this.ports;
    const plan = missions.autoStartPlan(organizationId, workspaceId);
    if (plan.length === 0) return;
    const catalog = this.ports.catalog(organizationId);
    for (const mission of plan) {
      const actor: ActorContext = { kind: "workflow", actorId: mission.ownerId, organizationId, workspaceId, scopes: ["workflow:dispatch"], authMethod: "service-credential", authGeneration: 1 };
      let slots = mission.slots;
      for (const item of mission.items) {
        const note = (text: string) => missions.noteStartBlocker(organizationId, workspaceId, item.workItemId, text);
        // The task's own workflow first; when it is missing or cannot take the task's situation, the mission's own (most used)
        // workflow runs it, so nobody has to pick one.
        const input = { situation: workItemSituation(item.title, item.criteria) } as JsonValue;
        // A mission written in plain words has no workflow anywhere, so the catalog's first workflow that accepts the situation is the last resort.
        const catalogIds = catalog.map((candidate) => candidate.release.id).sort();
        const candidates = [...new Set([item.workflowId, mission.defaultWorkflowId, ...catalogIds].filter((id): id is string => id !== null))];
        if (candidates.length === 0) { note("Needs input before it can start: no workflow is available in this workspace"); continue; }
        let entry: WorkflowCatalogEntry | undefined;
        let problem = "";
        for (const workflowId of candidates) {
          const found = catalog.find((candidate) => candidate.release.id === workflowId);
          if (!found) { problem ||= `workflow ${workflowId} is not in the active release`; continue; }
          // Without a declared input schema nothing can vouch for the input, so a person supplies it.
          if (!found.inputSchema) { problem ||= "the workflow declares no input schema"; continue; }
          const valid = payloadValidator(found.inputSchema as object)(input);
          if (!valid.ok) { problem ||= valid.errors.join("; "); continue; }
          entry = found; break;
        }
        if (!entry) { note(`Needs input before it can start: ${problem}`); continue; }
        if (!mission.headroom) { note("Waiting for budget: raise the mission budget to continue"); continue; }
        if (slots <= 0) { note(`Waiting for a free member: ${mission.memberCap} tasks are already in progress`); continue; }
        // One id per attempt and per run, so sending a task back dispatches a fresh run instead of replaying the first.
        const commandId = `autostart-${item.workItemId}-${item.failedAttempts}-${item.runs}`;
        try {
          const { receipt } = await this.ports.dispatch(actor, {
            contractVersion: "brain.command/v1", commandId, idempotencyKey: commandId, commandType: "workflow.dispatch", workspaceId,
            payload: { workflow: entry.release, input, workItemId: item.workItemId },
          });
          if (receipt.accepted) slots--;
        } catch (error) {
          if (!(error instanceof BrainDomainError)) throw error;
          note(`Could not start automatically: ${error.message}`);
        }
      }
    }
  }
}
