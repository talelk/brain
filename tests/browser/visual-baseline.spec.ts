/**
 * Visual baselines for the key screens at 1440-light, 768-light and 390-dark.
 *
 * UPDATING THESE SNAPSHOTS IS A DELIBERATE ACT. A diff here means the UI changed: look at the actual
 * and diff images in test-results/, decide the change is intended, then regenerate with
 *   TMPDIR=$HOME/.cache/bt npx playwright test tests/browser/visual-baseline.spec.ts \
 *     --project=1440-light --project=768-light --project=390-dark --update-snapshots
 * and commit the new PNGs in tests/browser/visual-baseline.spec.ts-snapshots/ in the same change as
 * the UI work. Never refresh them just to make a red run green. Comparisons allow 2% of pixels to
 * differ (seeded timestamps and ids vary per run); they run on the seeded workspace from
 * tests/support/browserDemo.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";
import { sendTaskBack } from "../support/evalCases";

type Demo = Awaited<ReturnType<typeof seedBrowserDemo>>;
type Fixture = Parameters<typeof seedBrowserDemo>[1];

/** A finished one-task mission with a submitted bundle, made when its screen is reached so no earlier screen changes. */
async function signOffRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: demo.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const version = async (id: string) => ((await brain.executeQuery(demo.actor, { queryType: "missions.get", workspaceId: demo.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot.version;
  const missionId = (await cmd("mission.create", "baseline-signoff-create", { title: "Compile the quarterly report", intent: "Compile the quarterly report", successCriteria: ["The report is complete", "Every figure cites its source"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "baseline-signoff-plan", { missionId, origin: "manual", tasks: [{ id: "compile", title: "Compile the figures", criteria: ["Figures compiled"], dependsOn: [], criterionIds: ["c1"] }] })).resourceId ?? "";
  await cmd("plan.confirm", "baseline-signoff-confirm", { planVersionId: planId }, await version(missionId));
  // The finished task's verified evidence has one check that names the first criterion; the second criterion is served by no task, so it shows as not linked.
  const ws = brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId);
  const evidence = `sha256:${"9".repeat(64)}`;
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)")
    .run(evidence, "bundle-baseline", "job-baseline", "att-baseline", JSON.stringify({ checks: [{ criterionId: "c1", checkId: "figures-reconcile", status: "passed" }] }), brain.store.now());
  ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(evidence, missionId);
  await cmd("mission.proposeCompletion", "baseline-signoff-finish", { missionId }, await version(missionId));
  return `/missions/${missionId}/outputs`;
}

/** A browser that can receive notifications (headless Chromium has permission denied and no push service): asked never, or turned on for this device. */
async function pushDevice(page: Page, on: boolean): Promise<void> {
  await page.addInitScript((subscribed) => {
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => (subscribed ? "granted" : "default") });
    const device = { endpoint: "http://127.0.0.1:9/push/baseline", toJSON: () => ({}), unsubscribe: async () => true };
    PushManager.prototype.getSubscription = async () => (subscribed ? (device as unknown as PushSubscription) : null);
  }, on);
}

const SCREENS: Array<{ id: string; route: (demo: Demo, governor: Fixture) => string | Promise<string>; heading: string | RegExp; testid?: string; waitFor?: string; prepare?: (governor: Parameters<typeof seedBrowserDemo>[1], page: Page, demo: Demo) => Promise<void>; after?: (page: Page) => Promise<void> }> = [
  { id: "missions", route: () => "/w/operations/missions", heading: "Missions" },
  { id: "mission-plan", route: (d) => `/missions/${d.seed.missionIds.active}/plan`, heading: "Stabilize authentication" },
  { id: "mission-live", route: (d) => `/missions/${d.seed.missionIds.active}/live`, heading: "Stabilize authentication" },
  { id: "plays", route: () => "/w/operations/plays?mode=catalog", heading: "Plays" },
  { id: "live", route: () => "/w/operations/live", heading: "Sessions & runs", testid: "console-rail" },
  { id: "logs", route: () => "/w/operations/logs", heading: "Logs" },
  { id: "outputs", route: () => "/w/operations/outputs", heading: "All results" },
  { id: "approvals", route: () => "/approvals", heading: "Approvals" },
  { id: "approval-review", route: (d) => `/approvals/${d.seed.approvalId}`, heading: "Approval review" },
  { id: "runners", route: () => "/runners", heading: "Runners" },
  { id: "today-fleet", route: () => "/w/operations/today", heading: "Today", after: async (page) => { const fleet = page.getByTestId("fleet-overview"); await expect(fleet).toBeVisible(); await expect(page.getByTestId("fleet-spend-today")).toBeVisible(); await fleet.evaluate((element) => element.scrollIntoView({ block: "center" })); } },
  { id: "runner-detail", route: (d) => `/runners/${d.seed.runnerId}`, heading: "runner-demo" },
  { id: "settings-setup", route: () => "/settings?tab=setup", heading: "Setup" },
  { id: "settings-work", route: () => "/settings?tab=work", heading: "How work runs" },
  { id: "settings-health", route: () => "/settings?tab=health", heading: "Health", prepare: seedBackupRecords },
  { id: "settings-egress", route: () => "/settings?tab=work", heading: "How work runs", after: async (page) => { const egress = page.locator("[data-work-egress]"); await expect(egress).toBeVisible(); await egress.scrollIntoViewIfNeeded(); } },
  { id: "knowledge", route: () => "/w/operations/knowledge", heading: "Knowledge" },
  { id: "integrations", route: () => "/administration/integrations", heading: "Integrations" },
  { id: "integrations-connect", route: () => "/administration/integrations", heading: "Integrations", after: async (page) => { await page.getByRole("button", { name: "Connect remote", exact: true }).first().click(); await expect(page.getByRole("dialog").getByLabel(/^Git provider/)).toBeVisible(); } },
  { id: "mission-task-comments", route: (d) => `/missions/${d.seed.missionIds.active}/plan?item=${d.seed.workItems["in-progress"]}`, heading: "Comments", prepare: seedTaskComments, after: async (page) => { await page.getByRole("heading", { name: "Comments", level: 4 }).evaluate((element) => element.scrollIntoView({ block: "start" })); } },
  // Eval cases come late, because the cases are recorded by sending tasks back, which adds missions the screens above would show.
  { id: "eval-cases", route: () => "/w/operations/quality/cases", heading: "Eval cases", prepare: seedEvalCases },
  // Last of all: the sign-off mission adds an attention item every earlier screen would count in its bell.
  { id: "mission-signoff", route: signOffRoute, heading: "Compile the quarterly report", waitFor: "mission-signoff" },
  // Push: the offer on Needs you (this device could receive notifications and was never asked), then the settings control once it is on.
  { id: "today-push-offer", route: () => "/w/operations/today", heading: "Today", prepare: async (_governor, page) => pushDevice(page, false), after: async (page) => { const offer = page.getByTestId("push-offer"); await expect(offer).toBeVisible(); await offer.scrollIntoViewIfNeeded(); } },
  { id: "settings-push-device", route: () => "/settings?tab=security", heading: "Security", prepare: async (_governor, page) => pushDevice(page, true), after: async (page) => { const control = page.getByTestId("push-device"); await expect(control).toContainText("Notifications are on for this device."); await control.scrollIntoViewIfNeeded(); } },
  // A ticket trigger on the Schedules screen: its card, then the editor with the subject choice and the plan explanation (ticket #122).
  { id: "schedules-subject-trigger", route: () => "/w/operations/schedules", heading: "Schedules", prepare: seedSubjectTrigger, after: async (page) => { await expect(page.locator("article").filter({ hasText: "Draft a reply to every new ticket" }).getByTestId("subject-plan-summary")).toBeVisible(); } },
  { id: "schedules-subject-editor", route: () => "/w/operations/schedules", heading: "Schedules", after: async (page) => {
    await page.getByRole("button", { name: "New schedule", exact: true }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Trigger", { exact: true }).click();
    await page.getByRole("option", { name: "When a new ticket or incident arrives", exact: true }).click();
    await expect(sheet.getByTestId("subject-plan")).toBeVisible();
  } },
];

/** Health with a fresh backup and a passed restore test, recorded the way the host's jobs record them; `restoreBackupRecords` puts the environment back. */
const BACKUP_ENV = ["BRAIN_BACKUP_STAMP_FILE", "BRAIN_RESTORE_TEST_FILE"] as const;
const backupEnvBefore = Object.fromEntries(BACKUP_ENV.map((key) => [key, process.env[key]]));
let backupRecordsDir: string | undefined;
async function seedBackupRecords(governor: Parameters<typeof seedBrowserDemo>[1]): Promise<void> {
  backupRecordsDir = mkdtempSync(join(tmpdir(), "brain-visual-backups-"));
  writeFileSync(join(backupRecordsDir, "last-backup-ok"), String(Math.floor(Date.now() / 1000) - 5 * 3600));
  writeFileSync(join(backupRecordsDir, "last-restore-test.json"), JSON.stringify({ ok: true, backup: "brain-20261110.tar.enc", databases: 4, seconds: 42, at: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
  process.env["BRAIN_BACKUP_STAMP_FILE"] = join(backupRecordsDir, "last-backup-ok");
  process.env["BRAIN_RESTORE_TEST_FILE"] = join(backupRecordsDir, "last-restore-test.json");
  // The seeded runner reports in only for a moment after the seed; Health lists runners and the launcher only while one is online, so keep it online for this screen.
  governor.app.brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=?").run(governor.app.brain.store.now());
  await governor.app.brain.runEngineProbes((async () => new Response("{}")) as unknown as typeof fetch);
}
function restoreBackupRecords(): void {
  for (const key of BACKUP_ENV) {
    if (backupEnvBefore[key] === undefined) delete process.env[key];
    else process.env[key] = backupEnvBefore[key];
  }
  if (backupRecordsDir) rmSync(backupRecordsDir, { recursive: true, force: true });
}

/** A person's comment on a task and the correction of it, through the same command the screen sends. */
async function seedTaskComments(governor: Parameters<typeof seedBrowserDemo>[1], page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }), "operations")).actor;
  const workItemId = demo.seed.workItems["in-progress"];
  const comment = async (key: string, payload: Record<string, unknown>): Promise<string> => (await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workItem.comment", workspaceId: "operations", idempotencyKey: key, payload: { workItemId, ...payload } } as never, key)).receipt.resourceId ?? "";
  const first = await comment("vb-comment-1", { text: "Use the existing sessions table, not a new one." });
  await comment("vb-comment-2", { text: "Use the existing sessions table and keep its index; do not add a new one.", correctionOf: first });
}

/** A ticket trigger, made through the command the Schedules screen sends. */
async function seedSubjectTrigger(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Demo): Promise<void> {
  await governor.app.brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: "cmd-vb-subject-trigger", commandType: "automation.upsert", workspaceId: demo.workspaceId, idempotencyKey: "vb-subject-trigger",
    payload: { title: "Draft a reply to every new ticket", target: { kind: "play", id: "support-reply-draft" }, trigger: { kind: "subject", subjectKind: "ticket" } },
  } as never, "vb-subject-trigger");
}

async function seedEvalCases(governor: Parameters<typeof seedBrowserDemo>[1], page: Page): Promise<void> {
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }), "operations")).actor;
  await sendTaskBack(brain, actor, "operations", { key: "vb1", title: "Quarterly churn report", finding: "Cause two had no cited source" });
  await sendTaskBack(brain, actor, "operations", { key: "vb2", title: "Refund summary", finding: "The refund total does not add up" });
}

test.afterEach(() => restoreBackupRecords());

test("key screens match their visual baselines", async ({ page, governor }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const demo = await seedBrowserDemo(page, governor);
  for (const screen of SCREENS) {
    await screen.prepare?.(governor, page, demo);
    await page.goto(`${governor.url}${await screen.route(demo, governor)}`);
    const landmark = screen.testid
      ? page.getByTestId(screen.testid).getByRole("heading", { name: screen.heading })
      : page.getByRole("heading", { name: screen.heading }).first();
    await expect(landmark.first()).toBeVisible({ timeout: 20_000 });
    // A screen with a named region is shot scrolled to it, so the region itself is what the baseline holds.
    if (screen.waitFor) {
      await expect(page.getByTestId(screen.waitFor)).toBeVisible({ timeout: 20_000 });
      await page.getByTestId(screen.waitFor).evaluate((element) => element.scrollIntoView({ block: "center" }));
    }
    await screen.after?.(page);
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`${screen.id}.png`, { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });
  }
});
