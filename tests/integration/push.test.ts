import { createDecipheriv, createECDH, createVerify, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { setupWorld } from "../helpers";

// T45: Web Push round-trip against a local mock push service. The receiver
// side below is an independent RFC 8291 decryption (not shared code with the
// sender), and the VAPID JWT is verified against the advertised public key.
let server: Server | undefined;
let brain: Brain | undefined;
afterEach(async () => {
  brain?.close(); brain = undefined;
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

function decryptPush(body: Buffer, receiverPrivate: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const serverPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const shared = receiverPrivate.computeSecret(serverPublic);
  const receiverPublic = receiverPrivate.getPublicKey();
  const authInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), receiverPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, authInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const pt = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Strip RFC 8188 padding: find the 0x02 delimiter from the end.
  let end = pt.length;
  while (end > 0 && pt[end - 1] === 0) end -= 1;
  expect(pt[end - 1]).toBe(0x02);
  return pt.subarray(0, end - 1).toString("utf8");
}

describe("web push delivery (T45)", () => {
  it("registers, encrypts, signs and delivers; gone endpoints are revoked", async () => {
    brain = new Brain({ dataDir: mkdtempSync(join(tmpdir(), "brain-push-")), allowTestActor: true });
    const w = setupWorld(brain);

    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const authSecret = randomBytes(16);
    const captured: Array<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
    let respondGone = false;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c as Buffer)));
      req.on("end", () => {
        captured.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.statusCode = respondGone ? 410 : 201;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const endpoint = `http://127.0.0.1:${port}/push/abc`;

    const { subscriptionId } = brain.registerPushSubscription(w.owner, {
      endpoint,
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: authSecret.toString("base64url"),
    });
    expect(subscriptionId).toBeTruthy();
    // Stored material is encrypted at rest, never the raw endpoint/keys.
    const stored = brain.store.control.prepare("SELECT encrypted_endpoint_json FROM notification_subscriptions WHERE id=?").get(subscriptionId) as { encrypted_endpoint_json: string };
    expect(stored.encrypted_endpoint_json).not.toContain(endpoint);
    expect(stored.encrypted_endpoint_json).not.toContain(authSecret.toString("base64url"));

    const delivered = await brain.notifyPrincipal(w.org, "owner-1", { title: "Approval requested", body: "Gate waiting", url: "/#/approvals" });
    expect(delivered).toBe(1);
    expect(captured).toHaveLength(1);
    const plain = decryptPush(captured[0]!.body, receiver, authSecret);
    expect(JSON.parse(plain)).toMatchObject({ title: "Approval requested", body: "Gate waiting" });

    // VAPID JWT verifies against the advertised public key with our audience.
    const authHeader = String(captured[0]!.headers["authorization"]);
    const jwt = /t=([^,]+)/u.exec(authHeader)?.[1] ?? "";
    const advertisedKey = /k=([A-Za-z0-9_-]+)/u.exec(authHeader)?.[1] ?? "";
    expect(jwt).toBeTruthy();
    expect(advertisedKey).toBeTruthy();
    expect(advertisedKey).toBe(brain.vapidPublicKey());
    const [h, c, sig] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString("utf8")) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe(`http://127.0.0.1:${port}`);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const point = Buffer.from(advertisedKey, "base64url");
    const jwk = {
      kty: "EC", crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url"),
    };
    const { createPublicKey } = await import("node:crypto");
    const verify = createVerify("SHA256");
    verify.update(`${h}.${c}`);
    verify.end();
    expect(verify.verify({ key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);

    // A 410 from the push service revokes the subscription.
    respondGone = true;
    await brain.notifyPrincipal(w.org, "owner-1", { title: "Again", body: "gone" });
    const after = brain.store.control.prepare("SELECT revoked_at_ms FROM notification_subscriptions WHERE id=?").get(subscriptionId) as { revoked_at_ms: number | null };
    expect(after.revoked_at_ms).not.toBeNull();
    expect(await brain.notifyPrincipal(w.org, "owner-1", { title: "Third", body: "nobody" })).toBe(0);
  }, 120_000);
});
