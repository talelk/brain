import { runCommand } from "../data/governor";
import type { CommandReceipt, OrganizationAdminCommand, PlanTask, WorkItemState } from "@brain/contracts";

/**
 * Explicit Brain commands, one per declared command type.
 *
 * Nothing here routes through a generic `update(id, patch)`. Every effect
 * carries its own idempotency key, the workspace scope and — where the domain
 * requires it — the expected version, so a stale client cannot overwrite a
 * newer server state.
 */
export type CommandKind =
  | "workflow.dispatch" | "workflow.cancel" | "job.reconcile" | "session.steer" | "session.stop"
  | "board.create" | "board.move" | "board.comment" | "decision.record" | "runner.drain" | "runner.quarantine"
  | "objective.create" | "plan.propose" | "plan.confirm" | "workItem.transition" | "workItem.comment"
  | "automation.upsert" | "automation.control"
  | "document.upload" | "document.revise" | "document.associate" | "document.delete"
  | "integration.connect" | "integration.verify" | "integration.bind"
  | "configDraft.create" | "configDraft.update" | "configDraft.validate" | "configDraft.test" | "configDraft.publish"
  | "member.grant" | "member.revoke" | "config.activate" | "memory.publish" | "memory.revoke"
  | "tool.propose" | "tool.publish" | "capitalization.run" | "capability.review" | "approval.revoke" | "workspace.suspend" | "workspace.export" | "workspace.import"
  | OrganizationAdminCommand["commandType"];

export interface CommandContext {
  workspaceId: string;
  /** Captured once per exact request and reused by the recovery path. */
  idempotencyKey?: string;
  commandId?: string;
  expectedVersion?: number;
}

export type PayloadFor<K extends CommandKind> =
  K extends "objective.create" ? { title: string; intent: string; successCriteria: string[] }
    : K extends "plan.propose" ? { objectiveId: string; origin: "manual" | "agent" | "template" | "capitalization"; summary?: string; tasks: PlanTask[] }
      : K extends "plan.confirm" ? { planVersionId: string }
        : K extends "workItem.transition" ? { workItemId: string; state: WorkItemState; evidenceDigest?: string; reason?: string }
          : K extends "workItem.comment" ? { workItemId: string; text: string }
            : K extends "workflow.dispatch" ? { workflow: { id: string; digest: string }; input: Record<string, unknown>; workItemId?: string }
    : K extends "workflow.cancel" ? { runId: string; reason: string }
      : K extends "job.reconcile" ? { jobId: string; reason: string }
        : K extends "session.steer" ? { sessionId: string; message: string }
          : K extends "session.stop" ? { sessionId: string; reason: string }
            : K extends "board.create" ? { title: string; criteria: string[] }
              : K extends "board.move" ? { cardId: string; status: string; evidenceDigest?: string }
                : K extends "board.comment" ? { cardId: string; text: string }
                  : K extends "decision.record" ? { cardId: string; decision: "go" | "no" | "not-now" | "need-more-data"; note: string }
                    : K extends "runner.drain" | "runner.quarantine" ? { runnerId: string; reason: string }
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
                                      : K extends "workspace.suspend" ? { workspaceId: string; reason: string }
                                        : K extends "workspace.export" ? { workspaceId: string }
                                          : K extends "workspace.import" ? { workspaceId: string; bundle: unknown }
                                            : K extends "automation.upsert" ? { automationId?: string; title?: string; target: { kind: "workflow" | "workItem"; id: string }; trigger: { kind: "cron"; cron: string; timezone: string } | { kind: "once"; scheduledAt: string } | { kind: "manual" }; input?: unknown; overlap?: "skip" | "queue-one"; misfire?: "skip" | "coalesce"; execution?: { mode: "managed" } | { mode: "personal-host"; runnerId: string; offlinePolicy: "wait" | "fail" } }
                                              : K extends "automation.control" ? { automationId: string; action: "pause" | "resume" | "runNow"; reason?: string }
                                                : K extends "document.upload" ? { title: string; fileName: string; mediaType: string; bytesBase64: string }
                                                  : K extends "document.revise" ? { documentId: string; title: string; fileName: string; mediaType: string; bytesBase64: string }
                                                    : K extends "document.associate" ? { documentId: string; resource: { kind: "workItem" | "objective" | "session" | "run"; id: string } }
                                                      : K extends "document.delete" ? { documentId: string; reason: string }
                                                        : K extends "integration.connect" ? { name: string; repositoryUrl: string; username?: string; token?: string }
                                                          : K extends "integration.verify" ? { connectionId: string }
                                                            : K extends "integration.bind" ? { connectionId: string; workspaceId: string; kind: "configuration" | "project"; repositoryKey: string; access: "read" | "write" }
                                                              : K extends "configDraft.create" ? { title: string; kind?: string; bindingId?: string; documents?: Array<{ path: string; text: string }> }
                                                                : K extends "configDraft.update" ? { draftId: string; documents: Array<{ path: string; text: string }>; source?: "visual" | "yaml" }
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
