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
  const missionId = (await cmd("mission.create", "baseline-signoff-create", { title: "Compile the quarterly report", intent: "Compile the quarterly report", successCriteria: ["The report is complete"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "baseline-signoff-plan", { missionId, origin: "manual", tasks: [{ id: "compile", title: "Compile the figures", criteria: ["Figures compiled"], dependsOn: [] }] })).resourceId ?? "";
  await cmd("plan.confirm", "baseline-signoff-confirm", { planVersionId: planId }, await version(missionId));
  brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId).prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(`sha256:${"9".repeat(64)}`, missionId);
  await cmd("mission.proposeCompletion", "baseline-signoff-finish", { missionId }, await version(missionId));
  return `/missions/${missionId}/outputs`;
}

const SCREENS: Array<{ id: string; route: (demo: Demo, governor: Fixture) => string | Promise<string>; heading: string | RegExp; testid?: string; waitFor?: string; prepare?: (governor: Parameters<typeof seedBrowserDemo>[1], page: Page) => Promise<void>; after?: (page: Page) => Promise<void> }> = [
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
  { id: "runner-detail", route: (d) => `/runners/${d.seed.runnerId}`, heading: "runner-demo" },
  { id: "settings-setup", route: () => "/settings?tab=setup", heading: "Setup" },
  { id: "settings-work", route: () => "/settings?tab=work", heading: "How work runs" },
  { id: "settings-egress", route: () => "/settings?tab=work", heading: "How work runs", after: async (page) => { const egress = page.locator("[data-work-egress]"); await expect(egress).toBeVisible(); await egress.scrollIntoViewIfNeeded(); } },
  { id: "knowledge", route: () => "/w/operations/knowledge", heading: "Knowledge" },
  { id: "integrations", route: () => "/administration/integrations", heading: "Integrations" },
  { id: "integrations-connect", route: () => "/administration/integrations", heading: "Integrations", after: async (page) => { await page.getByRole("button", { name: "Connect remote", exact: true }).first().click(); await expect(page.getByRole("dialog").getByLabel(/^Git provider/)).toBeVisible(); } },
  // Eval cases come late, because the cases are recorded by sending tasks back, which adds missions the screens above would show.
  { id: "eval-cases", route: () => "/w/operations/quality/cases", heading: "Eval cases", prepare: seedEvalCases },
  // Last of all: the sign-off mission adds an attention item every earlier screen would count in its bell.
  { id: "mission-signoff", route: signOffRoute, heading: "Compile the quarterly report", waitFor: "mission-signoff" },
];

async function seedEvalCases(governor: Parameters<typeof seedBrowserDemo>[1], page: Page): Promise<void> {
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }), "operations")).actor;
  await sendTaskBack(brain, actor, "operations", { key: "vb1", title: "Quarterly churn report", finding: "Cause two had no cited source" });
  await sendTaskBack(brain, actor, "operations", { key: "vb2", title: "Refund summary", finding: "The refund total does not add up" });
}

test("key screens match their visual baselines", async ({ page, governor }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const demo = await seedBrowserDemo(page, governor);
  for (const screen of SCREENS) {
    await screen.prepare?.(governor, page);
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
