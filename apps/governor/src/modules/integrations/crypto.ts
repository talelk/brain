import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface GitCredentialMaterial {
  readonly username?: string;
  readonly token?: string;
}

function key(pepper: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", pepper, Buffer.from("brain:git-credentials:v1"), Buffer.from("integration-secret-encryption"), 32));
}

export function encryptGitCredentials(pepper: Uint8Array, organizationId: string, connectionId: string, material: GitCredentialMaterial): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(pepper), iv);
  cipher.setAAD(Buffer.from(`${organizationId}\n${connectionId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(material), "utf8")), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ciphertext.toString("base64url") });
}

export function decryptGitCredentials(pepper: Uint8Array, organizationId: string, connectionId: string, encrypted: string): GitCredentialMaterial {
  const parsed = JSON.parse(encrypted) as { v: number; iv: string; tag: string; ct: string };
  if (parsed.v !== 1) throw new Error("unsupported Git credential encryption version");
  const decipher = createDecipheriv("aes-256-gcm", key(pepper), Buffer.from(parsed.iv, "base64url"));
  decipher.setAAD(Buffer.from(`${organizationId}\n${connectionId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as GitCredentialMaterial;
}
