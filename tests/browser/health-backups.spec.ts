import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { enrollRunners, signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";

// Spec #90 stories 96 and 97, walked as a first-time administrator: Health says honestly that backups are not tracked, warns when the
// last backup is stale, shows the last backup and the last restore test when they are fine, flags a failed restore test, and the
// diagnostics download holds the bundle (versions, runners as reported, readiness, backups, recent errors) with no credential or private text.
const KEYS = ["BRAIN_BACKUP_STAMP_FILE", "BRAIN_RESTORE_TEST_FILE"] as const;
const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;

test("Health shows the last backup and restore test, flags a stale backup, and the diagnostics download is redacted", async ({ page, governor }, info) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "brain-health-backups-"));
  try {
    for (const key of KEYS) delete process.env[key];
    const { brain, actor, cookie } = await signUpOwner(page, governor, "backups");
    await page.getByLabel("Display name").fill("Backups workspace");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
    const starter = fixtureStarter();
    brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
    await enrollRunners(governor, actor, "backups");
    const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
    const inWorkspace = (await brain.resolveActor(new Headers({ cookie }), workspaceId)).actor;
    await brain.executeCommand(inWorkspace, { contractVersion: "brain.command/v1", commandId: "cmd-private", commandType: "mission.create", workspaceId, idempotencyKey: "private-mission", payload: { title: "Northwind takeover plan", intent: "Quietly buy the Northwind supplier list", successCriteria: ["Offer stays under the confidential ceiling"] } }, "private-mission");
    const refresh = async () => { await brain.runEngineProbes(fakeFetch); await page.reload(); await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible(); };
    const card = (name: string) => page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });

    // From the menu, as a person would: Administration, then Health.
    const openNav = async () => { const toggle = page.getByRole("button", { name: "Open application navigation", exact: true }); if (await toggle.isVisible()) await toggle.click(); };
    await openNav();
    await page.getByRole("navigation", { name: "Brain navigation" }).getByRole("button", { name: "Administration", exact: true }).click();
    await openNav();
    await page.getByRole("navigation", { name: "Brain navigation" }).getByRole("button", { name: "Health", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible();

    // 1. Nothing is tracked yet: both lines say so, and neither pretends to be fine.
    await expect(card("Last backup")).toContainText("Backups are not tracked here");
    await expect(card("Last restore test")).toContainText("Restore tests are not tracked here");

    // 2. The host's backup job is wired up but its last backup is two days old: stale, flagged, and the verdict names it.
    process.env["BRAIN_BACKUP_STAMP_FILE"] = join(dir, "last-backup-ok");
    process.env["BRAIN_RESTORE_TEST_FILE"] = join(dir, "last-restore-test.json");
    writeFileSync(join(dir, "last-backup-ok"), String(Math.floor(Date.now() / 1000) - 50 * 3600));
    await refresh();
    await expect(card("Last backup")).toContainText("finished 2 days ago, past the 36 hours limit (stale)");
    await expect(card("Last backup").getByText("Degraded", { exact: true })).toBeVisible();
    await expect(card("Last restore test")).toContainText("No restore test has been recorded yet");
    await expect(page.getByText("Something needs attention", { exact: true })).toBeVisible();
    await expect(page.getByText(/Last backup, Last restore test are not healthy/)).toBeVisible();
    await info.attach("health-stale-backup", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // 3. A restore rehearsal that failed is the loudest line.
    writeFileSync(join(dir, "last-restore-test.json"), JSON.stringify({ ok: false, backup: "brain-20261110.tar.enc", databases: 1, seconds: 4, at: new Date().toISOString() }));
    await refresh();
    await expect(card("Last restore test")).toContainText("failed. Backups may not restore");

    // 4. A fresh backup and a passed restore test: both healthy, with their age and what was restored.
    writeFileSync(join(dir, "last-backup-ok"), String(Math.floor(Date.now() / 1000) - 5 * 3600));
    writeFileSync(join(dir, "last-restore-test.json"), JSON.stringify({ ok: true, backup: "brain-20261110.tar.enc", databases: 4, seconds: 42, at: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
    await refresh();
    await expect(card("Last backup")).toContainText("The last backup finished 5 hours ago.");
    await expect(card("Last restore test")).toContainText("passed 3 days ago: 4 databases in 42 seconds restored and checked.");
    await expect(card("Last backup").getByText("Healthy", { exact: true })).toBeVisible();

    // 5. The diagnostics download: the bundle says what it holds and holds no credential, token or private text.
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download diagnostics", exact: true }).click();
    const download = await downloading;
    const path = info.outputPath("diagnostics.json");
    await download.saveAs(path);
    await expect(page.getByRole("status").filter({ hasText: "Downloaded the diagnostics bundle" })).toContainText("Credentials, tokens, messages, task text and raw logs are left out.");
    const text = readFileSync(path, "utf8");
    const bundle = JSON.parse(text) as { format: string; versions: { governor: string }; runners: Array<{ runnerId: string; engines: Array<{ id: string; adapterDigest: string }> }>; backups: { backup: { status: string }; restoreTest: { status: string; backup?: string } }; checks: unknown[]; services: Array<{ id: string }> };
    expect(bundle.format).toBe("brain.redacted-diagnostics/v2");
    expect(bundle.versions.governor).toMatch(/^\d+\.\d+/u);
    expect(bundle.runners.map((runner) => runner.runnerId).sort()).toEqual(["backups-agents", "backups-evaluators"]);
    expect(bundle.runners[0]!.engines[0]).toMatchObject({ id: "fixture", adapterDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
    expect(bundle.backups).toMatchObject({ backup: { status: "healthy" }, restoreTest: { status: "healthy", backup: "brain-20261110.tar.enc" } });
    expect(bundle.checks.length).toBeGreaterThan(0);
    expect(bundle.services.map((service) => service.id)).toEqual(expect.arrayContaining(["backup", "restore-test"]));
    const cookies = (await page.context().cookies()).map((entry) => entry.value);
    for (const secret of ["browser-password-1234", governor.credential, "Northwind", ...cookies]) expect(text, `the bundle holds ${secret.slice(0, 12)}`).not.toContain(secret);
  } finally {
    for (const key of KEYS) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
