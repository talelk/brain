import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { authRunner, enrollRunner, heartbeat, issueEnrollment, operateRunner, runnerChallenge, runnerHello, type HeartbeatCommand } from "./protocol";
import { ackAttempt, attemptEvents, claim, completeAttempt, expireLeases, readExecutionArtifact, releaseAttempt, releaseReservation, renewAttempt, type ContextPackPort } from "./attempts";
import { brokerToolRead, type ToolReadPorts, type ToolReadRequest } from "./tool-reads";
import { BrainDomainError } from "../../domain/errors";
import { sweepStuckJobs } from "./watchdog";
import { runScheduledDispatch } from "./scheduler";
import { AutomationService } from "./automation";
import { cancelJobsForRun, concludeAttempt, createJobForStep, resolveReconciliation, workspaceJobLoad, type CreateJobInput, type ReconciliationOutcome } from "./lifecycle";

/**
 * The runner identity established by {@link JobProtocol.authenticate}; it
 * flows through every protocol and attempt call instead of being threaded
 * alongside a Store by each caller.
 */
export interface RunnerIdentity {
  runnerId: string;
  epoch: number;
  organizationId: string;
}

/**
 * The host capabilities the jobs module cannot reach itself: workflow step
 * completion, evaluator eligibility, runner-settings currency, the active
 * release and workflow start/dispatch. They are accepted at construction and
 * never passed per call — the seam is wired once in the composition root.
 */
export interface JobProtocolPorts {
  completeStep(organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean): void;
  evaluatorEligible(runnerId: string, jobId: string): boolean;
  runnerCurrent(organizationId: string, runnerId: string): boolean;
  activeRelease(organizationId: string): { digest: string; manifest: string } | undefined;
  resolveWorkflow(organizationId: string, workflowId: string): { workflow: unknown; configDigest: string };
  startRun(input: { organizationId: string; workspaceId: string; actorId: string; workflowId: string; workflow: unknown; configDigest: string; runInput: JsonValue; executionKey: string; runnerId?: string }): { runId: string };
  /** Mission-local admission for a run's next attempt (member cap, then budget); no mission means interactive work. */
  missionAdmission?(organizationId: string, workspaceId: string, runId: string): MissionAdmission;
  /** Starts a mission from a Play for a scheduled occurrence. */
  startMission?(input: { organizationId: string; workspaceId: string; playId: string; startedBy: string; occurrenceId: string }): string;
  /** Whether a mission is still open. */
  startDescribedMission?(input: { organizationId: string; workspaceId: string; title: string; situation: string; startedBy: string; occurrenceId: string; sourceMissionId?: string }): string;
  missionOpen?(organizationId: string, workspaceId: string, missionId: string): boolean;
  /** Records the admitted attempt's reservation against its mission. */
  missionReserve?(organizationId: string, workspaceId: string, input: { missionId: string; runId: string; attemptId: string; microUsd: number }): void;
  /** Where governed read tools get their data (documents, CSV artifacts, knowledge). */
  toolReads?: ToolReadPorts;
  /** The context pack of an agent step's work item, built at the step's first offer. */
  contextPack?(organizationId: string, workspaceId: string, input: { runId: string; jobId: string; agentId: string; budgetTokens: number; taskText: string }): ReturnType<ContextPackPort>;
}

export type MissionAdmission = { missionId?: string; admitted: true; reserve: number; running: number } | { missionId: string; admitted: false; reason: string; running: number };

/**
 * The jobs module's one deep interface: the runner session protocol, the
 * attempt lifecycle (claim/ack/renew/events/complete/release) and both
 * dispatch loops, behind a single object that owns the Store and the host
 * ports. Callers supply intent — an identity struct, an attempt id, a body —
 * never a Store, a deps bag or an eligibility callback.
 */
export class JobProtocol {
  /** T52 unified automations; owned here so dispatch shares the same ports. */
  readonly automations: AutomationService;

  constructor(private readonly store: Store, private readonly ports: JobProtocolPorts) {
    this.automations = new AutomationService(store, {
      resolveWorkflow: (organizationId, workflowId) => this.ports.resolveWorkflow(organizationId, workflowId),
      startRun: (input) => this.ports.startRun(input),
      ...(this.ports.startMission ? { startMission: (input: Parameters<NonNullable<JobProtocolPorts["startMission"]>>[0]) => this.ports.startMission!(input) } : {}),
      ...(this.ports.startDescribedMission ? { startDescribedMission: (input: Parameters<NonNullable<JobProtocolPorts["startDescribedMission"]>>[0]) => this.ports.startDescribedMission!(input) } : {}),
      ...(this.ports.missionOpen ? { missionOpen: (organizationId: string, workspaceId: string, missionId: string) => this.ports.missionOpen!(organizationId, workspaceId, missionId) } : {}),
    });
  }

  // --- Runner session protocol ---

  issueEnrollment(actor: { scopes: readonly string[]; actorId: string; organizationId: string }, groupId: string): { token: string; expiresAt: string } {
    return issueEnrollment(this.store, actor, groupId);
  }

  controlRunner(actor: { scopes: readonly string[]; actorId: string; organizationId: string }, input: { runnerId: string; action: string; reason: string }): string {
    return operateRunner(this.store, actor, input);
  }

  enrollRunner(input: { token: string; publicKeyPem: string; runnerId: string }): { credential: string } {
    return enrollRunner(this.store, input);
  }

  challenge(runnerId: string, credential: string): { challengeId: string; nonce: string; expiresAt: string } {
    return runnerChallenge(this.store, runnerId, credential);
  }

  hello(hello: Record<string, unknown>): { sessionToken: string; epoch: number; serverTime: string } {
    return runnerHello(this.store, hello);
  }

  /** Establishes the runner identity every later call carries. */
  authenticate(headers: Headers): RunnerIdentity {
    return authRunner(this.store, headers);
  }

  heartbeat(runner: { runnerId: string; epoch: number }, body: Record<string, unknown>): { acceptedSequence: number; serverTime: string; commands: HeartbeatCommand[] } {
    return heartbeat(this.store, runner, body);
  }

  // --- Attempt lifecycle ---

  /** Fair claim; the eligibility ports are supplied here, never per call. */
  claim(runner: RunnerIdentity, requestId: string): JsonValue | null {
    return claim(this.store, {
      isEvaluatorEligible: (runnerId, jobId) => this.ports.evaluatorEligible(runnerId, jobId),
      isRunnerCurrent: (runnerId) => this.ports.runnerCurrent(runner.organizationId, runnerId),
      ...(this.ports.missionAdmission ? { missionAdmission: (workspaceId: string, runId: string) => this.ports.missionAdmission!(runner.organizationId, workspaceId, runId) } : {}),
      ...(this.ports.contextPack ? { contextPack: (organizationId: string, workspaceId: string, input: Parameters<ContextPackPort>[2]) => this.ports.contextPack!(organizationId, workspaceId, input) } : {}),
      ...(this.ports.missionReserve ? { missionReserve: (workspaceId: string, input: { missionId: string; runId: string; attemptId: string; microUsd: number }) => this.ports.missionReserve!(runner.organizationId, workspaceId, input) } : {}),
    }, runner, requestId);
  }

  /** A governed read tool call from a live attempt: scope and allowlist are rechecked here and refusals audited. */
  toolRead(runner: RunnerIdentity, attemptId: string, request: ToolReadRequest): JsonValue {
    if (!this.ports.toolReads) throw new BrainDomainError("UNSUPPORTED_CAPABILITY", "governed read tools are not available");
    return brokerToolRead(this.store, this.ports.toolReads, runner, attemptId, request);
  }

  executionArtifact(runner: RunnerIdentity, attemptId: string): Uint8Array {
    return readExecutionArtifact(this.store, runner, attemptId);
  }

  ack(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return ackAttempt(this.store, runner, attemptId, body);
  }

  renew(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return renewAttempt(this.store, runner, attemptId, body);
  }

  events(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return attemptEvents(this.store, runner, attemptId, body);
  }

  complete(runner: RunnerIdentity, attemptId: string, body: Record<string, unknown>): JsonValue {
    return completeAttempt(this.store, {
      completeStep: (organizationId, workspaceId, runId, stepId, output, ok) => this.ports.completeStep(organizationId, workspaceId, runId, stepId, output, ok),
    }, runner, attemptId, body);
  }

  release(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return releaseAttempt(this.store, runner, attemptId, body);
  }

  expireLeases(): number {
    return expireLeases(this.store);
  }

  /** Restarts or fails jobs that no event will ever move again (see watchdog.ts); idempotent. */
  sweepStuckJobs(stuckMs?: number): number {
    return sweepStuckJobs(this.store, {
      completeStep: (organizationId, workspaceId, runId, stepId, output, ok) => this.ports.completeStep(organizationId, workspaceId, runId, stepId, output, ok),
    }, stuckMs);
  }

  releaseReservation(attemptId: string): void {
    releaseReservation(this.store, attemptId);
  }

  // --- Job lifecycle outside the runner protocol ---

  /** Queues the job for a workflow step; a repeated execution key returns the same job. */
  createForStep(input: CreateJobInput): string {
    return createJobForStep(this.store, input);
  }

  /** Cancels the run's jobs that no runner holds yet. */
  cancelForRun(runId: string): void {
    cancelJobsForRun(this.store, runId);
  }

  /** Resolves an outcome_unknown job's reconciliation with target evidence. */
  resolveReconciliation(input: { organizationId: string; jobId: string; outcome: ReconciliationOutcome; evidenceDigest: string }): { jobId: string; outcome: ReconciliationOutcome } {
    return resolveReconciliation(this.store, input);
  }

  /** Concludes a job and attempt from an accepted verdict, inside the caller's transaction if any. */
  concludeAttempt(input: { jobId: string; attemptId: string; state: "succeeded" | "failed"; jobFence?: number }): void {
    concludeAttempt(this.store, input);
  }

  /** Unresolved (outcome_unknown) and active job counts for a workspace. */
  workspaceJobLoad(workspaceId: string): { unresolved: number; active: number } {
    return workspaceJobLoad(this.store, workspaceId);
  }

  // --- Dispatch loops ---

  /** Declared Schedule documents in the active release, fired once per due minute. */
  dispatchSchedules(): { dispatched: number; skipped: number } {
    return runScheduledDispatch(this.store, {
      activeRelease: (organizationId) => this.ports.activeRelease(organizationId),
      resolveWorkflow: (organizationId, workflowId) => this.ports.resolveWorkflow(organizationId, workflowId),
      startRun: (input) => this.ports.startRun(input),
    });
  }

  /** Due automation occurrences materialize and dispatch in the same maintenance pass. */
  dispatchAutomations(): { dispatched: number; skipped: number } {
    return this.automations.dispatchAll();
  }
}
