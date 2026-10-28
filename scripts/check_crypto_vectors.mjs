// Public RFC 8032 test key, not a runner credential or production signing key.
import { readFileSync } from 'node:fs';
import { createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import assert from 'node:assert/strict';
const vectors = JSON.parse(readFileSync(new URL('../contracts/v1/crypto-vectors.json', import.meta.url), 'utf8'));
const v = vectors.ed25519;
const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + v.seedHex, 'hex'), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey({ key: Buffer.from('302a300506032b6570032100' + v.publicKeyHex, 'hex'), format: 'der', type: 'spki' });
const message = Buffer.from(v.messageHex, 'hex');
const signature = Buffer.from(v.signatureHex, 'hex');
assert.equal(sign(null, message, privateKey).toString('hex'), v.signatureHex);
assert.equal(verify(null, message, publicKey, signature), true);
assert.equal(verify(null, Buffer.from('changed'), publicKey, signature), false);
const p = vectors.permitHmac;
const token = createHmac('sha256', Buffer.from(p.keyHex, 'hex'))
  .update(p.domain + '\0' + p.permitId + '\0' + p.nonce).digest('base64url');
assert.equal(token, p.tokenBase64url);
console.log('RFC8032 sign/verify/tamper and opaque permit derivation vectors passed');
