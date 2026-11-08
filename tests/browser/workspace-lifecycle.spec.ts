import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";

test("workspace: create and manage metadata, suspension, resume and archive from Bridge", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Workspace lifecycle organization");
  await page.getByLabel(/^Email/).fill("workspace-lifecycle@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-workspace-lifecycle", slug: "Initial workspace" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);

  await page.goto(`${governor.url}/administration/workspaces`);
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create workspace", exact: true });
  await dialog.getByLabel(/^Display name/).fill("Second workspace");
  await expect(dialog.getByLabel(/^Display name/)).toHaveValue("Second workspace");
  await dialog.getByLabel("Description", { exact: true }).fill("Created through the consolidated Bridge flow");
  await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByText("Second workspace", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  const card = page.locator("article").filter({ hasText: "Initial workspace" });
  await card.getByRole("button", { name: "Manage", exact: true }).click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel(/^Display name/).fill("Managed workspace");
  await dialog.getByLabel("Description", { exact: true }).fill("Operational metadata");
  await dialog.getByLabel("Tags", { exact: true }).fill("support, local");
  await dialog.getByRole("button", { name: "Save metadata", exact: true }).click();
  const managed = page.locator("article").filter({ hasText: "Managed workspace" });
  await expect(managed).toBeVisible();

  await managed.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Suspend workspace", exact: true }).click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel(/^Operations reason/).focus();
  await dialog.getByLabel(/^Operations reason/).fill("Planned suspension");
  await expect(dialog.getByLabel(/^Operations reason/)).toHaveValue("Planned suspension");
  await dialog.getByRole("button", { name: "Suspend workspace", exact: true }).click();
  await expect.poll(() => brain.store.control.prepare("SELECT status FROM workspaces WHERE id='ws-workspace-lifecycle'").get()).toEqual({ status: "suspended" });

  await managed.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Validate and resume", exact: true }).click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel(/^Operations reason/).focus();
  await dialog.getByLabel(/^Operations reason/).fill("Checks complete");
  await expect(dialog.getByLabel(/^Operations reason/)).toHaveValue("Checks complete");
  await dialog.getByRole("button", { name: "Validate and resume", exact: true }).click();
  await expect.poll(() => brain.store.control.prepare("SELECT status FROM workspaces WHERE id='ws-workspace-lifecycle'").get()).toEqual({ status: "active" });

  await managed.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Archive after checks", exact: true }).click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel(/^Operations reason/).focus();
  await dialog.getByLabel(/^Operations reason/).fill("Retain audit history");
  await expect(dialog.getByLabel(/^Operations reason/)).toHaveValue("Retain audit history");
  await dialog.getByRole("button", { name: "Archive workspace", exact: true }).click();
  await expect.poll(() => brain.store.control.prepare("SELECT status,version FROM workspaces WHERE id='ws-workspace-lifecycle'").get()).toEqual({ status: "archived", version: 5 });
  expect(errors).toEqual([]);
});
