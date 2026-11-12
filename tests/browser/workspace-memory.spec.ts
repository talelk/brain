import { test, expect } from "./fixtures";

/** Pages with no workspace in their address (Administration, Runners, Approvals) used to open the first workspace on every reload. */
test("a reload on an Administration page stays in the workspace the person was in", async ({ page, governor }) => {
  const brain = governor.app.brain;
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Memory organization");
  await page.getByLabel(/^Email/).fill("memory@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-alpha", slug: "alpha" });
  brain.createWorkspace(actor, { workspaceId: "ws-beta", slug: "beta" });

  const tenant = page.getByRole("button", { name: /^(alpha|beta)$/ }).first();
  await page.goto(`${governor.url}/w/ws-beta/today`);
  await expect(tenant).toContainText("beta");
  // A page with no workspace in its address, opened afresh (a reload, a bookmark, a new tab), keeps the last workspace.
  await page.goto(`${governor.url}/settings?tab=health`);
  await expect(tenant).toContainText("beta");
  await page.reload();
  await expect(tenant).toContainText("beta");
  // An address that names a workspace still wins.
  await page.goto(`${governor.url}/w/ws-alpha/today`);
  await expect(tenant).toContainText("alpha");
});
