import { createECDH, createSign, generateKeyPairSync, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Web Push delivery (T45): RFC 8291 aes128gcm payload encryption + RFC 8292
// VAPID voluntary identification, implemented on node:crypto. The VAPID
// private key is generated once and kept in a 0600 file in the data
// directory; subscriptions are per-principal rows the browser registers
// after explicit notification permission.
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  publicKey: string; // base64url uncompressed P-256 point
  privateKeyPkcs8: string; // base64 DER, file-only
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function loadOrCreateVapidKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, "push-vapid.json");
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const keys: VapidKeys = {
    publicKey: b64url(point),
    privateKeyPkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64"),
  };
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function vapidJwt(keys: VapidKeys, endpoint: string, subject: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const aud = new URL(endpoint).origin;
  const claims = b64url(Buffer.from(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const keyObject = { key: Buffer.from(keys.privateKeyPkcs8, "base64"), format: "der" as const, type: "pkcs8" as const };
  // JOSE ES256 requires the raw r||s signature form.
  const signature = signer.sign({ ...keyObject, dsaEncoding: "ieee-p1363" } as never);
  return `${signingInput}.${b64url(Buffer.from(signature as unknown as Buffer))}`;
}

export function encryptPayload(subscription: PushSubscriptionRecord, payload: Buffer): Buffer {
  const clientPublic = Buffer.from(subscription.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.auth, "base64url");
  if (clientPublic.length !== 65 || clientPublic[0] !== 0x04) throw new Error("invalid p256dh key");
  if (authSecret.length < 16) throw new Error("invalid auth secret");
  const salt = randomBytes(16);
  const serverEcdh = createECDH("prime256v1");
  serverEcdh.generateKeys();
  const serverPublic = serverEcdh.getPublicKey();
  const shared = serverEcdh.computeSecret(clientPublic);
  const authInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, authInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const padded = Buffer.concat([payload, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([serverPublic.length]), serverPublic, ciphertext]);
}

// At-rest protection for subscription material: AES-256-GCM under a key
// derived from the server pepper with a push-specific purpose, so a copied
// control.db alone does not expose push endpoints/keys.
function subscriptionKey(pepper: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", pepper, Buffer.from("brain:push:v1"), Buffer.from("subscription-encryption"), 32));
}

export function encryptSubscription(pepper: Uint8Array, sub: PushSubscriptionRecord): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subscriptionKey(pepper), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(sub), "utf8")), cipher.final()]);
  return JSON.stringify({
    v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ct.toString("base64url"),
  });
}

export function decryptSubscription(pepper: Uint8Array, encrypted: string): PushSubscriptionRecord {
  const parsed = JSON.parse(encrypted) as { v: number; iv: string; tag: string; ct: string };
  if (parsed.v !== 1) throw new Error("unsupported subscription encryption version");
  const decipher = createDecipheriv("aes-256-gcm", subscriptionKey(pepper), Buffer.from(parsed.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
  const pt = Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64url")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as PushSubscriptionRecord;
}

export async function sendPush(
  keys: VapidKeys,
  subscription: PushSubscriptionRecord,
  payload: { title: string; body: string; url?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number }> {
  const body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload), "utf8"));
  const subject = process.env["BRAIN_VAPID_SUBJECT"] ?? "mailto:brain-operations@localhost";
  const jwt = vapidJwt(keys, subscription.endpoint, subject);
  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      "ttl": "3600",
      "urgency": "normal",
      "authorization": `vapid t=${jwt}, k=${keys.publicKey}`,
    },
    body: body as BodyInit,
  });
  return { status: res.status };
}
