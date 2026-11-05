import { domainDigest } from "@brain/contracts";
import type { ActorContext, CommandEnvelope, CommandReceipt, JsonValue } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { BrainDomainError } from "../domain/errors";
import { authorizeCommand, requireWorkspaceRead, type ResolvedActor } from "./authz";
import type { Store } from "./store";

/**
 * The command funnel (ADR 0002). Every command — workspace, organization
 * administration and the human approval decision — is admitted, deduplicated,
 * applied by exactly one registered handler and committed here. A receipt
 * exists only for an applied command intent: the funnel never stores a
 * receipt before the effect, so a failed effect leaves its key retryable.
 *
 * The funnel is the single writer of command_intents, command_idempotency
 * and the per-workspace command_effects marker.
 */

/** An admitted command as handlers see it. */
export type Command = CommandEnvelope & { readonly workspaceId?: string; readonly expectedVersion?: number; readonly payload: Record<string, unknown> };

export interface CommandCall {
  readonly actor: ActorContext;
  readonly cmd: Command;
  /** Present for workspace handlers; the funnel enforces it. */
  readonly workspaceId: string;
  /** The server-verified identity, for handlers that bind to the human session. */
  readonly identity?: ResolvedActor;
  readonly headers: Headers;
}

export interface HandlerResult {
  /** `queued` only when the handler started asynchronous work. */
  readonly outcome?: "applied" | "queued";
  readonly resourceId?: string;
  readonly receiptExtra?: Readonly<Record<string, JsonValue>>;
  /** Runs once after the receipt commits; never on replay. */
  readonly afterCommit?: () => void;
}

/**
 * How a handler's effect commits decides what a retry of a still-pending
 * intent does (ADR 0002):
 * - control: effect, intent and receipt share one control.db transaction.
 * - workspace: effect and the command_effects marker share one workspace.db
 *   transaction; a retry reuses the marker instead of re-running.
 * - self: the handler is idempotent on the command id and manages its own
 *   transactions; a retry re-runs it.
 * - external: async effect outside any transaction; a pending retry fails
 *   OUTCOME_UNKNOWN and needs reconciliation.
 */
export type CommandHandler =
  | { readonly kind: "control" | "workspace" | "self"; handle(call: CommandCall): HandlerResult }
  | { readonly kind: "external"; handle(call: CommandCall): Promise<HandlerResult> };

export type CommandHandlers = Readonly<Record<string, CommandHandler>>;

export interface CommandOutcome { readonly receipt: CommandReceipt; readonly status: number }

export interface ExecuteOptions { readonly headers?: Headers; readonly identity?: ResolvedActor }

interface Admitted {
  readonly cmd: Command;
  readonly handler: CommandHandler;
  readonly workspaceId?: string;
  readonly requestJson: string;
  readonly requestDigest: string;
}

const statusOf = (receipt: CommandReceipt): number => (receipt.outcome === "queued" ? 202 : 200);

export class CommandFunnel {
  constructor(
    private readonly store: Store,
    private readonly handlers: CommandHandlers,
    private readonly hooks: { afterCommit(): void } = { afterCommit: () => undefined },
  ) {}

  /** The registered command types, for the registry coverage check. */
  commandTypes(): string[] { return Object.keys(this.handlers); }

  /** Admits a wire CommandEnvelope against the registry and runs it. */
  execute(actor: ActorContext, raw: unknown, opts: ExecuteOptions = {}): Promise<CommandOutcome> {
    const check = validate("CommandEnvelope", raw);
    if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", `command invalid: ${check.errors.join("; ")}`);
    const cmd = raw as Command;
    authorizeCommand(actor, cmd.commandType);
    return this.run(actor, cmd, opts);
  }

  /**
   * Runs a command a route has already admitted under its own wire contract
   * (the human approval decision). Replay, intent and commit are identical.
   */
  async run(actor: ActorContext, cmd: Command, opts: ExecuteOptions = {}): Promise<CommandOutcome> {
    const handler = this.handlers[cmd.commandType];
    if (!handler) throw new BrainDomainError("INVALID_CONTRACT", `unknown command ${cmd.commandType}`);
    const workspaceId = cmd.workspaceId;
    if (workspaceId) requireWorkspaceRead(this.store, actor, workspaceId);
    if (handler.kind === "workspace" && !workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    const requestJson = JSON.stringify(cmd);
    const admitted: Admitted = { cmd, handler, requestJson, requestDigest: domainDigest("brain:command:v1", cmd as unknown as JsonValue), ...(workspaceId ? { workspaceId } : {}) };

    const prior = this.priorReceipt(actor, admitted);
    if (prior) return { receipt: prior, status: statusOf(prior) };
    const call: CommandCall = { actor, cmd, workspaceId: workspaceId ?? "", headers: opts.headers ?? new Headers(), ...(opts.identity ? { identity: opts.identity } : {}) };

    const pending = this.intentState(admitted) === "pending";
    let result: HandlerResult;
    if (handler.kind === "control") {
      let receipt!: CommandReceipt;
      this.store.inTx(this.store.control, () => {
        this.assertIntentFree(admitted);
        result = handler.handle(call);
        receipt = this.commit(actor, admitted, result);
      });
      return this.finish(receipt, result!);
    }
    if (pending && handler.kind === "external") {
      throw new BrainDomainError("OUTCOME_UNKNOWN", "a previous attempt of this command has an unknown external outcome; reconcile before retrying");
    }
    const recovered = pending && handler.kind === "workspace" ? this.effectMarker(actor, admitted) : undefined;
    if (recovered) {
      result = recovered;
    } else {
      this.recordPending(admitted);
      try {
        if (handler.kind === "workspace") {
          const ws = this.store.workspaceDb(admitted.workspaceId!, actor.organizationId);
          result = this.store.inTx(ws, () => {
            const applied = handler.handle(call);
            ws.prepare("INSERT INTO command_effects(command_id, result_json, created_at_ms) VALUES (?,?,?)")
              .run(cmd.commandId, JSON.stringify(markerOf(applied)), this.store.now());
            return applied;
          });
        } else {
          result = handler.kind === "external" ? await handler.handle(call) : handler.handle(call);
        }
      } catch (error) {
        this.store.control.prepare("UPDATE command_intents SET state='failed' WHERE command_id=? AND state='pending'").run(cmd.commandId);
        throw error;
      }
    }
    const receipt = this.store.inTx(this.store.control, () => this.commit(actor, admitted, result));
    return this.finish(receipt, result);
  }

  private finish(receipt: CommandReceipt, result: HandlerResult): CommandOutcome {
    result.afterCommit?.();
    this.hooks.afterCommit();
    return { receipt, status: statusOf(receipt) };
  }

  private priorReceipt(actor: ActorContext, a: Admitted): CommandReceipt | undefined {
    const prior = this.store.control.prepare("SELECT request_digest, receipt_json FROM command_idempotency WHERE organization_id=? AND actor_id=? AND command_type=? AND idempotency_key=?")
      .get(actor.organizationId, actor.actorId, a.cmd.commandType, a.cmd.idempotencyKey) as { request_digest: string; receipt_json: string } | undefined;
    if (!prior) return undefined;
    if (prior.request_digest !== a.requestDigest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "same idempotency key with different payload");
    return JSON.parse(prior.receipt_json) as CommandReceipt;
  }

  private intentState(a: Admitted): string | undefined {
    const row = this.store.control.prepare("SELECT state, request_json FROM command_intents WHERE command_id=?").get(a.cmd.commandId) as { state: string; request_json: string } | undefined;
    if (!row) return undefined;
    if (row.state === "applied") throw new BrainDomainError("CONFLICT", "command id already recorded");
    if (row.request_json !== a.requestJson) throw new BrainDomainError("CONFLICT", "command id already recorded with a different request");
    return row.state;
  }

  /** Inside the control transaction: the id must not have been applied meanwhile. */
  private assertIntentFree(a: Admitted): void {
    this.intentState(a);
  }

  private recordPending(a: Admitted): void {
    this.store.control.prepare("INSERT INTO command_intents(command_id, workspace_id, request_json, state, created_at_ms) VALUES (?,?,?,'pending',?) ON CONFLICT(command_id) DO UPDATE SET state='pending'")
      .run(a.cmd.commandId, a.workspaceId ?? null, a.requestJson, this.store.now());
  }

  private effectMarker(actor: ActorContext, a: Admitted): HandlerResult | undefined {
    const ws = this.store.workspaceDb(a.workspaceId!, actor.organizationId);
    const row = ws.prepare("SELECT result_json FROM command_effects WHERE command_id=?").get(a.cmd.commandId) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) as HandlerResult : undefined;
  }

  /** Must run inside the control transaction. Marks the intent applied and stores the receipt. */
  private commit(actor: ActorContext, a: Admitted, result: HandlerResult): CommandReceipt {
    const receipt = {
      commandId: a.cmd.commandId, accepted: true, outcome: result.outcome ?? "applied",
      ...(result.resourceId ? { resourceId: result.resourceId } : {}),
      ...(result.receiptExtra ?? {}),
    } as CommandReceipt;
    this.store.control.prepare("INSERT INTO command_intents(command_id, workspace_id, request_json, state, created_at_ms) VALUES (?,?,?,'applied',?) ON CONFLICT(command_id) DO UPDATE SET state='applied'")
      .run(a.cmd.commandId, a.workspaceId ?? null, a.requestJson, this.store.now());
    this.store.control.prepare("INSERT INTO command_idempotency(organization_id, actor_id, command_type, idempotency_key, request_digest, command_id, receipt_json, created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(actor.organizationId, actor.actorId, a.cmd.commandType, a.cmd.idempotencyKey, a.requestDigest, a.cmd.commandId, JSON.stringify(receipt), this.store.now());
    return receipt;
  }
}

function markerOf(result: HandlerResult): Omit<HandlerResult, "afterCommit"> {
  const { afterCommit: _afterCommit, ...stored } = result;
  return stored;
}

/** Shorthand for handler maps: many command types bound to one handler. */
export function handlersFor(types: readonly string[], handler: CommandHandler): Record<string, CommandHandler> {
  return Object.fromEntries(types.map((type) => [type, handler]));
}
