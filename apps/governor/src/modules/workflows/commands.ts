import type { ActorContext, JsonValue, Workflow } from "@brain/contracts";
import type { CommandHandlers } from "../../application/command-funnel";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import type { WorkflowEnginePort } from "./engine-port";

export interface WorkflowCommandPorts {
  readonly engine: WorkflowEnginePort;
  loadWorkflow(organizationId: string, workflowId: string): { workflow: Workflow; configDigest: string };
  /** Resolves the work item a managed session dispatches for. */
  sessionWorkItem(actor: ActorContext, workspaceId: string, sessionId: string): string;
  linkExecution(actor: ActorContext, workspaceId: string, workItemId: string, runId: string, options?: { candidate?: { id: string; round: number } }): void;
  /** The candidates to start for this work item (ADR 0064), after admission counted every one of them; undefined for an ordinary task. */
  fanOut(actor: ActorContext, workspaceId: string, workItemId: string, replayedRunId?: string): { round: number; candidates: ReadonlyArray<{ id: string; workflowId?: string }> } | undefined;
  /** The job priority a run for this work item starts with (missions module): the first job exists before the run is linked. */
  workItemJobPriority(actor: ActorContext, workspaceId: string, workItemId: string): number;
  attachSessionRun(actor: ActorContext, workspaceId: string, sessionId: string, runId: string): void;
  /** Cancels the run's jobs that no runner holds yet (jobs module). */
  cancelJobs(runId: string): void;
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
        const priority = workItemId ? ports.workItemJobPriority(actor, workspaceId, workItemId) : undefined;
        // A task with candidates starts one run per candidate, together or not at all (ADR 0064); any other dispatch starts one run.
        const fan = workItemId && !sessionId ? ports.fanOut(actor, workspaceId, workItemId, prior?.id) : undefined;
        const starts = fan
          ? fan.candidates.map((candidate, index) => ({ workflowId: candidate.workflowId ?? workflowId, key: index === 0 ? cmd.commandId : `${cmd.commandId}~${candidate.id}`, candidate: { id: candidate.id, round: fan.round } }))
          : [{ workflowId, key: cmd.commandId, candidate: undefined }];
        const loaded = starts.map((start) => ({ start, ...ports.loadWorkflow(actor.organizationId, start.workflowId) }));
        const started: string[] = [];
        let runId = "";
        try {
          for (const { start, workflow, configDigest } of loaded) {
            // startRun validates the input against the workflow's declared schema.
            const run = ports.engine.startRun({
              organizationId: actor.organizationId, workspaceId, actorId: actor.actorId,
              workflowId: start.workflowId, workflow, configDigest,
              runInput: (p["input"] ?? null) as JsonValue, executionKey: start.key, ...(priority !== undefined ? { priority } : {}),
            });
            started.push(run.runId);
            if (workItemId) ports.linkExecution(actor, workspaceId, workItemId, run.runId, start.candidate ? { candidate: start.candidate } : {});
            runId ||= run.runId;
          }
        } catch (cause) {
          // Candidates start together or not at all: one that cannot start (its way of working refuses the input) withdraws the others.
          if (fan) for (const id of started) { ports.engine.cancelRun(actor.organizationId, workspaceId, id); ports.cancelJobs(id); }
          throw cause;
        }
        if (sessionId) ports.attachSessionRun(actor, workspaceId, sessionId, runId);
        // The receipt names the created aggregate: the run. The /runs/:id
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
        ports.cancelJobs(runId);
        return { resourceId: runId };
      },
    },
  };
}
