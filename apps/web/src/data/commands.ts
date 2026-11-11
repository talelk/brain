import { runCommand } from "../data/governor";
import type { CommandReceipt, MissionBudget, OrganizationAdminCommand, PlanTask, WorkItemState } from "@brain/contracts";

/**
 * Explicit Brain commands, one per declared command type.
 *
 * Nothing here routes through a generic `update(id, patch)`. Every effect
 * carries its own idempotency key, the workspace scope and — where the domain
 * requires it — the expected version, so a stale client cannot overwrite a
 * newer server state.
 */
export type CommandKind =
  | "workflow.dispatch" | "workflow.cancel" | "job.reconcile" | "session.steer" | "session.stop" | "session.create"
  | "runner.control"
  | "mission.create" | "mission.policy.set" | "mission.pause" | "mission.resume" | "mission.proposeCompletion" | "mission.close" | "mission.watch" | "mission.seen"
  | "mission.brief.edit" | "decision.accept" | "plan.propose" | "plan.confirm" | "plan.reject" | "workItem.transition" | "workItem.comment" | "handoff.submit" | "mission.message.send"
  | "mission.budget.set" | "workspace.spendCap.set"
  | "automation.upsert" | "automation.control"
  | "document.upload" | "document.revise" | "document.associate" | "document.delete"
  | "integration.connect" | "integration.verify" | "integration.bind"
  | "configDraft.create" | "configDraft.update" | "configDraft.validate" | "configDraft.test" | "configDraft.publish"
  | "member.grant" | "member.revoke" | "config.activate" | "memory.publish" | "memory.revoke"
  | "tool.propose" | "tool.publish" | "capitalization.run" | "capability.review" | "approval.revoke" | "workspace.update" | "workspace.control" | "workspace.export" | "workspace.import"
  | OrganizationAdminCommand["commandType"];

export interface CommandContext {
  workspaceId: string;
  /** Captured once per exact request and reused by the recovery path. */
  idempotencyKey?: string;
  commandId?: string;
  expectedVersion?: number;
}

export type PayloadFor<K extends CommandKind> =
  K extends "mission.create" ? { title: string; intent?: string; successCriteria?: string[]; constraints?: string[]; playId?: string; autonomy?: "supervised" | "standard" | "autonomous"; budget?: { maxMicroUsd?: number; memberCap: number }; autoStart?: boolean }
    : K extends "mission.policy.set" ? { missionId: string; autoStart?: boolean; preset?: "supervised" | "standard" | "autonomous" }
    : K extends "mission.pause" | "mission.resume" | "mission.proposeCompletion" ? { missionId: string }
    : K extends "mission.close" ? { missionId: string; outcome: "achieved" | "ended" | "cancelled" }
    : K extends "mission.budget.set" ? { missionId: string; budget: MissionBudget }
    : K extends "workspace.spendCap.set" ? { dailyMicroUsd?: number; weeklyMicroUsd?: number }
    : K extends "mission.watch" ? { missionId: string; watch: boolean }
    : K extends "mission.seen" ? { missionId: string; cursor: number }
    : K extends "mission.brief.edit" ? { missionId: string; baseVersion: number; intent?: string; constraints?: string[] }
    : K extends "decision.accept" ? { missionId: string; baseVersion: number; statement: string; source: { kind: "human" | "handoff" | "verdict" | "knowledge"; ref?: string }; supersedes?: string }
    : K extends "plan.propose" ? { missionId: string; origin: "manual" | "agent" | "template" | "capitalization"; summary?: string; tasks: PlanTask[] }
      : K extends "plan.confirm" ? { planVersionId: string }
      : K extends "plan.reject" ? { planVersionId: string; reason: string }
        : K extends "workItem.transition" ? { workItemId: string; state: WorkItemState; evidenceDigest?: string; reason?: string }
          : K extends "handoff.submit" ? { workItemId: string; notes: { summary: string; decisions?: string[]; openQuestions?: string[]; nextAction?: string; referencedOutputs?: string[] } }
          : K extends "workItem.comment" ? { workItemId: string; text: string }
            : K extends "mission.message.send" ? { missionId: string; recipient: { kind: "mission" | "member"; memberId?: string }; workItemId?: string; body: string; correctionOf?: string; interrupt?: boolean }
            : K extends "workflow.dispatch" ? { workflow: { id: string; digest: string }; input: Record<string, unknown>; workItemId?: string }
    : K extends "workflow.cancel" ? { runId: string; reason: string }
      : K extends "job.reconcile" ? { jobId: string; reason: string }
        : K extends "session.steer" ? { sessionId: string; message: string }
          : K extends "session.stop" ? { sessionId: string; reason: string }
            : K extends "session.create" ? { workItemId: string; agentId: string; engineId: string; task: string; budget: { maxTokens: number; maxMicroUsd: number; maxTurns: number }; scope: { allowedPaths: string[]; prohibitedPaths: string[]; allowedTools: string[] }; worktreeId: string; resumeFromSessionId?: string }
                      : K extends "runner.control" ? { runnerId: string; action: "enable" | "disable" | "drain" | "quarantine" | "rotate" | "deregister"; reason: string }
                        : K extends "member.grant" ? { principalId: string; role: string; reason: string }
                        : K extends "member.revoke" ? { principalId: string; role: string; reason: string }
                          : K extends "config.activate" ? { configDigest: string; expectedActiveDigest: string | null }
                            : K extends "memory.publish" ? { candidateId: string; sourceWorkspaceId: string; targetScope: unknown; content: unknown; evidenceDigests: string[]; reviewerId: string; redactionProfile: unknown }
                              : K extends "memory.revoke" ? { sourceId: string; reason: string }
                                : K extends "tool.propose" ? { package: unknown; evidence: string[] }
                                  : K extends "tool.publish" ? { release: { id: string; digest: string }; evidence: string[] }
                                    : K extends "capitalization.run" ? Record<string, never>
                                      : K extends "capability.review" ? { candidateId: string; decision: "approve" | "reject"; reason: string }
                                        : K extends "approval.revoke" ? { approvalId: string; reason: string }
                                      : K extends "workspace.update" ? { workspaceId: string; displayName: string; description: string; ownerId: string; tags: string[] }
                                          : K extends "workspace.control" ? { workspaceId: string; action: "suspend" | "resume" | "archive"; reason: string }
                                              : K extends "workspace.export" ? { workspaceId: string }
                                          : K extends "workspace.import" ? { workspaceId: string; bundle: unknown }
                                            : K extends "automation.upsert" ? { automationId?: string; title?: string; target: { kind: "workflow" | "workItem" | "play"; id: string }; trigger: { kind: "cron"; cron: string; timezone: string } | { kind: "once"; scheduledAt: string } | { kind: "manual" }; input?: unknown; overlap?: "skip" | "queue-one"; misfire?: "skip" | "coalesce"; execution?: { mode: "managed" } | { mode: "personal-host"; runnerId: string; offlinePolicy: "wait" | "fail" } }
                                              : K extends "automation.control" ? { automationId: string; action: "pause" | "resume" | "runNow" | "retire"; reason?: string }
                                                : K extends "document.upload" ? { title: string; fileName: string; mediaType: string; bytesBase64: string }
                                                  : K extends "document.revise" ? { documentId: string; title: string; fileName: string; mediaType: string; bytesBase64: string }
                                                    : K extends "document.associate" ? { documentId: string; resource: { kind: "workItem" | "mission" | "session" | "run"; id: string } }
                                                      : K extends "document.delete" ? { documentId: string; reason: string }
                                                        : K extends "integration.connect" ? { name: string; repositoryUrl: string; username?: string; token?: string }
                                                          : K extends "integration.verify" ? { connectionId: string }
                                                            : K extends "integration.bind" ? { connectionId: string; workspaceId: string; kind: "configuration" | "project"; repositoryKey: string; access: "read" | "write" }
                                                              : K extends "configDraft.create" ? { title: string; kind?: string; bindingId?: string; documents?: Array<{ path: string; text: string }>; assets?: Array<{ path: string; text: string }>; sourceDefinition?: { kind: "Agent" | "Workflow" | "RunnerGroup" | "Policy"; id: string; mode: "edit" | "duplicate" } }
                                                                : K extends "configDraft.update" ? { draftId: string; documents: Array<{ path: string; text: string }>; assets?: Array<{ path: string; text: string }>; source?: "visual" | "yaml" }
                                                                  : K extends "configDraft.validate" | "configDraft.test" ? { draftId: string }
                                                                    : K extends "configDraft.publish" ? { draftId: string; bindingId?: string }
                                                                      : K extends OrganizationAdminCommand["commandType"] ? OrganizationAdminCommand["payload"]
                                                  : never;

export async function send<K extends CommandKind>(
  commandType: K,
  payload: PayloadFor<K>,
  context: CommandContext,
): Promise<CommandReceipt> {
  return runCommand({
    commandType,
    payload: payload as never,
    ...(commandType.startsWith("organization.") ? {} : { workspaceId: context.workspaceId }),
    ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
    ...(context.commandId ? { commandId: context.commandId } : {}),
    ...(context.expectedVersion !== undefined ? { expectedVersion: context.expectedVersion } : {}),
  } as never);
}
