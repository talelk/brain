import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { runCli } from "../../apps/cli/src/client";

// `brain audit` against an in-process Governor: the CLI only speaks HTTP, exports the logs, and verifies them locally (ADR 0078).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-cli-audit-"));
  const app = await createApp({ dataDir: join(root, "data") });
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const env: NodeJS.ProcessEnv = { BRAIN_GOVERNOR_URL: "http://127.0.0.1:3000", BRAIN_CLI_STATE_DIR: join(root, "state"), BRAIN_EMAIL: "cli@example.test", BRAIN_PASSWORD: "cli-test-password-123" };
  let output = ""; let errors = "";
  const run = async (args: string[]) => { output = ""; errors = ""; return runCli(args, { env, fetch: async (request) => app.fetch(request), stdout: (text) => { output += text; }, stderr: (text) => { errors += text; } }); };
  expect(await run(["setup", "--local", "--org", "org-cli", "--name", "CLI", "--setup-token-file", join(root, "data", "setup.token"), "--json"])).toBe(0);
  const token = (await import("../../apps/cli/src/credentials")).credentialStore("http://127.0.0.1:3000", env).read();
  const { actor } = await app.brain.resolveActor(new Headers({ authorization: `Bearer ${token}` }));
  app.brain.createWorkspace(actor, { workspaceId: "ws-cli", slug: "cli" });
  for (let i = 0; i < 3; i++) {
    const created = { contractVersion: "brain.command/v1", commandType: "mission.create", commandId: `cmd-${i}`, idempotencyKey: `create-${i}`, workspaceId: "ws-cli", payload: { title: `Mission ${i}`, intent: "audit proof", successCriteria: ["checked by an independent evaluator"] } };
    expect(await run(["command", JSON.stringify(created), "--json"])).toBe(0);
  }
  return { root, app, run, output: () => output, errors: () => errors };
}

describe("brain audit", () => {
  it("verifies a healthy Governor, and says what it checked and what it did not pin", async () => {
    const x = await fixture();
    expect(await x.run(["audit", "checkpoint"])).toBe(0);
    expect(x.output()).toMatch(/^Signed 2 checkpoints/u);
    expect(await x.run(["audit", "verify"])).toBe(0);
    expect(x.output()).toMatch(/^OK: \d+ events in 2 logs verified; 2 signed checkpoints hold \(keys taken from the export, not pinned\)\./u);
    expect(await x.run(["audit", "verify", "--json"])).toBe(0);
    expect(JSON.parse(x.output())).toMatchObject({ ok: true, keysPinned: false });
  });

  it("exports to a private file that verifies offline, and an edit to that file is found where it is", async () => {
    const x = await fixture();
    await x.run(["audit", "checkpoint"]);
    const file = join(x.root, "export.json");
    expect(await x.run(["audit", "export", "--out", file])).toBe(0);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(await x.run(["audit", "verify", "--file", file])).toBe(0);
    const text = JSON.parse(readFileSync(file, "utf8")) as { chains: Array<{ scope: string; events: Array<{ chainSeq: number; payloadJson: string }> }> };
    const control = text.chains.find((c) => c.scope === "workspace:ws-cli")!;
    control.events[2]!.payloadJson = control.events[2]!.payloadJson.replace("{", '{"forged":true,');
    writeFileSync(file, JSON.stringify(text));
    expect(await x.run(["audit", "verify", "--file", file])).toBe(1);
    expect(x.errors()).toContain("BROKEN: payload-edited in log workspace:ws-cli at event 3");
    expect(x.errors()).toMatch(/\d+ of \d+ events were verified before the break\./u);
  });

  it("reports a change made in the live database, from the HTTP export alone", async () => {
    const x = await fixture();
    const db = x.app.brain.store.workspaceDb("ws-cli", "org-cli");
    const victim = db.prepare("SELECT event_id, chain_seq FROM events ORDER BY cursor LIMIT 1 OFFSET 1").get() as { event_id: string; chain_seq: number };
    db.prepare("UPDATE events SET event_type='mission.deleted' WHERE event_id=?").run(victim.event_id);
    expect(await x.run(["audit", "verify"])).toBe(1);
    expect(x.errors()).toContain(`event-edited in log workspace:ws-cli at event ${victim.chain_seq} (${victim.event_id})`);
    expect(await x.run(["audit", "verify", "--json"])).toBe(1);
    expect(JSON.parse(x.output())).toMatchObject({ ok: false, break: { kind: "event-edited", chain: "workspace:ws-cli", chainSeq: victim.chain_seq } });
  });

  it("pins keys from a file, follows a rotation, and refuses keys it was not given", async () => {
    const x = await fixture();
    await x.run(["audit", "checkpoint"]);
    const keys = join(x.root, "keys.json");
    expect(await x.run(["audit", "keys", "--out", keys])).toBe(0);
    expect(await x.run(["audit", "rotate-key"])).toBe(0);
    expect(x.output()).toMatch(/^Retired ak-[0-9a-f]{16}; the audit key is now ak-[0-9a-f]{16}/u);
    await x.run(["audit", "checkpoint"]);
    expect(await x.run(["audit", "verify", "--trust-key", keys])).toBe(0);
    expect(x.output()).toContain("keys pinned by you");
    writeFileSync(keys, JSON.stringify({ keys: [] }));
    expect(await x.run(["audit", "verify", "--trust-key", keys])).toBe(0); // an empty pin file pins nothing: the run says so
    expect(x.output()).toContain("not pinned");
    const mallory = (await import("node:crypto")).generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const { auditKeyId } = await import("@brain/contracts");
    writeFileSync(keys, JSON.stringify({ keys: [{ keyId: auditKeyId(mallory), publicKey: mallory }] }));
    expect(await x.run(["audit", "verify", "--trust-key", keys])).toBe(1);
    expect(x.errors()).toContain("checkpoint-unknown-key");
  });

  it("is refused for someone who is not signed in as an administrator, and explains usage", async () => {
    const x = await fixture();
    expect(await x.run(["audit"])).toBe(2);
    expect(x.errors()).toContain("brain audit verify");
    expect(await x.run(["logout", "--json"])).toBe(0);
    expect(await x.run(["audit", "verify"])).toBe(1);
  });
});
