import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

/**
 * Story 105 (ADR 0037): an administrator declares which hosts this workspace's sandboxed tools may reach, under "How work runs". A first-time
 * administrator finds the section, sees that no host is allowed yet, is told in words when an entry cannot work, saves a list and finds it
 * again after reloading, then empties it to take the network away.
 */
test("an administrator declares the hosts sandboxed tools may reach, and can take them away again", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);

  await page.goto(`${governor.url}/settings?tab=work`);
  await expect(page.getByRole("heading", { name: "How work runs", exact: true, level: 1 })).toBeVisible();
  const egress = page.locator("[data-work-egress]");
  await expect(egress).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "What sandboxed tools may reach", exact: true })).toBeVisible();
  await expect(page.locator("[data-work-egress-current]")).toHaveText("No host is allowed: this workspace's tools run without a network.");

  // An entry the proxy could not match is named before anything is sent, and Save waits.
  const hosts = egress.getByLabel("Allowed hosts", { exact: true });
  await hosts.fill("https://api.example.com\nmodels.internal:8000");
  await expect(egress.getByRole("alert")).toContainText("Not a host the proxy can allow: https://api.example.com");
  await expect(egress.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await hosts.fill("API.example.com\nmodels.internal:8000\napi.example.com");
  await expect(egress.getByRole("alert")).toHaveCount(0);
  await egress.getByRole("button", { name: "Save", exact: true }).click();
  await expect(egress.getByRole("status")).toHaveText("The allowed hosts were saved.");
  await expect(page.locator("[data-work-egress-current]")).toHaveText("Reachable through the egress proxy: api.example.com, models.internal:8000.", { timeout: 30_000 });

  // The list is the workspace's own and survives a reload.
  await page.reload();
  await expect(page.locator("[data-work-egress]").getByLabel("Allowed hosts", { exact: true })).toHaveValue("api.example.com\nmodels.internal:8000", { timeout: 30_000 });
  expect(governor.app.brain.store.control.prepare("SELECT egress_hosts_json AS h FROM workspace_effect_policy WHERE workspace_id=?").get(demo.workspaceId)).toEqual({ h: '["api.example.com","models.internal:8000"]' });

  // Saving the effect allow-list above it leaves the hosts alone, and emptying the hosts takes the network away.
  await page.locator("[data-work-effects]").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-work-effects]").getByRole("status")).toHaveText("The allow-list was saved.");
  await expect(page.locator("[data-work-egress-current]")).toContainText("api.example.com");
  const again = page.locator("[data-work-egress]");
  await again.getByLabel("Allowed hosts", { exact: true }).fill("");
  await again.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-work-egress-current]")).toHaveText("No host is allowed: this workspace's tools run without a network.", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
