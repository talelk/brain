import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RedactedDiagnostics } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { JobProtocol } from "../../apps/governor/src/modules/jobs/index";
import { recordProbe } from "../../apps/governor/src/modules/operations/index";
import { fixtureStarter } from "../support/starter";
import { observation, registerRunner } from "../support/runnerHello";
import { command } from "../support/reuse";
import { setupWorld, type TestWorld } from "../helpers";

// The diagnostics bundle (spec #90, story 96) and what Health says about backups (story 97), reached through the Governor's own seams:
// commands to make state, the runner protocol to register runners and fail an attempt, platform.health for the Health tab, and the
// /v1/diagnostics route (same handler the Download button calls).
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "brain-diag-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

const ENV_KEYS = ["BRAIN_BACKUP_STAMP_FILE", "BRAIN_RESTORE_TEST_FILE", "BRAIN_BACKUP_STALE_SECONDS", "BRAIN_RESTORE_TEST_STALE_SECONDS"] as const;
async function withEnv<T>(values: Partial<Record<(typeof ENV_KEYS)[number] | string, string>>, run: () => Promise<T> | T): Promise<T> {
  const before = Object.fromEntries([...ENV_KEYS, ...Object.keys(values)].map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return await run(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;
type Services = Array<{ id: string; status: string; detail: string; checkedAt: string }>;
async function health(w: TestWorld): Promise<{ status: string; services: Services }> {
  await w.brain.runEngineProbes(fakeFetch);
  return ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { status: string; services: Services } }).snapshot;
}
const line = async (w: TestWorld, id: string) => (await health(w)).services.find((service) => service.id === id)!;
const hoursAgo = (hours: number) => Math.floor(Date.now() / 1000) - hours * 3600;

function world(): TestWorld {
  const w = setupWorld();
  cleanup.push(() => w.brain.close());
  return w;
}

describe("backup and restore-test status in Health", () => {
  it("says plainly that nothing is tracked, and never shows an untracked backup as healthy", async () => {
    const w = world();
    await withEnv({}, async () => {
      expect(await line(w, "backup")).toMatchObject({ status: "disabled", detail: expect.stringContaining("BRAIN_BACKUP_STAMP_FILE") });
      expect(await line(w, "restore-test")).toMatchObject({ status: "disabled", detail: expect.stringContaining("BRAIN_RESTORE_TEST_FILE") });
    });
  });

  it("shows a fresh backup and a passed restore test as healthy, with their age and what was restored", async () => {
    const w = world();
    const dir = temp();
    writeFileSync(join(dir, "stamp"), String(hoursAgo(5)));
    writeFileSync(join(dir, "restore.json"), JSON.stringify({ ok: true, backup: "brain-20261110T0230Z.tar.enc", databases: 4, seconds: 42, at: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
    await withEnv({ BRAIN_BACKUP_STAMP_FILE: join(dir, "stamp"), BRAIN_RESTORE_TEST_FILE: join(dir, "restore.json") }, async () => {
      expect(await line(w, "backup")).toMatchObject({ status: "healthy", detail: "The last backup finished 5 hours ago." });
      expect(await line(w, "restore-test")).toMatchObject({ status: "healthy", detail: "The last restore test passed 3 days ago: 4 databases in 42 seconds restored and checked." });
      expect((await health(w)).status).toBe("healthy");
    });
  });

  it("flags a stale backup as degraded and a long-missing one as unavailable, and tells the owner once", async () => {
    const w = world();
    const dir = temp();
    const stamp = join(dir, "stamp");
    await withEnv({ BRAIN_BACKUP_STAMP_FILE: stamp }, async () => {
      writeFileSync(stamp, String(hoursAgo(50)));
      const stale = await health(w);
      expect(stale.services.find((service) => service.id === "backup")).toMatchObject({ status: "degraded", detail: expect.stringContaining("2 days ago, past the 36 hours limit (stale)") });
      expect(stale.status).toBe("degraded");
      writeFileSync(stamp, String(hoursAgo(130)));
      expect(await line(w, "backup")).toMatchObject({ status: "unavailable", detail: expect.stringContaining("no recent copy to restore from") });
      writeFileSync(stamp, String(hoursAgo(1)));
      expect(await line(w, "backup")).toMatchObject({ status: "healthy" });
    });
    const notices = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT title FROM attention_notifications WHERE item_id='platform:backup'").all() as Array<{ title: string }>;
    expect(notices.map((row) => row.title).join(" ")).toContain("The last backup is stale");
  });

  it("honours a stale limit the operator sets", async () => {
    const w = world();
    const dir = temp();
    writeFileSync(join(dir, "stamp"), String(hoursAgo(5)));
    await withEnv({ BRAIN_BACKUP_STAMP_FILE: join(dir, "stamp"), BRAIN_BACKUP_STALE_SECONDS: String(3 * 3600) }, async () => {
      expect(await line(w, "backup")).toMatchObject({ status: "degraded", detail: expect.stringContaining("past the 3 hours limit") });
    });
  });

  it("warns when nothing was ever recorded, instead of passing", async () => {
    const w = world();
    const dir = temp();
    await withEnv({ BRAIN_BACKUP_STAMP_FILE: join(dir, "missing-stamp"), BRAIN_RESTORE_TEST_FILE: join(dir, "missing.json") }, async () => {
      expect(await line(w, "backup")).toMatchObject({ status: "degraded", detail: expect.stringContaining("No successful backup has been recorded yet") });
      expect(await line(w, "restore-test")).toMatchObject({ status: "degraded", detail: expect.stringContaining("No restore test has been recorded yet") });
    });
  });

  it("shows a failed restore test as unavailable and a missed month as stale", async () => {
    const w = world();
    const dir = temp();
    const file = join(dir, "restore.json");
    await withEnv({ BRAIN_RESTORE_TEST_FILE: file }, async () => {
      writeFileSync(file, JSON.stringify({ ok: false, backup: "brain-1.tar.enc", databases: 1, seconds: 3, at: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
      expect(await line(w, "restore-test")).toMatchObject({ status: "unavailable", detail: expect.stringContaining("failed. Backups may not restore") });
      writeFileSync(file, JSON.stringify({ ok: true, backup: "brain-1.tar.enc", databases: 2, seconds: 3, at: new Date(Date.now() - 60 * 86_400_000).toISOString() }));
      expect(await line(w, "restore-test")).toMatchObject({ status: "degraded", detail: expect.stringContaining("passed 60 days ago, past the 40 days limit (stale)") });
      writeFileSync(file, "not json");
      expect(await line(w, "restore-test")).toMatchObject({ status: "degraded", detail: expect.stringContaining("could not be read") });
    });
  });
});

describe("the diagnostics bundle", () => {
  const admin = (w: TestWorld) => w.owner;
  const bundle = (w: TestWorld): RedactedDiagnostics => w.brain.diagnostics(admin(w), w.workspaceId, "corr-diagnostics-1");

  it("carries versions, readiness, backup status and the runner inventory exactly as reported, and validates against its contract", async () => {
    const w = world();
    const starter = fixtureStarter();
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
    const seen = new Date(Date.now() - 60_000).toISOString();
    const digest = `sha256:${"c".repeat(64)}`;
    registerRunner(w.brain, w.owner, "runner-versioned", { engines: [{ id: "pi", version: "0.9.1", adapterDigest: digest, features: ["steer", "resume"] }], capabilities: [observation("os:linux", seen)] });
    registerRunner(w.brain, w.owner, "runner-unversioned", { engines: [{ id: "acp", adapterDigest: digest, features: [] }], capabilities: [observation("os:linux", seen)] });
    const dir = temp();
    writeFileSync(join(dir, "stamp"), String(hoursAgo(50)));
    const result = await withEnv({ BRAIN_BACKUP_STAMP_FILE: join(dir, "stamp") }, async () => { await w.brain.runEngineProbes(fakeFetch); return bundle(w); });

    expect(validate("RedactedDiagnostics", result)).toEqual({ ok: true, errors: [] });
    const governorPackage = JSON.parse(readFileSync(join(process.cwd(), "apps/governor/package.json"), "utf8")) as { version: string };
    expect(result).toMatchObject({ format: "brain.redacted-diagnostics/v2", correlationId: "corr-diagnostics-1", workspaceId: w.workspaceId, configDigest: expect.stringMatching(/^sha256:/u), versions: { governor: governorPackage.version, node: process.version, commandContract: "brain.command/v1", runnerContract: "brain.runner/v1" } });
    expect(result.versions.controlSchema).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.versions.sqlite).toMatch(/^\d+\.\d+/u);
    expect(result.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["release", "smoke"]));
    // Backups: the stale stamp is in the bundle with its age, the untracked restore test says so.
    expect(result.backups.backup).toMatchObject({ status: "degraded", ageSeconds: expect.any(Number) });
    expect(result.backups.backup.ageSeconds).toBeGreaterThan(49 * 3600);
    expect(result.backups.restoreTest).toMatchObject({ status: "disabled", lastAt: null });
    expect(result.backups.replica.status).toBe("disabled");
    // Runners: what each reported and nothing filled in; the engine that stated no version has no version key.
    const byId = new Map(result.runners.map((runner) => [runner.runnerId, runner]));
    expect(byId.get("runner-versioned")?.engines).toEqual([{ id: "pi", version: "0.9.1", adapterDigest: digest, features: ["steer", "resume"] }]);
    expect(byId.get("runner-unversioned")?.engines).toEqual([{ id: "acp", adapterDigest: digest, features: [] }]);
    expect(Object.keys(byId.get("runner-unversioned")!.engines[0]!)).not.toContain("version");
    expect(byId.get("runner-versioned")?.capabilities).toEqual([expect.objectContaining({ capability: "os:linux", source: "runner-probe", observedAt: seen })]);
    // The stale backup is among the recent errors as a health check, with its sentence.
    expect(result.recentErrors).toContainEqual(expect.objectContaining({ source: "health-check", code: "backup", status: "degraded" }));
  });

  it("lists failed tasks and ended-badly attempts as classes, codes and ids, never their text", async () => {
    const w = world();
    await command(w, w.owner, "workflow.dispatch", "diag-dispatch", { workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: "diag" } });
    const { runnerId, epoch } = registerRunner(w.brain, w.owner, "runner-fails", {
      engines: [{ id: "fixture", adapterDigest: `sha256:${"d".repeat(64)}`, features: [] }],
      capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"].map((capability) => observation(capability, new Date(Date.now() - 60_000).toISOString())),
    }, "fixture-tools");
    const protocol = new JobProtocol(w.brain.store, {
      completeStep: () => undefined, evaluatorEligible: () => true, runnerCurrent: () => true, activeRelease: () => undefined,
      resolveWorkflow: () => ({ workflow: {}, configDigest: `sha256:${"0".repeat(64)}` }), startRun: () => ({ runId: "unused" }),
    });
    const runner = { runnerId, epoch, organizationId: w.org };
    const offer = protocol.claim(runner, "req-diag") as { attemptId: string; jobId: string; leaseId: string; jobFence: number };
    protocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    const privateText = "the Q3 layoff list for Dana Whitfield";
    protocol.complete(runner, offer.attemptId, { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { error: `model is unreachable: ECONNREFUSED while handling ${privateText}` } });

    const result = bundle(w);
    expect(result.recentErrors).toContainEqual(expect.objectContaining({ source: "attempt", code: "model-unreachable", status: "failed", jobId: offer.jobId, attemptId: offer.attemptId, workspaceId: w.workspaceId }));
    expect(JSON.stringify(result)).not.toContain(privateText);
  });

  it("refuses everyone who is not an organization administrator", () => {
    const w = world();
    expect(() => w.brain.diagnostics({ ...w.owner, kind: "agent" }, w.workspaceId, "c")).toThrow(/organization administration/u);
    expect(() => w.brain.diagnostics({ ...w.owner, scopes: w.owner.scopes.filter((scope) => scope !== "runner:admin") }, w.workspaceId, "c")).toThrow(/organization administration/u);
  });
});

describe("planted secrets never reach the bundle", () => {
  it("holds none of the credentials, tokens, keys or private content planted around the Governor", async () => {
    const planted = {
      hostedKey: "sk-planted-hosted-0123456789abcdef",
      memoryKey: "tdai-planted-memory-key-9f8e7d6c5b4a",
      smtpPassword: "planted-smtp-password-4471",
      authSecret: "planted-auth-secret-8c2b19e07a5d44f3",
      metricsToken: "planted-metrics-token-3b7f0c91d2e8a645",
      missionTitle: "Acquire Northwind Traders before the announcement",
      missionIntent: "Quietly buy the Northwind supplier list for the board",
      criterion: "Offer price stays under the confidential 41 million ceiling",
      probeLeak: "Bearer planted0leaked0bearer0token123456",
    };
    const dir = temp();
    writeFileSync(join(dir, "metrics-token"), `${planted.metricsToken}\n`, { mode: 0o600 });
    const secretEnv = {
      BRAIN_HOSTED_MODEL_API_KEY: planted.hostedKey, BRAIN_TENCENTDB_API_KEY: planted.memoryKey, BRAIN_AUTH_SECRET: planted.authSecret,
      BRAIN_NOTIFY_SMTP_URL: `smtp://notifier:${planted.smtpPassword}@mail.invalid:587`, BRAIN_METRICS_TOKEN_FILE: join(dir, "metrics-token"),
    };
    await withEnv(secretEnv, async () => {
      const app = await createApp({ dataDir: join(dir, "data"), allowTestActor: true });
      cleanup.push(() => app.close());
      const w = setupWorld(app.brain);
      app.brain.ensurePrincipal(w.org, "agent-1", "agent");
      await command(w, w.owner, "mission.create", "diag-secret-mission", { title: planted.missionTitle, intent: planted.missionIntent, successCriteria: [planted.criterion] });
      // Credentials the Governor itself holds: a runner's enrollment token and the credential it was issued, a session token.
      const { token } = w.brain.jobProtocol.issueEnrollment(w.owner, "fixture-tools");
      const { publicKey } = generateKeyPairSync("ed25519");
      const { credential } = w.brain.jobProtocol.enrollRunner({ token, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), runnerId: "runner-enrolled" });
      // A health sentence that picked up a credential on its way in is redacted before it leaves.
      recordProbe(w.brain.store, "model", "unavailable", `The model endpoint answered with ${planted.probeLeak} in its error`);

      const direct = JSON.stringify(w.brain.diagnostics(w.owner, w.workspaceId, "corr-secrets"));
      const response = await app.fetch(new Request(`http://127.0.0.1:3000/v1/diagnostics?workspaceId=${w.workspaceId}`, { headers: { "x-brain-test-actor": `owner-1:${w.org}` } }));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(validate("RedactedDiagnostics", JSON.parse(text))).toEqual({ ok: true, errors: [] });

      for (const body of [direct, text]) {
        for (const [name, value] of Object.entries({ ...planted, token, credential, sessionToken: w.ownerToken, ...secretEnv })) {
          expect(body, `the bundle holds ${name}`).not.toContain(value);
        }
        expect(body).not.toContain("planted0leaked0bearer0token");
        expect(body).toContain("[hidden]");
      }
      // Someone who is not an organization administrator gets nothing.
      const agent = await app.fetch(new Request(`http://127.0.0.1:3000/v1/diagnostics?workspaceId=${w.workspaceId}`, { headers: { "x-brain-test-actor": `agent-1:${w.org}` } }));
      expect(agent.status).toBe(403);
    });
  });
});
