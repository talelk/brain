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
  const listing = page.getByRole("table", { name: "Files in this folder" });

  // Browse: folders open from the list and from the breadcrumbs, and the filter narrows the whole workspace to a name.
  await expect(listing.getByRole("link", { name: /^docs/u })).toBeVisible();
  await listing.getByRole("link", { name: /^docs/u }).click();
  await expect(listing.getByRole("link", { name: /handbook\.md/u })).toBeVisible();
  await listing.getByRole("link", { name: /^notes/u }).click();
  await expect(listing.getByRole("link", { name: /todo\.txt/u })).toBeVisible();
  await page.getByRole("navigation", { name: "Folder path" }).getByRole("link", { name: "docs" }).click();
  await expect(listing.getByRole("link", { name: /todo\.txt/u })).toBeHidden();
  await page.getByRole("searchbox", { name: "Filter by name" }).fill("todo");
  await expect(listing.getByRole("link")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Filter by name" }).fill("");

  // Edit: the Markdown shows beside its preview; saving commits and says what the commit is.
  await listing.getByRole("link", { name: /handbook\.md/u }).click();
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
  await page.goto(`${files}?folder=docs`);
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles([{ name: "logo.png", mimeType: "image/png", buffer: PNG }, { name: "faq.md", mimeType: "text/markdown", buffer: Buffer.from("# FAQ\n\nWhere is the printer? Second floor.\n") }]);
  await expect(listing.getByRole("link", { name: /logo\.png/u })).toBeVisible();
  await expect(listing.getByRole("link", { name: /faq\.md/u })).toBeVisible();
  await picker.setInputFiles([{ name: "faq.md", mimeType: "text/markdown", buffer: Buffer.from("# FAQ\n\nThe printer moved.\n") }]);
  await expect(page.getByRole("dialog").getByText("docs/faq.md")).toBeVisible();
  await page.getByRole("button", { name: "Replace and upload" }).click();
  await expect.poll(async () => (await api.query("file.read", { workspaceId: workspace.id, path: "docs/faq.md" })).content).toContain("moved");
  // Too large is refused before anything is sent.
  await picker.setInputFiles([{ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }]);
  await expect(page.getByRole("alert").filter({ hasText: "big.pdf is larger than" })).toBeVisible();
  await expect(listing.getByRole("link", { name: /big\.pdf/u })).toHaveCount(0);

  // Download: the picture previews, and the bytes that come back are the bytes that went in.
  await page.goto(`${files}?folder=docs`);
  await listing.getByRole("link", { name: /logo\.png/u }).click();
  await expect(page.getByRole("img", { name: "docs/logo.png" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "docs/logo.png" })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe("logo.png");
  expect(readFileSync(await download.path())).toEqual(PNG);

  // Delete says it is a commit that can be reverted.
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText("can be reverted");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(listing.getByRole("link", { name: /logo\.png/u })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test("Files lists the packs' files too, edits a copy of one, selects many with the keyboard and mouse, copies, moves, downloads and deletes, and takes a dropped file", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.write({ "docs/a.md": "# A\n", "docs/b.md": "# B\n", "docs/notes/n1.md": "# N1\n", "docs/notes/n2.md": "# N2\n" });
  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  const files = `${page.url().replace(/\/$/u, "")}/workspace/files`;
  await page.goto(files);
  const listing = page.getByRole("table", { name: "Files in this folder" });
  const last = async (path: string) => (await api.query("file.read", { workspaceId: workspace.id, path })).lastCommit;
  const exists = async (path: string): Promise<boolean> => (await api.query("workspace.files", { workspaceId: workspace.id })).files.some((file) => file.path === path && file.source === "workspace");

  // A pack's file is listed with its pack, read only, until a copy is edited: the copy replaces it.
  await listing.getByRole("link", { name: "agents", exact: true }).click();
  await listing.getByRole("link", { name: "worker", exact: true }).click();
  await expect(listing.getByText("from pack base").first()).toBeVisible();
  await listing.getByRole("link", { name: /prompt\.md/u }).click();
  await expect(page.getByRole("heading", { level: 2, name: "agents/worker/prompt.md" })).toBeVisible();
  await expect(page.getByText("A file of a pack is read only")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "agents/worker/prompt.md" })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit a copy" }).click();
  await expect(page.getByRole("textbox", { name: "agents/worker/prompt.md" })).toBeVisible();
  expect(await api.query("file.read", { workspaceId: workspace.id, path: "agents/worker/prompt.md" })).toMatchObject({ source: "workspace", replaces: "base" });

  // Selecting: boxes, a range with shift, everything, and a click with the control key on a name.
  await page.goto(`${files}?folder=docs`);
  const select = (name: string) => page.getByRole("checkbox", { name: `Select ${name}` });
  await select("a.md").check();
  await select("b.md").click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status").filter({ hasText: "selected" })).toHaveText("2 selected");
  // The range runs from the first box ticked (a.md), so going back up to the folder makes it notes and a.md.
  await select("notes").click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status").filter({ hasText: "selected" })).toHaveText("2 selected");
  await expect(select("b.md")).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Select all" }).check();
  await expect(page.getByRole("status").filter({ hasText: "selected" })).toHaveText("3 selected");
  await page.getByRole("button", { name: "Clear" }).click();
  await listing.getByRole("link", { name: "b.md" }).click({ modifiers: ["Control"] });
  await expect(select("b.md")).toBeChecked();
  await expect(page).toHaveURL(/folder=docs/u);

  // Copy two files into a new folder: one commit; a second copy keeps both names.
  await select("a.md").check();
  await page.getByRole("button", { name: "Copy (2)" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Destination folder").fill("archive");
  await dialog.getByRole("button", { name: "Copy here" }).click();
  await expect(dialog).toBeHidden();
  expect(await exists("archive/a.md") && await exists("archive/b.md") && await exists("docs/a.md")).toBe(true);
  expect((await last("archive/a.md"))?.message).toBe("Copy 2 files to archive");
  expect(await last("archive/b.md")).toEqual(await last("archive/a.md"));
  await page.goto(`${files}?folder=docs`);
  await select("a.md").check();
  await page.getByRole("button", { name: "Copy (1)" }).click();
  await dialog.getByLabel("Destination folder").fill("archive");
  await dialog.getByRole("radio", { name: /^Keep both/u }).check();
  await dialog.getByRole("button", { name: "Copy here" }).click();
  await expect(dialog).toBeHidden();
  expect(await exists("archive/a copy.md")).toBe(true);

  // Move a folder with what is in it: one commit, nothing left behind, and a folder cannot go into itself.
  await page.goto(`${files}?folder=docs`);
  await select("notes").check();
  await page.getByRole("button", { name: "Move (2)" }).click();
  await dialog.getByLabel("Destination folder").fill("docs/notes/deeper");
  await expect(dialog.getByText("A folder cannot be moved into itself.")).toBeVisible();
  await dialog.getByLabel("Destination folder").fill("archive");
  await dialog.getByRole("button", { name: "Move here" }).click();
  await expect(dialog).toBeHidden();
  expect(await exists("archive/notes/n1.md") && await exists("archive/notes/n2.md")).toBe(true);
  expect(await exists("docs/notes/n1.md") || await exists("docs/notes/n2.md")).toBe(false);
  expect(await last("archive/notes/n1.md")).toEqual(await last("archive/notes/n2.md"));

  // Pack files can be copied but neither moved nor deleted.
  await page.goto(`${files}?folder=agents/planner`);
  await select("prompt.md").check();
  await expect(page.getByRole("button", { name: "Move (1)" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete (1)" })).toBeDisabled();
  await expect(page.getByText("Pack files can be copied, not moved or deleted.")).toBeVisible();
  await page.getByRole("button", { name: "Copy (1)" }).click();
  await dialog.getByLabel("Destination folder").fill("docs/from-pack");
  await dialog.getByRole("button", { name: "Copy here" }).click();
  await expect(dialog).toBeHidden();
  expect(await exists("docs/from-pack/prompt.md")).toBe(true);

  // Download several, then delete several in one commit.
  await page.goto(`${files}?folder=archive`);
  await select("a.md").check();
  await select("b.md").check();
  const downloads: string[] = [];
  page.on("download", (item) => downloads.push(item.suggestedFilename()));
  await page.getByRole("button", { name: "Download (2)" }).click();
  await expect.poll(() => downloads.sort()).toEqual(["a.md", "b.md"]);
  await page.getByRole("button", { name: "Delete (2)" }).click();
  await expect(dialog).toContainText("can be reverted");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  expect(await exists("archive/a.md") || await exists("archive/b.md")).toBe(false);
  expect(await exists("archive/a copy.md")).toBe(true);

  // A real drop of a file on the page uploads it into the folder being looked at.
  await page.goto(`${files}?folder=docs`);
  await expect(listing).toBeVisible();
  await page.getByTestId("files").evaluate((zone) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["dropped text\n"], "dropped.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(listing.getByRole("link", { name: /dropped\.txt/u })).toBeVisible();
  expect((await api.query("file.read", { workspaceId: workspace.id, path: "docs/dropped.txt" })).content).toBe("dropped text\n");
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
    expect(await violations(page), "root").toEqual([]);
    await workspace.write({ "docs/handbook.md": "# Handbook\n\nText.\n" });
    await page.goto(`${page.url().split("?")[0]}?folder=docs`);
    expect(await violations(page), "folder").toEqual([]);
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
  await expect(page).toHaveURL(/\/w\/starter/u);
  await page.goto(`${page.url().replace(/\/$/u, "")}/workspace/files?folder=docs`);
  await expect(page.getByRole("button", { name: "رفع ملفات" }).first()).toBeVisible();
  await page.getByRole("link", { name: /handbook\.md/u }).click();
  await expect(page.getByRole("textbox", { name: "docs/handbook.md" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
