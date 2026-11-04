import { domainDigest } from "@brain/contracts";
import type { CommandReceipt, JsonValue } from "@brain/contracts";
import type { Store } from "./store";
import { BrainDomainError } from "../domain/errors";

/**
 * The single idempotent command envelope (issue #2, command funnel phase 2).
 * Every command path — workspace commands, organization administration and
 * human approval decisions — checks the prior receipt, applies the effect and
 * commits the durable receipt through these helpers, so replay semantics live
 * in exactly one place.
 */
export interface CommandContext {
  readonly organizationId: string;
  readonly actorId: string;
  readonly commandType: string;
  readonly idempotencyKey: string;
  readonly commandId: string;
  readonly requestJson: string;
  readonly workspaceId?: string;
}

/** The digest that binds the exact request bytes. */
export function requestDigestOf(raw: unknown): string {
  return domainDigest("brain:command:v1", raw as JsonValue);
}

function lookup(store: Store, ctx: CommandContext): { request_digest: string; receipt_json: string } | undefined {
  return store.control.prepare("SELECT request_digest, receipt_json FROM command_idempotency WHERE organization_id=? AND actor_id=? AND command_type=? AND idempotency_key=?")
    .get(ctx.organizationId, ctx.actorId, ctx.commandType, ctx.idempotencyKey) as { request_digest: string; receipt_json: string } | undefined;
}

/**
 * The pre-transaction replay check. A key reused with a different payload is
 * always a conflict; a matching key returns the stored receipt.
 */
export function priorReceipt(store: Store, ctx: CommandContext, digest: string): CommandReceipt | undefined {
  const prior = lookup(store, ctx);
  if (!prior) return undefined;
  if (prior.request_digest !== digest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "same idempotency key with different payload");
  return JSON.parse(prior.receipt_json) as CommandReceipt;
}

/**
 * Must run inside `store.inTx(store.control, …)`. Returns the stored receipt
 * on replay; otherwise runs `apply`, builds the receipt, records the command
 * intent and commits the idempotency row. `apply` returns the resource it
 * produced plus any receipt fields beyond the standard envelope.
 */
export function commitReceipt(
  store: Store,
  ctx: CommandContext,
  digest: string,
  apply: () => { resourceId?: string; receiptExtra?: Record<string, unknown> },
  outcome: "applied" | "queued",
): { receipt: CommandReceipt; replayed: boolean } {
  const prior = lookup(store, ctx);
  if (prior) {
    if (prior.request_digest !== digest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "same idempotency key with different payload");
    return { receipt: JSON.parse(prior.receipt_json) as CommandReceipt, replayed: true };
  }
  const applied = apply();
  const receipt = {
    commandId: ctx.commandId, accepted: true, outcome,
    ...(applied.resourceId ? { resourceId: applied.resourceId } : {}),
    ...(applied.receiptExtra ?? {}),
  } as CommandReceipt;
  // A command id may already exist only as an unfinished intent (the external-effect
  // path pre-writes one, and a failed attempt must stay retryable); an already-applied
  // id is a genuine collision.
  const recorded = store.control.prepare("SELECT state FROM command_intents WHERE command_id=?").get(ctx.commandId) as { state: string } | undefined;
  if (recorded && recorded.state !== "pending" && recorded.state !== "failed") throw new BrainDomainError("CONFLICT", "command id already recorded");
  if (recorded) store.control.prepare("UPDATE command_intents SET state=?, request_json=?, workspace_id=? WHERE command_id=?").run("applied", ctx.requestJson, ctx.workspaceId ?? null, ctx.commandId);
  else store.control.prepare("INSERT INTO command_intents(command_id, workspace_id, request_json, state, created_at_ms) VALUES (?,?,?,?,?)")
    .run(ctx.commandId, ctx.workspaceId ?? null, ctx.requestJson, "applied", store.now());
  store.control.prepare("INSERT INTO command_idempotency(organization_id, actor_id, command_type, idempotency_key, request_digest, command_id, receipt_json, created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(ctx.organizationId, ctx.actorId, ctx.commandType, ctx.idempotencyKey, digest, ctx.commandId, JSON.stringify(receipt), store.now());
  return { receipt, replayed: false };
}
