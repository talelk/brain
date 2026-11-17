import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, openWorkspace, signIn, starter, test } from "./stack";

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const violations = async (page: Page): Promise<string[]> =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(" | ")}`);

test("an admin browses the folder, edits a document, uploads files and downloads one, and a broken brain.toml is refused where it is @phone", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.write({ "docs/handbook.md": "# Onboarding handbook\n\nLaptops are collected on the first Monday.\n", "docs/notes/todo.txt": "buy cables\n" });
  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.goto(`${page.url().replace(/\/$/u, "")}/workspace/files`);
  const files = page.url();

  // Browse: folders open and close, and the filter narrows the tree to a name.
  const tree = page.getByRole("navigation", { name: "Workspace folder" });
  await expect(tree.getByRole("link", { name: /handbook\.md/u })).toBeVisible();
  await tree.getByRole("button", { name: "notes" }).click();
  await expect(tree.getByRole("link", { name: /todo\.txt/u })).toBeVisible();
  await tree.getByRole("button", { name: "notes" }).click();
  await expect(tree.getByRole("link", { name: /todo\.txt/u })).toBeHidden();
  await page.getByRole("searchbox", { name: "Filter by name" }).fill("todo");
  await expect(tree.getByRole("link")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Filter by name" }).fill("");

  // Edit: the Markdown shows beside its preview; saving commits and says what the commit is.
  await tree.getByRole("link", { name: /handbook\.md/u }).click();
  await expect(page.getByRole("heading", { level: 2, name: "docs/handbook.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Onboarding handbook" })).toBeVisible();
  await page.getByRole("textbox", { name: "docs/handbook.md" }).fill("# Onboarding handbook\n\nBadges are printed on the first Monday.\n");
  await expect(page.getByText("Badges are printed")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Commit message" }).fill("Badges, not laptops");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved and committed")).toBeVisible();
  expect((await api.query("file.read", { workspaceId: workspace.id, path: "docs/handbook.md" })).content).toContain("Badges");
  await page.reload();
  await expect(page.getByText(/last change: Badges, not laptops/u)).toBeVisible();

  // A file that would break the workspace is refused on its line and the editor keeps what was typed.
  await page.goto(`${files}?path=brain.toml`);
  await expect(page.getByText("change what agents do")).toBeVisible();
  const brain = page.getByRole("textbox", { name: "brain.toml" });
  await brain.fill('name = "Starter"\ndescription = \n');
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "not valid TOML" })).toBeVisible();
  await expect(brain).toHaveValue(/description = \n/u);

  // Upload: a picture and a text file in one commit; a name that exists asks before it is replaced.
  await page.goto(files);
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles([{ name: "logo.png", mimeType: "image/png", buffer: PNG }, { name: "faq.md", mimeType: "text/markdown", buffer: Buffer.from("# FAQ\n\nWhere is the printer? Second floor.\n") }]);
  await expect(tree.getByRole("link", { name: /logo\.png/u })).toBeVisible();
  await expect(tree.getByRole("link", { name: /faq\.md/u })).toBeVisible();
  await picker.setInputFiles([{ name: "faq.md", mimeType: "text/markdown", buffer: Buffer.from("# FAQ\n\nThe printer moved.\n") }]);
  await expect(page.getByRole("dialog").getByText("docs/faq.md")).toBeVisible();
  await page.getByRole("button", { name: "Replace and upload" }).click();
  await expect.poll(async () => (await api.query("file.read", { workspaceId: workspace.id, path: "docs/faq.md" })).content).toContain("moved");
  // Too large is refused before anything is sent.
  await page.goto(files);
  await picker.setInputFiles([{ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }]);
  await expect(page.getByRole("alert").filter({ hasText: "big.pdf is larger than" })).toBeVisible();
  await expect(tree.getByRole("link", { name: /big\.pdf/u })).toHaveCount(0);

  // Download: the picture previews, and the bytes that come back are the bytes that went in.
  await tree.getByRole("link", { name: /logo\.png/u }).click();
  await expect(page.getByRole("img", { name: "docs/logo.png" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "docs/logo.png" })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe("logo.png");
  expect(readFileSync(await download.path())).toEqual(PNG);

  // Delete says it is a commit that can be reverted.
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText("can be reverted");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(tree.getByRole("link", { name: /logo\.png/u })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`Files has no serious accessibility violation, ${scheme}, empty and with documents @phone`, async ({ page, stack }) => {
    const api = await stack.setUp();
    const workspace = await starter(api);
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page, stack);
    await openWorkspace(page, "Starter");
    await page.goto(`${page.url().replace(/\/$/u, "")}/workspace/files`);
    await expect(page.getByRole("button", { name: "Upload files" }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await violations(page), "empty").toEqual([]);
    await workspace.write({ "docs/handbook.md": "# Handbook\n\nText.\n" });
    await page.getByRole("link", { name: /handbook\.md/u }).click();
    await expect(page.getByRole("textbox", { name: "docs/handbook.md" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await violations(page), "file").toEqual([]);
  });
}

test("in Arabic Files reads right to left", async ({ page, stack }) => {
  const api = await stack.setUp();
  await (await starter(api)).write({ "docs/handbook.md": "# دليل\n\nنص.\n" });
  await page.goto(`${stack.url}/?lang=ar`);
  await page.getByLabel("البريد الإلكتروني").fill("maya@example.com");
  await page.locator('input[type="password"]').fill("correct horse battery");
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("link", { name: /Starter/u }).first().click();
  await page.goto(`${page.url().replace(/\/$/u, "")}/workspace/files`);
  await expect(page.getByRole("button", { name: "رفع ملفات" }).first()).toBeVisible();
  await page.getByRole("link", { name: /handbook\.md/u }).click();
  await expect(page.getByRole("textbox", { name: "docs/handbook.md" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
