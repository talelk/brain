import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";
import { seedStaleKnowledge } from "../support/stale-knowledge";

/**
 * Stale knowledge is marked (#133), walked as a first-time user on the Knowledge page: an entry whose source document changed says so
 * and what changed, stays readable, and a reviewer either re-confirms it (the mark goes) or withdraws it (it leaves the list).
 */
test("a stale knowledge entry is labelled with what changed; a reviewer re-confirms it or withdraws it", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const brain = governor.app.brain;
  const ws = brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId);
  const now = brain.store.now();
  // One entry nothing changed under, so the page shows what "fine" looks like next to what is stale.
  ws.prepare(`INSERT INTO knowledge_assets(id, signature, operation_id, state, classification, content, source_count, title, mission_id, created_at_ms, updated_at_ms)
    VALUES ('ka-fine', ?, 'mission-knowledge', 'published', 'internal', 'Retired webhooks left no traffic after the second week.', 1, 'Webhook retirement', ?, ?, ?)`).run(`sha256:${"2".repeat(64)}`, demo.seed.missionIds.closed, now - 5000, now - 5000);
  await seedStaleKnowledge(brain, demo.actor, demo.workspaceId, { key: "keep", missionId: demo.seed.missionIds.closed, title: "Vendor seat prices", content: "Vendor A is cheapest per seat on a one-year term.", documentTitle: "Vendor price list" });
  await seedStaleKnowledge(brain, demo.actor, demo.workspaceId, { key: "drop", missionId: demo.seed.missionIds.closed, title: "Vendor contract terms", content: "Vendor B needs a three-year term.", documentTitle: "Vendor terms sheet" });

  await page.goto(`${governor.url}/w/${demo.workspaceId}/knowledge`);
  const entries = page.getByTestId("learned-entry");
  await expect(entries).toHaveCount(3, { timeout: 30_000 });

  // The entry says it is stale, why, and that it can still be read.
  const prices = entries.filter({ hasText: "Vendor seat prices" });
  await expect(prices.getByText("Source changed", { exact: true })).toBeVisible();
  await expect(prices.getByTestId("learned-stale-detail")).toContainText("document “Vendor price list” has a newer version");
  await expect(prices.getByTestId("learned-stale-detail")).toContainText("Still readable");
  await expect(prices).toContainText("Vendor A is cheapest per seat on a one-year term.");
  // An entry nothing changed under carries no mark.
  await expect(entries.filter({ hasText: "Webhook retirement" }).getByTestId("learned-stale")).toHaveCount(0);

  // Search says so too: the same entry comes back labelled stale with what changed, still readable.
  await page.getByLabel("Search scoped knowledge").fill("cheapest");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("result-stale")).toContainText("document “Vendor price list” has a newer version", { timeout: 20_000 });
  await expect(page.getByText("Vendor A is cheapest per seat on a one-year term.").last()).toBeVisible();

  // Re-confirm: the reviewer checked it against the new version; the mark goes and the entry says when it was re-confirmed.
  await prices.getByTestId("learned-reconfirm").click();
  await expect(page.getByText("Re-confirmed. It is no longer marked stale.")).toBeVisible();
  await expect(prices.getByTestId("learned-stale")).toHaveCount(0);
  await expect(prices.getByTestId("learned-reconfirmed")).toContainText("Re-confirmed");

  // Withdraw: the other entry leaves the list (it is revoked, never deleted).
  const terms = entries.filter({ hasText: "Vendor contract terms" });
  await terms.getByTestId("learned-withdraw").click();
  await expect(page.getByText("Withdrawn from search and reuse.")).toBeVisible();
  await expect(entries).toHaveCount(2);
  await expect(page.getByTestId("learned-count")).toHaveText("2 entries");
  await expect(entries.filter({ hasText: "Vendor contract terms" })).toHaveCount(0);

  // A reload shows the same: the re-confirmed entry stays clear until its source changes again.
  await page.reload();
  await expect(entries).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("learned-stale")).toHaveCount(0);
  expect(errors).toEqual([]);
});
