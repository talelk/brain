import { runCommand } from "../data/governor";
import type { CommandReceipt } from "@brain/contracts";

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
  | "member.grant" | "member.revoke" | "config.activate" | "memory.publish" | "memory.revoke"
  | "tool.propose" | "tool.publish" | "approval.revoke" | "workspace.suspend" | "workspace.export" | "workspace.import";

export interface CommandContext {
  workspaceId: string;
  /** Captured once per exact request and reused by the recovery path. */
  idempotencyKey?: string;
  expectedVersion?: number;
}

export type PayloadFor<K extends CommandKind> =
  K extends "workflow.dispatch" ? { workflow: { id: string; digest: string }; input: Record<string, unknown> }
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
                          : K extends "config.activate" ? { configDigest: string; expectedActiveDigest: string }
                            : K extends "memory.publish" ? { candidateId: string; sourceWorkspaceId: string; targetScope: unknown; content: unknown; evidenceDigests: string[]; reviewerId: string; redactionProfile: unknown }
                              : K extends "memory.revoke" ? { sourceId: string; reason: string }
                                : K extends "tool.propose" ? { package: unknown; evidence: string[] }
                                  : K extends "tool.publish" ? { release: { id: string; digest: string }; evidence: string[] }
                                    : K extends "approval.revoke" ? { approvalId: string; reason: string }
                                      : K extends "workspace.suspend" ? { workspaceId: string; reason: string }
                                        : K extends "workspace.export" ? { workspaceId: string }
                                          : K extends "workspace.import" ? { workspaceId: string; bundle: unknown }
                                            : never;

export async function send<K extends CommandKind>(
  commandType: K,
  payload: PayloadFor<K>,
  context: CommandContext,
): Promise<CommandReceipt> {
  return runCommand({
    commandType,
    payload: payload as never,
    workspaceId: context.workspaceId,
    ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
    ...(context.expectedVersion !== undefined ? { expectedVersion: context.expectedVersion } : {}),
  } as never);
}

/** Receipts are authoritative; `queued` is not completion. */
export function receiptMessage(receipt: CommandReceipt): string {
  if (!receipt.accepted) return `Rejected: ${receipt.error?.detail ?? "the Governor refused this request"}`;
  return receipt.outcome === "applied" ? "Applied."
    : receipt.outcome === "pending-approval" ? "Recorded — this effect needs an approval before it runs."
      : "Queued for execution.";
}
