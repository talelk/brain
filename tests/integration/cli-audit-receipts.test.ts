import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECEIPT_EVENT, runnerKeyId, signReceipt, type AuditEventRecord } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { credentialStore } from "../../apps/cli/src/credentials";
import { runCli } from "../../apps/cli/src/client";
import { enrollAndHello, loadOrCreateKeys } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { rechain, withPayload } from "../support/audit-forge";
import { receiptFor } from "../support/signed-completion";

// `brain audit verify` checks the signed run receipts too (ADR 0078, #153), against an in-process Governor, over HTTP only.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-cli-receipts-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const w = setupWorld(app.brain);
  const origin = "http://127.0.0.1:3000";
  const env: NodeJS.ProcessEnv = { BRAIN_GOVERNOR_URL: origin, BRAIN_CLI_STATE_DIR: join(root, "state") };
  credentialStore(origin, env).save(w.ownerToken);
  let output = ""; let errors = "";
  const run = async (args: string[]) => { output = ""; errors = ""; return runCli(args, { env, fetch: async (request) => app.fetch(request), stdout: (text) => { output += text; }, stderr: (text) => { errors += text; } }); };

  const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
  const cfg = { runnerId: "cli-runner", governorUrl: origin, stateDir: join(root, "runner"), transport, engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
  const hello = await enrollAndHello(cfg, app.brain.jobProtocol.issueEnrollment(w.owner, "fixture-tools").token);
  const keys = loadOrCreateKeys(cfg.stateDir);
  const runner = { runnerId: cfg.runnerId, epoch: hello.epoch, organizationId: w.org };
  const digest = app.brain.activeRelease(w.org)!.digest;
  expect((await app.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-cli-receipt", commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: "cli-receipt", payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } } } as never, "cli-receipt")).receipt.accepted).toBe(true);
  const offer = app.brain.jobProtocol.claim(runner, "claim-cli-receipt") as unknown as { attemptId: string; leaseId: string; jobFence: number };
  app.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  const receipt = receiptFor(app.brain, runner, offer.attemptId, { result: "succeeded" }, runnerKeyId(keys.publicKeyPem))!;
  app.brain.jobProtocol.complete(runner, offer.attemptId, { result: "succeeded", output: { message: "Brain fixture", bytes: 13 }, jobFence: offer.jobFence, cleanupConfirmed: true, receipt, signature: signReceipt(receipt, keys.privateKeyPem) });
  return { root, run, output: () => output, errors: () => errors, attemptId: offer.attemptId };
}

describe("brain audit verify and signed receipts", () => {
  it("verifies a Governor whose attempt was receipted by its runner", async () => {
    const x = await fixture();
    expect(await x.run(["audit", "verify"])).toBe(0);
    expect(x.output()).toMatch(/^OK \(hash chain only\): \d+ events in 2 logs/u);
  });

  it("exports the runner's key and its receipt, and finds a receipt altered after signing in a file whose digests were all recomputed", async () => {
    const x = await fixture();
    const file = join(x.root, "export.json");
    expect(await x.run(["audit", "export", "--out", file])).toBe(0);
    const exported = JSON.parse(readFileSync(file, "utf8")) as { organizationId: string; chains: Array<{ scope: string; events: AuditEventRecord[] }> };
    const control = exported.chains.find((c) => c.scope === "control")!;
    expect(control.events.some((e) => e.eventType === "runner.keyEnrolled")).toBe(true);
    expect(control.events.some((e) => e.eventType === RECEIPT_EVENT && e.aggregateId === x.attemptId)).toBe(true);
    expect(await x.run(["audit", "verify", "--file", file])).toBe(0);

    const at = control.events.findIndex((e) => e.eventType === RECEIPT_EVENT);
    control.events = rechain(exported.organizationId, "control", control.events.map((e, i) => i === at ? withPayload(e, (p) => { (p["receipt"] as { outcome: string }).outcome = "failed"; }) : e));
    writeFileSync(file, JSON.stringify(exported));
    expect(await x.run(["audit", "verify", "--file", file])).toBe(1);
    expect(x.errors()).toContain(`BROKEN: event-check in log control at event ${at + 1}`);
    expect(x.errors()).toContain(`run receipt: the receipt of attempt ${x.attemptId} does not carry a valid signature from runner cli-runner`);
    expect(x.errors()).toMatch(/\d+ of \d+ events were verified before the break\./u);
  });
});
