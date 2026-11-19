import { generateKeyPairSync } from "node:crypto";
import { signStoreGrant } from "@brain/contracts";
import { afterAll } from "vitest";
import { startStore } from "../../apps/store/src/store";
import { tempDir } from "./git-repo";

/** A git store for one test file (apps/store), with the key that signs its tokens. It stops when the tests of the file are over. */
export async function testStore() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const root = tempDir("store");
  const store = await startStore({ root, publicKeyPem: () => publicKey.export({ type: "spki", format: "pem" }).toString() }, 0, "127.0.0.1");
  afterAll(() => store.close());
  const url = `http://127.0.0.1:${store.port}`;
  return {
    url, root, privateKeyPem,
    /** What an offer carries for one attempt of a goal. */
    offer: (workspaceId: string, goalId: string, attemptId: string, expiresAt = Math.floor(Date.now() / 1000) + 3600) => ({ url, goalId, token: signStoreGrant({ workspaceId, goalId, attemptId, expiresAt }, privateKeyPem) }),
  };
}
