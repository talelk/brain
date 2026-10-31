import type { JsonValue, Workflow } from "@brain/contracts";

// The workflow engine port: Brain owns authorization, jobs, approvals,
// permits and evidence; an engine owns only run/step progression against the
// durable workflow_runs/workflow_steps/step_outputs tables. Two adapters
// implement it: the in-process Brain DAG runner and the Mastra engine.
export interface WorkflowEnginePort {
  readonly engineId: string;
  startRun(input: {
    organizationId: string; workspaceId: string; actorId: string;
    workflowId: string; workflow: Workflow; configDigest: string; runInput: JsonValue; executionKey: string; runnerId?: string;
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
  }): string;
  createApprovalForGate(input: {
    organizationId: string; workspaceId: string; runId: string; stepId: string;
    subject: JsonValue; expiresAtMs: number; requestedBy: string;
  }): string;
  loadWorkflow(organizationId: string, workflowId: string): { workflow: Workflow; configDigest: string };
  recordSteer(input: {
    organizationId: string; workspaceId: string; runId: string; stepId: string; payload: JsonValue;
  }): void;
}
