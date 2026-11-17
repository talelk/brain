import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, openWorkspace, signIn, starter, test, type Stack } from "./stack";

/** A person with one finished goal, so Today and Task have something on them. */
async function withFinishedGoal(stack: Stack): Promise<string> {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  const { taskId } = await api.command("task.create", { workspaceId: workspace.id, play: "hello", inputs: {} });
  await expect.poll(async () => (await api.query("task.get", { workspaceId: workspace.id, taskId })).state, { timeout: 30_000 }).toBe("done");
  return taskId;
}
const violations = async (page: Page): Promise<string[]> =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(" | ")}`);

for (const scheme of ["light", "dark"] as const) {
  test(`Today and Task have no serious accessibility violation, ${scheme} @phone`, async ({ page, stack }) => {
    const taskId = await withFinishedGoal(stack);
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page, stack);
    await expect(page.getByRole("row", { name: /Starter/u }).first()).toBeVisible();
    expect(await violations(page), "Overview").toEqual([]);
    await openWorkspace(page, "Starter");
    await expect(page.getByRole("heading", { name: "Recent results" })).toBeVisible();
    expect(await violations(page), "Today").toEqual([]);
    await page.getByRole("link", { name: /Say hello/u }).first().click();
    await expect(page.getByRole("heading", { name: "Result" }).first()).toBeVisible();
    expect(await violations(page), "Task").toEqual([]);
    await page.goto(page.url().replace(/\/tasks\/.*/u, "/workspace/team"));
    await expect(page.getByText("Agents never message each other")).toBeVisible();
    expect(await violations(page), "Team").toEqual([]);
    expect(taskId).toMatch(/^t_/u);
  });
}

test("in Arabic the page reads right to left and nothing runs off its edge", async ({ page, stack }) => {
  await withFinishedGoal(stack);
  await page.goto(`${stack.url}/?lang=ar`);
  await page.getByLabel("البريد الإلكتروني").fill("maya@example.com");
  await page.locator('input[type="password"]').fill("correct horse battery");
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole("heading", { level: 1, name: "نظرة عامة" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  // The sidebar starts on the right: it is to the right of the page.
  const bar = await page.getByRole("navigation").first().boundingBox();
  const main = await page.getByRole("main").boundingBox();
  expect(bar && main && bar.x > main.x).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("link", { name: /Starter/u }).first().click();
  await page.getByRole("link", { name: /Say hello|قل مرحبا/u }).first().click();
  await expect(page.getByRole("article")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // The graphs are mirrored: the first step stands on the right of the one that waits for it, and the Team graph fits the page too.
  const first = await page.getByRole("group", { name: "سجل هذا الهدف" }).getByRole("button").first().boundingBox();
  const last = await page.getByRole("group", { name: "سجل هذا الهدف" }).getByRole("button").last().boundingBox();
  expect(first && last && first.x >= last.x).toBe(true);
  await page.goto(page.url().replace(/\/tasks\/.*/u, "/workspace/team"));
  await expect(page.getByRole("link", { name: /^worker/u })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
