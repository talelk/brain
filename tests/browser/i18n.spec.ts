import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { seedBrowserDemo } from "../support/browserDemo";

/** On a phone the sidebar is a drawer behind a toggle. */
async function openNav(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if ((await toggle.isVisible()) && (await page.locator('dialog[data-slot="app-shell-drawer"][open]').count()) === 0) await toggle.click();
}

/**
 * Phase 2 vocabulary and languages: the message catalogue renders in French and in Arabic; Arabic is right to left through
 * the document direction alone (no bidi marks patched into strings); the language menu switches and remembers.
 */
test.describe("Arabic", () => {
  test.use({ appLocale: "ar" });
  test("Arabic renders right to left: the places, Today, a decision card and Missions read in Arabic", async ({ page, governor }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const demo = await seedBrowserDemo(page, governor);
    await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "ar");
    await expect(html).toHaveAttribute("dir", "rtl");
    await openNav(page);
    const nav = page.getByRole("navigation", { name: "التنقل في Brain" });
    for (const place of ["اليوم", "المهام", "المكتبة", "الإدارة"]) await expect(nav.getByRole("button", { name: place, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("ما الذي تريد إنجازه؟")).toBeVisible();
    await expect(page.getByTestId("working-now")).toContainText("قيد العمل الآن");
    // The decision card has its four parts in Arabic, and the sidebar sits on the right.
    const card = page.getByTestId("needs-you-item").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Desktop: the sidebar sits on the right in right-to-left. (On a phone it is a drawer.)
    if ((page.viewportSize()?.width ?? 0) >= 1024) expect((await nav.boundingBox())!.x).toBeGreaterThan(400);
    // No Arabic string carries an invisible direction mark: right to left comes from the document alone.
    const marks = await page.evaluate(() => [...document.body.innerText].filter((character) => new RegExp("[\\u200e\\u200f\\u061c\\u202a-\\u202e\\u2066-\\u2069]", "u").test(character)).length);
    expect(marks).toBe(0);
    await openNav(page);
    await nav.getByRole("button", { name: "المهام", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "المهام" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^قيد التنفيذ/ })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("French", () => {
  test.use({ appLocale: "fr" });
  test("French renders the same vocabulary", async ({ page, governor }) => {
    const demo = await seedBrowserDemo(page, governor);
    await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await openNav(page);
    const nav = page.getByRole("navigation", { name: "Navigation de Brain" });
    for (const place of ["Aujourd'hui", "Missions", "Bibliothèque", "Administration"]) await expect(nav.getByRole("button", { name: place, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Que voulez-vous faire ?")).toBeVisible();
    await expect(page.getByTestId("live-freshness")).toContainText("Mis à jour");
  });
});

test.describe("language menu", () => {
  test.use({ appLocale: "" });
  test("the account menu switches the language, sets the direction and is remembered", async ({ page, governor }) => {
    test.setTimeout(120_000);
    const demo = await seedBrowserDemo(page, governor);
    await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await openNav(page);
    await page.getByTestId("account-menu").filter({ visible: true }).getByRole("button").first().click();
    await page.getByRole("option", { name: "Language: العربية" }).or(page.getByText("Language: العربية")).first().click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 30_000 });
    await expect(page.getByTestId("live-freshness")).toBeVisible({ timeout: 30_000 });
    await expect(async () => { await openNav(page); await expect(page.getByRole("navigation", { name: "التنقل في Brain" })).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 20_000 });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await page.goto(`${governor.url}/w/${demo.workspaceId}/today?lang=en&dir=ltr`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });
});
