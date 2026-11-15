import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One push message as the browser would read it: the RFC 8291 payload decrypted with the device's own key. */
export interface ReceivedPush { title: string; body: string; url?: string }
export interface RawPush { headers: IncomingHttpHeaders; body: Buffer }

/** Reads an aes128gcm push body with the receiver's private key (independent of the sender's code). */
export function decryptPush(body: Buffer, receiverPrivate: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const serverPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const shared = receiverPrivate.computeSecret(serverPublic);
  const authInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), receiverPrivate.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, authInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Strip RFC 8188 padding: the 0x02 delimiter is the last non-zero byte.
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (plain[end - 1] !== 0x02) throw new Error("push payload has no padding delimiter");
  return plain.subarray(0, end - 1).toString("utf8");
}

export interface PushReceiver {
  /** What a browser's `PushSubscription.toJSON()` carries: a local endpoint and a real P-256 key with its auth secret. */
  subscription: { endpoint: string; p256dh: string; auth: string };
  /** Every request the push service received, raw, and the readable messages among them. */
  requests: RawPush[];
  messages: ReceivedPush[];
  /** Answers the next requests with this status (a gone endpoint is 410). */
  respondWith(status: number): void;
  close(): Promise<void>;
}

/** A local push service plus the device behind it: the receiving end of every push test. */
export async function startPushReceiver(path = "/push/device"): Promise<PushReceiver> {
  const receiverKey = createECDH("prime256v1");
  receiverKey.generateKeys();
  const authSecret = randomBytes(16);
  const requests: RawPush[] = [];
  const messages: ReceivedPush[] = [];
  let status = 201;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ headers: request.headers, body });
      if (status < 300) { try { messages.push(JSON.parse(decryptPush(body, receiverKey, authSecret)) as ReceivedPush); } catch { /* an undecryptable body is counted in requests only */ } }
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    subscription: { endpoint: `http://127.0.0.1:${port}${path}`, p256dh: receiverKey.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") },
    requests, messages,
    respondWith: (next) => { status = next; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
