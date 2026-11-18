import { expect, openWorkspace, signIn, starter, test } from "./stack";

test("an agent's prompt is edited in Workspace; its file moves from the pack to the workspace, and a broken file is refused on its line", async ({ page, stack }) => {
  await starter(await stack.setUp());
  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.getByRole("link", { name: "Workspace" }).first().click();
  await page.getByRole("link", { name: /^worker/u }).click();
  await expect(page.getByRole("heading", { level: 2, name: "worker" })).toBeVisible();
  await expect(page.getByText("From the pack base.")).toBeVisible();

  const prompt = page.getByRole("textbox", { name: /prompt\.md/u });
  await prompt.fill("You are the worker. Answer in short sentences.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved and committed")).toBeVisible();
  await expect(page.getByText("A file of this workspace.")).toBeVisible();

  // The same thing as files: a broken line is refused where it is, and nothing is written.
  await page.getByRole("radio", { name: "File", exact: true }).click();
  await page.getByRole("radio", { name: "agent.toml" }).click();
  const file = page.getByRole("textbox", { name: "agents/worker/agent.toml" });
  await expect(file).toHaveValue(/native/u);
  await file.fill('description = "A worker"\nengine = ["pi"]\nnative = all\n');
  await page.getByRole("button", { name: "Save" }).click();
  const problem = page.getByRole("listitem").filter({ hasText: "not valid TOML" });
  await expect(problem).toContainText("3");
  await expect(page.getByRole("alert").filter({ hasText: "Nothing was saved" })).toBeVisible();
  // Nothing was written: the file as the pack gave it is still what Workspace reads back.
  await page.reload();
  await page.getByRole("radio", { name: "File", exact: true }).click();
  await page.getByRole("radio", { name: "agent.toml" }).click();
  await expect(page.getByRole("textbox", { name: "agents/worker/agent.toml" })).toHaveValue(/native = "all"/u);
});

test("Workspace settings fit a phone: the limits table scrolls inside its own box and the page does not scroll sideways @phone", async ({ page, stack }) => {
  await starter(await stack.setUp());
  await signIn(page, stack);
  await page.goto(`${stack.url}/w/starter/workspace/settings`);
  await expect(page.getByRole("heading", { level: 3, name: "Limits" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
