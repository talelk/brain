import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

/**
 * Phase 2 Library: what Brain learned, in plain words, each entry saying where it was learned. "Helped N times" and the expiry
 * date come from the engine and render only when the Governor reports them (hidden by default).
 */
test("what Brain learned is browsable in plain words, with where it was learned; helped and expiry show only when reported", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const brain = governor.app.brain;
  const row = brain.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE id=?").get(demo.workspaceId) as { id: string; organization_id: string };
  const db = brain.store.workspaceDb(row.id, row.organization_id);
  const now = brain.store.now();
  const insert = db.prepare(`INSERT INTO knowledge_assets(id, signature, operation_id, state, classification, content, source_count, title, mission_id, created_at_ms, updated_at_ms)
    VALUES (?,?, 'mission-knowledge', 'published', 'internal', ?, 1, ?, ?, ?, ?)`);
  insert.run("ka-1", `sha256:${"1".repeat(64)}`, "## Sessions\n\n**Check the issuer first.** The callback URL must match the registered one.", "How to debug a sign-in loop", demo.seed.missionIds.active, now, now);
  insert.run("ka-2", `sha256:${"2".repeat(64)}`, "Retired webhooks left no traffic after the second week.", "Webhook retirement", demo.seed.missionIds.closed, now - 1000, now - 1000);

  await page.goto(`${governor.url}/w/${demo.workspaceId}/knowledge`);
  const entries = page.getByTestId("learned-entry");
  await expect(entries).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("learned-count")).toHaveText("2 entries");
  const first = entries.filter({ hasText: "How to debug a sign-in loop" });
  // Plain words: the markdown marks are gone, and the entry says which mission it was learned from.
  await expect(first).toContainText("Check the issuer first. The callback URL must match the registered one.");
  await expect(first).not.toContainText("##");
  await expect(first.getByTestId("learned-from")).toContainText("Learned from Stabilize authentication");
  await first.getByRole("link", { name: "Stabilize authentication" }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${demo.seed.missionIds.active}/outputs`));

  // Default: no helped count, no expiry (nobody counted them).
  await page.goto(`${governor.url}/w/${demo.workspaceId}/knowledge`);
  await expect(entries).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("learned-helped")).toHaveCount(0);
  await expect(page.getByTestId("learned-expires")).toHaveCount(0);

  // When the engine reports them, they render.
  await page.route("**/v1/query", async (route) => {
    const body = route.request().postDataJSON() as { queryType?: string };
    if (body.queryType !== "knowledgeAssets.list") { await route.continue(); return; }
    const response = await route.fetch();
    const json = await response.json() as { snapshot: { items: Array<Record<string, unknown>> } };
    json.snapshot.items = json.snapshot.items.map((item) => (item["assetId"] === "ka-1" ? { ...item, helpedCount: 3, expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString() } : item));
    await route.fulfill({ response, json });
  });
  await page.reload();
  await expect(entries).toHaveCount(2, { timeout: 30_000 });
  await expect(entries.filter({ hasText: "How to debug a sign-in loop" }).getByTestId("learned-helped")).toHaveText("Helped 3 times");
  await expect(entries.filter({ hasText: "How to debug a sign-in loop" }).getByTestId("learned-expires")).toContainText("Expires in");
  await expect(entries.filter({ hasText: "Webhook retirement" }).getByTestId("learned-helped")).toHaveCount(0);
  expect(errors).toEqual([]);
});
