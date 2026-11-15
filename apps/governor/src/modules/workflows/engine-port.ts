import type { ArtifactRef, JsonValue, Workflow } from "@brain/contracts";

/**
 * A run started by resuming a session: the one step that continues the engine state a checkpoint saved. Only that step's job is pinned
 * to the runner holding the state and carries it; every other step of the run is placed as usual (an independent evaluator must not
 * be forced onto the author's runner).
 */
export interface RunResume {
  readonly stepId: string;
  readonly runnerId: string;
  readonly engineId: string;
  readonly engineState: ArtifactRef;
  readonly fromSessionId: string;
}

// The workflow engine port: Brain owns authorization, jobs, approvals,
// permits and evidence; an engine owns only run/step progression against the
// durable workflow_runs/workflow_steps/step_outputs tables. The Mastra engine
// is its one adapter; what admitting each step kind does lives in
// admission.ts, shared by Brain's synchronous scheduler and the Mastra steps.
export interface WorkflowEnginePort {
  readonly engineId: string;
  startRun(input: {
    organizationId: string; workspaceId: string; actorId: string;
    workflowId: string; workflow: Workflow; configDigest: string; runInput: JsonValue; executionKey: string; runnerId?: string;
    /** Set when the run resumes a session from its checkpoint: pins that step's job to the runner holding the saved state. */
    resume?: RunResume;
    /** The job priority of the work the run serves (0 low .. 3 urgent); a run for no work item is normal. */
    priority?: number;
  }): { runId: string };
  completeStep(organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean): void;
  wakeGate(organizationId: string, workspaceId: string, approvalId: string, approved: boolean): void;
  cancelRun(organizationId: string, workspaceId: string, runId: string): void;
  evidenceSubmitted(organizationId: string, workspaceId: string, runId: string): void;
}

export interface WorkflowHost {
  createJobForStep(input: {
    organizationId: string; workspaceId: string; runId: string; stepId: string;
    executionKey: string; configDigest: string; placementJson: string;
    executionDigest: string; effectClass: string; kind: string;
    payload: JsonValue;
    /** The runner the run was pinned to at dispatch, if any. */
    runnerId?: string | undefined;
    /** The engine state this step continues, set only on the step a resumed run continues. */
    resume?: RunResume | undefined;
    /** The priority of the work the run serves: written into the job so the claim can order by it. */
    priority: number;
  }): string;
  createApprovalForGate(input: {
    organizationId: string; workspaceId: string; runId: string; stepId: string;
    subject: JsonValue; expiresAtMs: number; requestedBy: string;
  }): string;
  loadWorkflow(organizationId: string, workflowId: string): { workflow: Workflow; configDigest: string };
  /** A run failed (a failed step or rejected verdict); work linked to it counts a failed attempt. */
  runFailed(input: { organizationId: string; workspaceId: string; runId: string; diagnostic: string }): void;
  /** A run succeeded; work linked to it moves from in-progress to review. */
  runSucceeded(input: { organizationId: string; workspaceId: string; runId: string }): void;
  /** Queues a steer message for a session in the workspace; NOT_FOUND when the session is absent. */
  steerSession(input: { organizationId: string; workspaceId: string; sessionId: string; message: string }): void;
}
