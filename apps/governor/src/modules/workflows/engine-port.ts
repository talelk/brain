import type { ArtifactRef, JsonValue, Workflow } from "@brain/contracts";

/**
 * A run started by resuming a session: the one step that continues the engine state a checkpoint saved. Only that step's job carries it
 * (the claiming runner downloads it from the Governor, ADR 0063); every step of the run is placed by its own rules.
 */
export interface RunResume {
  readonly stepId: string;
  readonly engineId: string;
  readonly engineState: ArtifactRef;
  readonly fromSessionId: string;
}

// The workflow engine port: Brain owns authorization, jobs, approvals,
// permits and evidence; an engine owns only run/step progression against the
// durable workflow_runs/workflow_steps/step_outputs tables. The Mastra engine
// is its one adapter; which steps run and what admitting each step kind does
// live in admission.ts, the one scheduler: every step whose needs are met is
// admitted together (ADR 0043).
export interface WorkflowEnginePort {
  readonly engineId: string;
  startRun(input: {
    organizationId: string; workspaceId: string; actorId: string;
    workflowId: string; workflow: Workflow; configDigest: string; runInput: JsonValue; executionKey: string; runnerId?: string;
    /** Set when the run resumes a session from its checkpoint: the continuing step's job carries the saved state. */
    resume?: RunResume;
    /** The job priority of the work the run serves (0 low .. 3 urgent); a run for no work item is normal. */
    priority?: number;
  }): { runId: string };
  completeStep(organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean): void;
  wakeGate(organizationId: string, workspaceId: string, approvalId: string, approved: boolean): void;
  cancelRun(organizationId: string, workspaceId: string, runId: string): void;
  evidenceSubmitted(organizationId: string, workspaceId: string, runId: string): void;
  /** Admits the ready steps of a run a crash left with nothing in flight; idempotent, so a step already admitted is never admitted twice. */
  recoverRun(organizationId: string, workspaceId: string, runId: string): void;
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
  /** A run failed: the jobs of its other branches that no runner holds yet are withdrawn. */
  cancelUnclaimedJobs(runId: string): void;
  loadWorkflow(organizationId: string, workflowId: string): { workflow: Workflow; configDigest: string };
  /** A run failed (a failed step or rejected verdict); work linked to it counts a failed attempt. */
  runFailed(input: { organizationId: string; workspaceId: string; runId: string; diagnostic: string }): void;
  /** A run succeeded; work linked to it moves from in-progress to review. */
  runSucceeded(input: { organizationId: string; workspaceId: string; runId: string }): void;
  /** Queues a steer message for a session in the workspace; NOT_FOUND when the session is absent. */
  steerSession(input: { organizationId: string; workspaceId: string; sessionId: string; message: string }): void;
}
