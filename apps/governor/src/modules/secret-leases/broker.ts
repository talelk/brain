import { randomBytes } from "node:crypto";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import { attemptHoldsFence } from "../identity/index";
import type { SecretsAdapter } from "./port";

/** Past the attempt's deadline a lease may live this long (the runner's last tool call finishing), and never beyond the cap whatever the deadline. */
const SECRET_GRACE_MS = 30_000;
export const SECRET_LEASE_CAP_MS = 3600_000;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_REFS = 16;

export interface MintedSecret {
  readonly id: string;
  readonly ref: string;
  readonly envName: string;
  readonly value: string;
  readonly expiresAtMs: number;
}

interface CredentialRow { id: string; organization_id: string; workspace_id: string; attempt_id: string; job_fence: number; ref: string; expires_at_ms: number; revoked_at_ms: number | null }
type Scope = { organizationId: string; workspaceId: string; attemptId: string };

/**
 * Mints, checks and revokes the short-lived credentials of running attempts (ADR 0065). A credential is a lease on one secret reference,
 * bound to the attempt and the fence it was minted under, alive only while that attempt holds the fence, and gone at the attempt's deadline
 * plus a small grace. Its value is returned once to the caller and never stored or put in an event; the audit names the reference and the attempt.
 */
export class SecretBroker {
  constructor(private readonly store: Store, private adapters: readonly SecretsAdapter[]) {}

  /** Replaces the adapters (a deployment's own, or a test's): the port is the architecture boundary. */
  useAdapters(adapters: readonly SecretsAdapter[]): void { this.adapters = adapters; }

  /**
   * Mints one credential per reference for a running attempt. A reference no adapter serves, or the scope does not hold, refuses the
   * whole call: a tool never runs with a partial secret set. With `replace`, an earlier lease on the same reference ends.
   */
  mint(input: Scope & { refs: Readonly<Record<string, string>>; toolId?: string; replace?: boolean }): MintedSecret[] {
    const entries = Object.entries(input.refs);
    if (entries.length === 0) return [];
    if (entries.length > MAX_REFS) throw new BrainDomainError("INVALID_ARGUMENT", "too many secret references");
    for (const [envName] of entries) if (!ENV_NAME.test(envName)) throw new BrainDomainError("INVALID_ARGUMENT", `invalid secret env name ${envName}`);
    const attempt = this.store.control.prepare("SELECT job_fence FROM job_attempts WHERE id=?").get(input.attemptId) as { job_fence: number } | undefined;
    const held = attempt && attemptHoldsFence(this.store, input.attemptId, attempt.job_fence);
    if (!attempt || !held) throw this.refuse(input, "its attempt is not running under its fence", entries[0]![1]);
    const now = this.store.now();
    const notAfter = Math.min(now + SECRET_LEASE_CAP_MS, held.deadlineMs === null ? Number.POSITIVE_INFINITY : held.deadlineMs + SECRET_GRACE_MS);
    if (notAfter <= now) throw this.refuse(input, "the attempt passed its deadline", entries[0]![1]);
    // Everything is resolved before anything is recorded, so a refusal leaves no lease behind and its audit event stands.
    const resolved = entries.map(([envName, ref]) => {
      const adapter = this.adapters.find((candidate) => candidate.serves(ref));
      const material = adapter?.resolve({ organizationId: input.organizationId, workspaceId: input.workspaceId }, ref, notAfter);
      if (!adapter || !material) throw this.refuse(input, "no secret by that reference is held for this workspace", ref);
      return { envName, ref, adapter: adapter.id, value: material.value, expiresAtMs: Math.min(notAfter, material.expiresAtMs ?? Number.POSITIVE_INFINITY) };
    });
    const minted: MintedSecret[] = [];
    this.store.inTx(this.store.control, () => {
      for (const item of resolved) {
        if (input.replace) this.store.control.prepare("UPDATE secret_credentials SET revoked_at_ms=?, revoked_reason='replaced' WHERE attempt_id=? AND ref=? AND revoked_at_ms IS NULL").run(now, input.attemptId, item.ref);
        const id = `sc-${randomBytes(12).toString("base64url")}`;
        this.store.control.prepare("INSERT INTO secret_credentials(id, organization_id, workspace_id, attempt_id, job_fence, ref, adapter, tool_id, created_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(id, input.organizationId, input.workspaceId, input.attemptId, attempt.job_fence, item.ref, item.adapter, input.toolId ?? null, now, item.expiresAtMs);
        minted.push({ id, ref: item.ref, envName: item.envName, value: item.value, expiresAtMs: item.expiresAtMs });
      }
      this.event(input, "secret.minted", { attemptId: input.attemptId, toolId: input.toolId ?? null, refs: resolved.map((item) => item.ref), credentials: minted.map((item) => item.id) });
    });
    return minted;
  }

  /**
   * Checks that every named credential still holds for this attempt right now: not revoked, not expired, its attempt running under the
   * fence it was minted for. A use that fails is refused and audited. The caller has already authenticated the runner holding the attempt.
   */
  validate(attemptId: string, ids: readonly string[]): void {
    const now = this.store.now();
    for (const id of ids) {
      const row = this.store.control.prepare("SELECT id, organization_id, workspace_id, attempt_id, job_fence, ref, expires_at_ms, revoked_at_ms FROM secret_credentials WHERE id=?").get(id) as CredentialRow | undefined;
      if (!row || row.attempt_id !== attemptId) throw new BrainDomainError("FORBIDDEN", "no such secret credential for this attempt");
      const why = row.revoked_at_ms !== null ? "it was revoked" : row.expires_at_ms <= now ? "it expired" : !attemptHoldsFence(this.store, attemptId, row.job_fence) ? "its attempt no longer holds its fence" : undefined;
      if (why) {
        if (row.revoked_at_ms === null) this.store.control.prepare("UPDATE secret_credentials SET revoked_at_ms=?, revoked_reason=? WHERE id=? AND revoked_at_ms IS NULL").run(now, row.expires_at_ms <= now ? "expired" : "fence", id);
        throw this.refuse({ organizationId: row.organization_id, workspaceId: row.workspace_id, attemptId }, why, row.ref, id);
      }
    }
  }

  private refuse(scope: Scope, why: string, ref: string, credentialId?: string): BrainDomainError {
    this.event(scope, "secret.refused", { attemptId: scope.attemptId, ref, reason: why, ...(credentialId ? { credentialId } : {}) });
    return new BrainDomainError("FORBIDDEN", `the secret credential was refused: ${why}`);
  }

  private event(scope: Scope, eventType: string, payload: Record<string, unknown>): void {
    this.store.emit(this.store.control, { organizationId: scope.organizationId, workspaceId: scope.workspaceId, aggregateType: "attempt", aggregateId: scope.attemptId, eventType, payload: payload as never, destinations: [`workspace:${scope.workspaceId}`] });
  }
}
