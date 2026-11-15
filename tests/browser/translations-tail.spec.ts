import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { seedBrowserDemo } from "../support/browserDemo";

const PHONE = { width: 390, height: 844 };
const BIDI = "[\\u200e\\u200f\\u061c\\u202a-\\u202e\\u2066-\\u2069]";

/** The page reads right to left through the document direction alone, fits the phone, and its heading starts at the right edge. */
async function expectRightToLeft(page: Page, heading: string): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const title = page.getByRole("heading", { level: 1, name: heading, exact: true });
  await expect(title).toBeVisible({ timeout: 30_000 });
  const box = (await title.boundingBox())!;
  expect(PHONE.width - (box.x + box.width), `"${heading}" starts at the right edge`).toBeLessThan(box.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `no sideways scroll on "${heading}"`).toBe(true);
  if (process.env["BRAIN_SHOTS"]) await page.screenshot({ path: `${process.env["BRAIN_SHOTS"]}/ar-${heading.replace(/\s+/gu, "-")}.png`, fullPage: true });
  expect(await page.evaluate((pattern) => [...document.body.innerText].filter((character) => new RegExp(pattern, "u").test(character)).length, BIDI), "no bidi marks in the page").toBe(0);
}

/**
 * The translation tail (backlog row 67): Administration, Library tools, the Plan stage, Quality, Schedules and Health read in
 * Arabic, right to left, on a phone. English copy left on these screens would put punctuation on the wrong side, so each is
 * checked for the words that used to be English.
 */
test.describe("Arabic on a phone", () => {
  test.use({ appLocale: "ar", viewport: PHONE });
  test("Administration, Health, Quality, Schedules, the Plan stage and Library tools read right to left", async ({ page, governor }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const demo = await seedBrowserDemo(page, governor);
    const now = governor.app.brain.store.now();
    const db = governor.app.brain.store.workspaceDb(demo.workspaceId, "org-demo");
    db.prepare("UPDATE work_items SET parked=1, state='blocked', failure_class='missing-tool', parked_diagnostic='x', updated_at_ms=? WHERE id=?").run(now, demo.seed.workItems.blocked);

    await page.goto(`${governor.url}/settings?tab=health`);
    await expectRightToLeft(page, "الحالة الصحية");
    await expect(page.getByText("الخدمات", { exact: true })).toBeVisible();
    await expect(page.getByText("خادم Brain")).toBeVisible();
    for (const english of ["Everything is working", "Something needs attention", "Recent activity in this workspace"]) await expect(page.getByText(english)).toHaveCount(0);

    await page.goto(`${governor.url}/settings?tab=work`);
    await expectRightToLeft(page, "كيف يعمل العمل");
    await expect(page.locator("[data-work-hosted]")).toContainText("لا توجد مسارات نماذج بعد");
    await expect(page.getByText("Model routes")).toHaveCount(0);

    await page.goto(`${governor.url}/settings?tab=policy`);
    await expectRightToLeft(page, "المصادقة");
    await expect(page.getByText("تسجيل الدخول الموحد للشركة").first()).toBeVisible();

    await page.goto(`${governor.url}/settings?tab=setup`);
    await expectRightToLeft(page, "الإعداد");

    await page.goto(`${governor.url}/quality`);
    await expectRightToLeft(page, "الجودة");
    await expect(page.locator('[data-metric="verified-unaided"]')).toContainText("تم التحقق منه دون مساعدة بشرية");
    await expect(page.locator('[data-failure-code="missing-tool"]')).toContainText("احتاجت المهمة إلى أداة");
    await expect(page.getByText("Definition")).toHaveCount(0);

    await page.goto(`${governor.url}/w/${demo.workspaceId}/schedules`);
    await expectRightToLeft(page, "الجداول الزمنية");
    await expect(page.getByText("New schedule")).toHaveCount(0);

    await page.goto(`${governor.url}/w/${demo.workspaceId}/knowledge?tab=tools`);
    await expect(page.getByText("سجل القدرات الموثوقة").first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "no sideways scroll on the tools tab").toBe(true);
    await expect(page.getByText("Trusted capability registry")).toHaveCount(0);

    // While a plan is drafted the page names the stage in Arabic.
    await page.route("**/v1/plans/*?workspaceId=*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ missionId: demo.seed.missionIds.active, runId: "run-x", state: "running", stage: "drafting" }) }));
    await page.goto(`${governor.url}/missions/${demo.seed.missionIds.active}/plan`);
    await expect(page.getByText("صياغة الخطوات...", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Drafting the steps")).toHaveCount(0);
    await expect(page.getByText("عمل المهمة").first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "no sideways scroll on the plan stage").toBe(true);
    await expect(page.getByText("Mission work", { exact: true })).toHaveCount(0);
    // The stopped task says why, in Arabic.
    await page.getByRole("button", { name: "Manage Collect production traces", exact: true }).click();
    await expect(page.locator("[data-task-failure-sentence]")).toHaveText("احتاجت المهمة إلى أداة لا تتوفر في طريقة العمل المحددة لها");
    await expect(page.locator("[data-task-failure-fix]")).toContainText("الحل");
    expect(errors).toEqual([]);
  });

  test("an effect approval card reads right to left on a phone", async ({ page, governor }) => {
    test.setTimeout(120_000);
    const demo = await seedBrowserDemo(page, governor);
    const brain = governor.app.brain;
    brain.ensurePrincipal("org-demo", "phone-requester", "human");
    const subject = { organizationId: "org-demo", workspaceId: demo.workspaceId, operation: "host.restart", tool: { id: "host.restart", digest: `sha256:${"a".repeat(64)}` }, inputDigest: `sha256:${"a".repeat(64)}`,
      target: { targetId: "web-1", environmentId: "demo-host", preconditionDigest: `sha256:${"a".repeat(64)}` }, artifactDigest: `sha256:${"a".repeat(64)}`, policyDigest: `sha256:${"a".repeat(64)}`, configDigest: `sha256:${"a".repeat(64)}`,
      effectBounds: { summary: "Restart the web-1 container", arguments: { container: "web-1" } }, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), nonce: "ar-card" };
    const approvalId = brain.createApprovalForGate({ organizationId: "org-demo", workspaceId: demo.workspaceId, runId: "ar-run", stepId: "ar", subject: subject as never, expiresAtMs: Date.now() + 1_800_000, requestedBy: "phone-requester" });
    await page.goto(`${governor.url}/approvals/${approvalId}`);
    const card = page.locator("[data-approval-card]");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(card).toContainText("ما الذي سيحدث");
    await expect(card).toContainText("الهدف بالضبط");
    await expect(page.getByRole("button", { name: "موافقة", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "رفض", exact: true })).toBeVisible();
    // The exact review that opens from the card speaks Arabic too.
    await page.getByRole("button", { name: "موافقة", exact: true }).click();
    const review = page.getByRole("dialog");
    await expect(review).toContainText("تفويض الإجراء");
    await expect(review.getByRole("button", { name: "الموافقة على الإجراء بدقة", exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "طلب تعديلات", exact: true })).toBeVisible();
    await expect(review.getByText("Approve exact action")).toHaveCount(0);
    await expect(review.getByText("Request changes")).toHaveCount(0);
    await review.getByRole("button", { name: "رجوع", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    // The card's text starts at the right edge.
    const what = (await card.locator("[data-approval-what]").boundingBox())!;
    expect(PHONE.width - (what.x + what.width)).toBeLessThan(what.x + 16);
  });
});

test.describe("French on a phone", () => {
  test.use({ appLocale: "fr", viewport: PHONE });
  test("the same screens read in French without sideways scroll", async ({ page, governor }) => {
    test.setTimeout(180_000);
    const demo = await seedBrowserDemo(page, governor);
    const pages: [string, string][] = [
      [`/settings?tab=health`, "État de santé"], [`/settings?tab=work`, "Fonctionnement du travail"], [`/quality`, "Qualité"], [`/w/${demo.workspaceId}/schedules`, "Planifications"],
      [`/settings?tab=release`, "Versions"], [`/settings?tab=security`, "Sécurité"],
    ];
    for (const [path, heading] of pages) {
      await page.goto(`${governor.url}${path}`);
      await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `no sideways scroll on ${path}`).toBe(true);
    }
  });
});
