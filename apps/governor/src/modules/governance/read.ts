import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";

export interface ApprovalView {
  approvalId: string;
  organizationId: string;
  workspaceId: string;
  subject: JsonValue;
  subjectDigest: string;
  state: string;
  version: number;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
}

function approvalView(store: Store, r: Record<string, unknown>, organizationId: string): ApprovalView {
  return {
    approvalId: String(r["id"]), organizationId, workspaceId: String(r["workspace_id"]),
    subject: JSON.parse(String(r["subject_json"])) as JsonValue, subjectDigest: String(r["subject_digest"]),
    state: String(r["state"]), version: Number(r["version"]), requestedBy: String(r["requested_by"]),
    createdAt: iso(Number(r["created_at_ms"])), expiresAt: iso(Number(r["expires_at_ms"])),
  };
}

/** approvals.list: pending-first across the allowed workspaces. */
export function listApprovals(store: Store, actor: ActorContext, workspaceIds: readonly string[], limit: number): JsonValue {
  if (workspaceIds.length === 0) return { items: [] } as unknown as JsonValue;
  const marks = workspaceIds.map(() => "?").join(",");
  const rows = store.control.prepare(`SELECT * FROM approval_requests WHERE organization_id=? AND workspace_id IN (${marks}) ORDER BY expires_at_ms ASC LIMIT ?`)
    .all(actor.organizationId, ...workspaceIds, limit) as Array<Record<string, unknown>>;
  return { items: rows.map((r) => approvalView(store, r, actor.organizationId)) } as unknown as JsonValue;
}

/** approval.get: one approval, membership-checked against the allowed workspaces. */
export function getApproval(store: Store, actor: ActorContext, workspaceIds: readonly string[], approvalId: string): JsonValue {
  const row = store.control.prepare("SELECT * FROM approval_requests WHERE id=? AND organization_id=?")
    .get(approvalId, actor.organizationId) as Record<string, unknown> | undefined;
  if (!row || !workspaceIds.includes(String(row["workspace_id"]))) throw new BrainDomainError("NOT_FOUND", "approval not found");
  return approvalView(store, row, actor.organizationId) as unknown as JsonValue;
}

/** command.get: the idempotency receipt, readable only by its own actor. */
export function commandReceipt(store: Store, actor: ActorContext, commandId: string): JsonValue {
  const row = store.control.prepare("SELECT receipt_json, actor_id FROM command_idempotency WHERE organization_id=? AND command_id=?")
    .get(actor.organizationId, commandId) as { receipt_json: string; actor_id: string } | undefined;
  if (!row || row.actor_id !== actor.actorId) throw new BrainDomainError("NOT_FOUND", "command not found");
  return { commandId, receipt: JSON.parse(row.receipt_json) as JsonValue, state: "applied" } as unknown as JsonValue;
}

/** search.global helper: approvals whose id, operation, target or state match. */
export function searchApprovals(
  store: Store,
  organizationId: string,
  workspaceId: string,
  matches: (value: unknown) => boolean,
): Array<Record<string, JsonValue>> {
  const approvals = store.control.prepare("SELECT id,subject_json,state,expires_at_ms FROM approval_requests WHERE organization_id=? AND workspace_id=? ORDER BY expires_at_ms ASC LIMIT 100")
    .all(organizationId, workspaceId) as Array<{ id: string; subject_json: string; state: string; expires_at_ms: number }>;
  const results: Array<Record<string, JsonValue>> = [];
  for (const approval of approvals) {
    const subject = JSON.parse(approval.subject_json) as { operation?: string; target?: { targetId?: string } };
    if (matches(approval.id) || matches(subject.operation) || matches(subject.target?.targetId) || matches(approval.state)) {
      results.push({ category: "approval", title: subject.operation ?? "Approval request", reason: `${approval.state} · ${subject.target?.targetId ?? approval.id}`, resourceId: approval.id, workspaceId, updatedAt: iso(approval.expires_at_ms) });
    }
  }
  return results;
}
