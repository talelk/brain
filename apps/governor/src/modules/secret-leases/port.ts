/**
 * The secrets adapter port (ADR 0065). The one seam between Brain and wherever a secret really lives: the Governor's own encrypted store,
 * a file on the Governor host, or a vault a deployment plugs in. An adapter only turns a reference into material for one scope; the
 * Governor's broker owns everything about the lease (binding to an attempt and fence, lifetime, revocation, audit), so a replacement
 * adapter cannot weaken it. No vendor SDK belongs here.
 */
export interface SecretScope {
  readonly organizationId: string;
  readonly workspaceId: string;
}

export interface SecretMaterial {
  readonly value: string;
  /** An adapter that mints a genuinely short-lived upstream credential says when it dies; the broker never lets a lease outlive it. */
  readonly expiresAtMs?: number;
}

export interface SecretsAdapter {
  readonly id: string;
  /** Whether this adapter owns the reference's name space. The broker asks its adapters in order and the first that serves it resolves it. */
  serves(ref: string): boolean;
  /**
   * The material behind a reference in this scope, or undefined when the scope has no such secret. `notAfterMs` is when the lease ends:
   * an adapter that can issue a credential for exactly that long should. Never logs or caches the value.
   */
  resolve(scope: SecretScope, ref: string, notAfterMs: number): SecretMaterial | undefined;
}
