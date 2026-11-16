import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The runner's ed25519 key (`runner.key.pem`): made on the first start, enrolled once, and the key every receipt is signed with. */
export interface RunnerKeys { readonly privateKeyPem: string; readonly publicKeyPem: string }

export function loadOrCreateKeys(stateDir: string): RunnerKeys {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "runner.key.pem");
  if (!existsSync(path)) writeFileSync(path, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  const privateKeyPem = readFileSync(path, "utf8");
  return { privateKeyPem, publicKeyPem: createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString() };
}

/** The proof of a hello: the challenge's nonce signed with the enrolled key (base64url). */
export const signNonce = (nonce: string, privateKeyPem: string): string => sign(null, Buffer.from(nonce, "utf8"), privateKeyPem).toString("base64url");

/** The runner's credential (`credential`): the id the Governor gave it at enrolment. Absent until the runner has enrolled. */
export function readCredential(stateDir: string): string | undefined {
  const path = join(stateDir, "credential");
  if (!existsSync(path)) return undefined;
  const runnerId = (JSON.parse(readFileSync(path, "utf8")) as { runnerId?: unknown }).runnerId;
  return typeof runnerId === "string" && runnerId ? runnerId : undefined;
}

export function writeCredential(stateDir: string, runnerId: string): void {
  writeFileSync(join(stateDir, "credential"), JSON.stringify({ runnerId }), { mode: 0o600 });
}
