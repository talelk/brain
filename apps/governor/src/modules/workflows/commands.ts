import type { ActorContext, JsonValue, Workflow } from "@brain/contracts";
import type { CommandHandlers } from "../../application/command-funnel";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { transitionState } from "../../domain/states";
import type { WorkflowEnginePort } from "./engine-port";

export interface WorkflowCommandPorts {
  readonly engine: WorkflowEnginePort;
  loadWorkflow(organizationId: string, workflowId: string): { workflow: Workflow; configDigest: string };
  /** Resolves the work item a managed session dispatches for. */
  sessionWorkItem(actor: ActorContext, workspaceId: string, sessionId: string): string;
  linkExecution(actor: ActorContext, workspaceId: string, workItemId: string, runId: string): void;
  attachSessionRun(actor: ActorContext, workspaceId: string, sessionId: string, runId: string): void;
}

/**
 * Workflow commands. Both are idempotent on the command id ("self" kind):
 * dispatch keys the run by execution_key = commandId, and cancel only moves
 * live rows to cancelled.
 */
export function workflowCommands(store: Store, ports: WorkflowCommandPorts): CommandHandlers {
  const s = store;
  return {
    "workflow.dispatch": {
      kind: "self",
      handle: ({ actor, cmd, workspaceId }) => {
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        s.assertWorkspaceActive(workspaceId, actor.organizationId);
        const p = cmd.payload;
        const workflowId = (p["workflow"] as { id: string }).id;
        const sessionId = p["sessionId"] ? String(p["sessionId"]) : "";
        // Retry of a dispatch that crashed after its session was attached: the
        // run (keyed by the command id) and its session binding already exist.
        const ws = s.workspaceDb(workspaceId, actor.organizationId);
        const prior = ws.prepare("SELECT id FROM workflow_runs WHERE execution_key=?").get(cmd.commandId) as { id: string } | undefined;
        if (prior && sessionId && ws.prepare("SELECT 1 FROM execution_links WHERE run_id=? AND session_id=?").get(prior.id, sessionId)) {
          return { outcome: "queued", resourceId: prior.id };
        }
        const sessionWorkItemId = sessionId ? ports.sessionWorkItem(actor, workspaceId, sessionId) : undefined;
        if (sessionWorkItemId && p["workItemId"] && sessionWorkItemId !== String(p["workItemId"])) throw new BrainDomainError("FORBIDDEN", "session and dispatch work item differ");
        const workItemId = sessionWorkItemId ?? (p["workItemId"] ? String(p["workItemId"]) : "");
        const { workflow, configDigest } = ports.loadWorkflow(actor.organizationId, workflowId);
        // startRun validates the input against the workflow's declared schema.
        const { runId } = ports.engine.startRun({
          organizationId: actor.organizationId, workspaceId, actorId: actor.actorId,
          workflowId, workflow, configDigest,
          runInput: (p["input"] ?? null) as JsonValue, executionKey: cmd.commandId,
        });
        if (workItemId) ports.linkExecution(actor, workspaceId, workItemId, runId);
        if (sessionId) ports.attachSessionRun(actor, workspaceId, sessionId, runId);
        // The receipt names the created aggregate: the run. The /jobs/:id
        // route resolves a run id to the run's current job, so the dispatch
        // deep link opens the work right away and follows it across steps.
        return { outcome: "queued", resourceId: runId };
      },
    },
    "workflow.cancel": {
      kind: "self",
      handle: ({ actor, cmd, workspaceId }) => {
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const runId = String(cmd.payload["runId"]);
        ports.engine.cancelRun(actor.organizationId, workspaceId, runId);
        for (const job of s.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? AND state IN ('queued','offered')").all(runId) as Array<{ id: string }>) {
          transitionState(s.control, "job", job.id, "cancelled", { bumpVersion: true });
        }
        return { resourceId: runId };
      },
    },
  };
}
