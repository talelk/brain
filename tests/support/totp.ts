// Independent RFC 6238 test oracle. Production TOTP verification belongs only
// to the pinned Better Auth plugin, not this fixture utility.
import { createHmac, randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = 0; let value = 0; let out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("bad base32");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpCode(secretBase32: string, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = (((mac[offset] ?? 0) & 0x7f) << 24) | ((mac[offset + 1] ?? 0) << 16) | ((mac[offset + 2] ?? 0) << 8) | (mac[offset + 3] ?? 0);
  return String(code % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secretBase32: string, code: string, atMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (const drift of [-30_000, 0, 30_000]) {
    if (totpCode(secretBase32, atMs + drift) === code) return true;
  }
  return false;
}
