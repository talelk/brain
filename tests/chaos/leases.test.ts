import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { domainDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, DIGEST_A } from "../helpers";

const run = promisify(execFile);

describe("lease contention across processes (T18)", () => {
  it("exactly one of three concurrent runner processes wins the single queued job; a second Governor on the data dir is refused", async () => {
    const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-lease-")), allowTestActor: true });
    const server = createAdaptorServer({ fetch: (r) => app.fetch(r) });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const brain = app.brain;
      const w = setupWorld(brain);
      const digest = brain.activeRelease(w.org)!.digest;
      brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: "cmd-lease", commandType: "workflow.dispatch",
        workspaceId: w.workspaceId, idempotencyKey: "lease-1",
        payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "contended" } },
      }, "lease");
      const tokens: string[] = [];
      for (const runnerId of ["runner-l1", "runner-l2", "runner-l3"]) {
        const { token } = brain.issueEnrollment(w.owner, "fixture-tools");
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
        const { credential } = brain.enrollRunner({ token, publicKeyPem: pem, runnerId });
        const chal = brain.runnerChallenge(runnerId, credential);
        const body: Record<string, unknown> = {
          contractVersion: "brain.runner/v1", runnerId, bootNonce: `boot-${runnerId}`, configDigest: DIGEST_A,
          capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 1 },
          capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]
            .map((capability) => ({ capability, verified: true, source: "runner-probe" })),
        };
        const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
        const signed = JSON.stringify({ challengeId: chal.challengeId, nonce: chal.nonce, runnerId, bootNonce: body["bootNonce"], helloDigest });
        const signatureBase64url = sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url");
        const session = brain.runnerHello({ ...body, proof: { challengeId: chal.challengeId, signatureBase64url } });
        tokens.push(session.sessionToken);
      }
      const children = await Promise.all(tokens.map(async (token, i) => {
        const { stdout } = await run("pnpm", ["exec", "tsx", "tests/support/claim-once.ts", url, token, `req-lease-${i}`], { cwd: process.cwd(), timeout: 120_000 });
        return JSON.parse(stdout) as { status: number; attemptId: string | null };
      }));
      expect(children.filter((c) => c.status === 200 && c.attemptId)).toHaveLength(1);
      expect(children.filter((c) => c.status === 204)).toHaveLength(2);
      // The single-Governor topology is enforced: a second Brain process on
      // the same data directory is refused by the directory lock.
      const { Brain } = await import("../../apps/governor/src/application/brain");
      expect(() => new Brain({ dataDir: brain.store.dataDir, allowTestActor: true })).toThrow(/in use/);
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    }
  }, 180_000);
});
