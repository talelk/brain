import { createServer } from "node:http";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { fixtureStarter } from "../support/starter";
import { signUpOwner } from "../support/flow";

/**
 * #48, the model fix: with no model connected Today is blocked, the Connect a model fix opens the existing guided
 * setup in a sheet, and the checklist behind it is right as soon as the connection is saved, with no reload.
 */
test.use({ localRuntime: true });
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

test("with the model unconnected Today is blocked; Connect a model completes in a sheet and the checklist updates", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const upstream = createServer((request, response) => {
    if (request.url !== "/v1/models") { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "sample-model" }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No model endpoint address");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { brain, actor } = await signUpOwner(page, governor, "model");
    brain.createWorkspace(actor, { workspaceId: "ws-model", slug: "model" });
    const starter = fixtureStarter();
    brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
    await page.goto(`${governor.url}/w/ws-model/today`);
    const setup = page.getByTestId("today-setup");
    await expect(setup.locator('[data-step="model"]')).toHaveAttribute("data-status", "missing", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
    await shot(page, "install-model-missing");

    await setup.getByRole("button", { name: "Connect a model", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Set up Brain" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Configure model", exact: true }).click();
    await page.getByLabel(/^Model API URL/).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel(/^Model ID/).fill("sample-model");
    await page.getByRole("dialog").last().getByRole("button", { name: "Test connection and start runners", exact: true }).click();
    await expect(sheet.getByText("Model found.")).toBeVisible({ timeout: 30_000 });
    await shot(page, "install-model-sheet");
    await sheet.getByRole("button", { name: "Close", exact: true }).click();

    // No reload: the model item is done, and the box is still blocked by what is left (runners).
    await expect(setup.locator('[data-step="model"]')).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    await expect(setup.locator('[data-step="runners"]')).toHaveAttribute("data-status", "missing");
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
