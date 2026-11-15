import type {
  ArtifactRef, AttemptIdentity, Checkpoint, ConfigRelease, Digest, EngineEvent,
  EngineInfo, EngineSessionSpec, EvidenceBundle, ExecutionGrant, JobOffer,
  JobReceipt, MemoryQuery, MemoryResult, Placement, PlacementExplanation,
  JsonValue, LauncherCreate, LauncherInspection, ReleaseRef, ToolInvocation,
  ToolReceipt, VerificationVerdict, WorkflowIR, RunState, Target,
} from './brain.generated';

// Internal ports. Implementations normalize vendor types at their own boundary.
export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
}
export interface WorkflowEnginePort {
  register(ir: WorkflowIR): Promise<{ engineWorkflowId: string }>;
  start(input: { runId: string; engineWorkflowId: string; input: JsonValue; executionKey: string }): Promise<void>;
  resume(input: { runId: string; waitGeneration: number; wakeEventId: string }): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
  inspect(runId: string): Promise<{ state: RunState; waits: readonly WorkflowWait[]; snapshotDigest?: Digest }>;
  dispose(): Promise<void>;
}
export interface WorkflowWait {
  stepId: string;
  waitGeneration: number;
  reason: 'dependencies' | 'job' | 'evidence' | 'approval' | 'child' | 'control';
}
export interface WorkflowPrimitivePort {
  definitionId(runId: string): string;
  dependencies(runId: string, stepIds: readonly string[], mode: 'accepted' | 'submitted'): Promise<{ ready: boolean; failed: boolean; digest: Digest }>;
  invoke(runId: string, stepId: string): Promise<{ status: 'completed'; output: JsonValue } | { status: 'waiting'; reason: WorkflowWait['reason']; digest: Digest }>;
  wait(runId: string, stepId: string, reason: WorkflowWait['reason'], digest: Digest): Promise<WorkflowWait>;
}
export interface EngineToolBinding {
  release: ReleaseRef;
  inputSchema: Readonly<Record<string, JsonValue>>;
  effectClass: 'read' | 'write' | 'privileged';
  target: Target;
  /** Hosts a network-reading tool may reach, from the pinned Tool document; the runner broker refuses everything else. */
  allowedHosts?: readonly string[];
}
export interface EngineToolExecutionResult {
  proposalId: string;
  invocationId: string;
  receipt: ToolReceipt;
  output: JsonValue;
}
export interface EngineAdapter {
  readonly id: string;
  readonly defaultModelId?: string;
  probe(): Promise<EngineInfo>;
  start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }>;
  events(sessionId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<EngineEvent>;
  toolResult?(sessionId: string, result: EngineToolExecutionResult): Promise<void>;
  cancel(sessionId: string, reason: string): Promise<{ terminationConfirmed: boolean }>;
  checkpoint(sessionId: string): Promise<Checkpoint>;
  steer?(sessionId: string, messageId: string, message: string): Promise<void>;
  /**
   * Holds the session at its next turn boundary (before the next model request) and resolves once it is held; nothing is sent to the model
   * until `continue`. The session, its tools and its conversation stay alive. Rejects when the session ends before a boundary. Offered only
   * by engines that advertise the "pause" feature.
   */
  pause?(sessionId: string): Promise<void>;
  /** Releases a held session (or cancels a pause not yet reached); a no-op for a session that is not held. */
  continue?(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
}
export interface SchedulerPort {
  explain(jobId: string): Promise<PlacementExplanation>;
  claim(runnerId: string, epoch: number, requestId: string): Promise<JobOffer | null>;
}
export interface SandboxPort {
  probe(placement: Placement): Promise<{ supported: boolean; reasons: readonly string[] }>;
  create(input: LauncherCreate): Promise<{ sandboxId: string }>;
  stop(sandboxId: string, graceMs: number): Promise<{ terminationConfirmed: boolean; cleanupConfirmed: boolean }>;
}
export interface LauncherPort {
  create(input: LauncherCreate, signal: AbortSignal): Promise<LauncherInspection>;
  inspect(sandboxId: string, signal: AbortSignal): Promise<LauncherInspection>;
  stop(sandboxId: string, graceMs: number, signal: AbortSignal): Promise<LauncherInspection>;
}
export interface ToolBrokerPort {
  execute(invocation: ToolInvocation, permit: ExecutionGrant, signal: AbortSignal): Promise<ToolReceipt>;
}
export interface MemoryGatewayPort {
  search(query: MemoryQuery, signal: AbortSignal): Promise<{ results: readonly MemoryResult[]; degraded: boolean; reason?: string }>;
  revoke(sourceId: string, aclGeneration: number): Promise<void>;
  exportScope(input: { organizationId: string; workspaceId: string }): Promise<{ completeness: 'complete' | 'partial'; artifacts: readonly ArtifactRef[]; missing: readonly string[] }>;
}
export interface EvidencePort {
  submit(bundle: EvidenceBundle): Promise<{ digest: Digest }>;
  evaluate(bundleDigest: Digest, evaluator: ReleaseRef): Promise<VerificationVerdict>;
  accept(verdict: VerificationVerdict): Promise<void>;
}
export interface ArtifactStorePort {
  put(expected: ArtifactRef, bytes: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<ArtifactRef>;
  read(artifact: ArtifactRef, signal: AbortSignal): AsyncIterable<Uint8Array>;
}
export interface ConnectorPort {
  probe(targetId: string): Promise<{ reachable: boolean; observedAt: string }>;
  // Dynamic feature payloads must pass the pinned operation's input/output schema.
  read(operation: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue>;
  list(input: { operation: string; input: JsonValue; cursor?: string; limit: number }, signal: AbortSignal): Promise<{ items: readonly JsonValue[]; nextCursor?: string }>;
  mutate(invocation: ToolInvocation, permit: ExecutionGrant, signal: AbortSignal): Promise<ToolReceipt>;
  reconcile(invocationId: string, receipt?: JobReceipt): Promise<{ outcome: 'applied' | 'absent' | 'conflicting' | 'unknown'; evidence: readonly ArtifactRef[] }>;
}
