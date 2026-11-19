import { sign as edSign, verify as edVerify } from "node:crypto";

/**
 * The token that lets one attempt use the git store (docs/architecture.md, section 8). The Governor signs it with an ed25519 key and puts it in
 * the offer; the store checks it with the public key alone, so the two never talk to each other. This file is the one definition: the Governor
 * signs with it and the store verifies with it.
 */
export interface StoreGrant {
  /** The workspace whose repositories the token reads. */
  readonly workspaceId: string;
  /** The goal (root task) the token writes under, and the attempt it was made for: it creates refs `refs/brain/<goalId>/<commit>`, each once, and no other. */
  readonly goalId: string;
  readonly attemptId: string;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

/** The attempt a token is made for when it asks the store to forget a goal (docs/architecture.md, section 8: retention). */
export const STORE_RETENTION_ATTEMPT = "retention";

const DOMAIN = "brain:store-token:v1\n";
const bytes = (grant: StoreGrant): Buffer => Buffer.from(JSON.stringify([grant.workspaceId, grant.goalId, grant.attemptId, grant.expiresAt]));

export function signStoreGrant(grant: StoreGrant, privateKeyPem: string): string {
  const signature = edSign(null, Buffer.concat([Buffer.from(DOMAIN), bytes(grant)]), privateKeyPem);
  return `${bytes(grant).toString("base64url")}.${signature.toString("base64url")}`;
}

/** The grant a token carries when its signature is the public key's and it has not expired; undefined otherwise. */
export function readStoreGrant(token: string, publicKeyPem: string, nowSeconds: number): StoreGrant | undefined {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return undefined;
  try {
    const raw = Buffer.from(body, "base64url");
    if (!edVerify(null, Buffer.concat([Buffer.from(DOMAIN), raw]), publicKeyPem, Buffer.from(signature, "base64url"))) return undefined;
    const [workspaceId, goalId, attemptId, expiresAt] = JSON.parse(raw.toString("utf8")) as unknown[];
    if (typeof workspaceId !== "string" || typeof goalId !== "string" || typeof attemptId !== "string" || typeof expiresAt !== "number") return undefined;
    return expiresAt > nowSeconds ? { workspaceId, goalId, attemptId, expiresAt } : undefined;
  } catch { return undefined; }
}
