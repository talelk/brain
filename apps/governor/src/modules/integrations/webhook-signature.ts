import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed inbound webhooks (ADR 0077): the secret of an endpoint is stored encrypted under its own key label (never the Git credential label),
 * and each provider's own signature scheme is checked over the raw bytes before anything is parsed. Every refusal is the same answer.
 */
export const WEBHOOK_WINDOW_MS = 5 * 60_000;
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

function key(pepper: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", pepper, Buffer.from("brain:webhook-secret:v1"), Buffer.from("webhook-secret-encryption"), 32));
}

export function encryptWebhookSecret(pepper: Uint8Array, organizationId: string, endpointId: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(pepper), iv);
  cipher.setAAD(Buffer.from(`${organizationId}\n${endpointId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secret, "utf8")), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ciphertext.toString("base64url") });
}

export function decryptWebhookSecret(pepper: Uint8Array, organizationId: string, endpointId: string, encrypted: string): string {
  const parsed = JSON.parse(encrypted) as { v: number; iv: string; tag: string; ct: string };
  if (parsed.v !== 1) throw new Error("unsupported webhook secret encryption version");
  const decipher = createDecipheriv("aes-256-gcm", key(pepper), Buffer.from(parsed.iv, "base64url"));
  decipher.setAAD(Buffer.from(`${organizationId}\n${endpointId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64url")), decipher.final()]).toString("utf8");
}

/** Constant time whatever the lengths: both sides are hashed first, so a wrong-length value costs the same as a wrong-content one. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

const hmacHex = (secret: string, data: string | Buffer): string => createHmac("sha256", secret).update(data).digest("hex");

/** GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`. GitHub signs no timestamp. */
export function verifyGithubSignature(secret: string, headers: Headers, raw: Buffer): boolean {
  return sameSecret(headers.get("x-hub-signature-256") ?? "", `sha256=${hmacHex(secret, raw)}`);
}

/** GitLab: `X-Gitlab-Token` carries the secret itself. */
export function verifyGitlabToken(secret: string, headers: Headers): boolean {
  return sameSecret(headers.get("x-gitlab-token") ?? "", secret);
}

/** Brain's own scheme for the generic ticket webhook: `x-brain-signature: sha256=<hex of "<timestamp>.<body>">` inside a 5 minute window. */
export function verifyBrainSignature(secret: string, headers: Headers, raw: Buffer, nowMs: number): boolean {
  const stamp = headers.get("x-brain-timestamp") ?? "";
  const timestamp = Number(stamp);
  const fresh = stamp !== "" && Number.isFinite(timestamp) && Math.abs(nowMs - timestamp * 1000) <= WEBHOOK_WINDOW_MS;
  const expected = `sha256=${hmacHex(secret, Buffer.concat([Buffer.from(`${stamp}.`), raw]))}`;
  return sameSecret(headers.get("x-brain-signature") ?? "", expected) && fresh;
}

/** Used for an unknown endpoint so it costs the same work and gives the same answer as a wrong signature. */
export const DECOY_SECRET = "decoy-secret-for-unknown-endpoints";
