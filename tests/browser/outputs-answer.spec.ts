import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";
import { casFilePath } from "../../apps/governor/src/modules/artifacts/index";

/**
 * Phase 2 Outputs: the answer to the goal first, then one result per task; records of attempts fold under Attempts and
 * never count as results; counts are the server's true totals and are paged; nothing shows a raw run id.
 */
test("the answer to the goal leads; attempts fold; counts are true and paged; no raw ids", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const brain = governor.app.brain;
  const row = brain.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE id=?").get(demo.workspaceId) as { id: string; organization_id: string };
  const db = brain.store.workspaceDb(row.id, row.organization_id);
  const now = brain.store.now();
  const digestOf = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  const put = (id: string, text: string, mediaType: string, jobId: string, at: number) => {
    const digest = digestOf(text);
    const path = casFilePath(brain.store, digest);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
    db.prepare("INSERT OR IGNORE INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES (?,?,?,?, 'internal','verified',?)").run(id, digest, Buffer.byteLength(text), mediaType, at);
    brain.store.control.prepare("INSERT INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms) VALUES (?,?,?,?, 'job', ?, 'internal', ?)")
      .run(id, row.organization_id, demo.workspaceId, digest, jobId, at);
  };
  // The demo links its "done" task to job demo-job; give the review task its own job, then write a result for each and two attempt records for the first.
  db.prepare("UPDATE execution_links SET job_id='demo-job-review' WHERE run_id='demo-run-review'").run();
  put("att-answer.md", "# Sign-in flow verified\n\nThe sign-in flow was audited and the sessions are fresh.", "text/markdown", "demo-job", now);
  put("att-review.md", "# Correction drafted\n\nThe correction is ready for review.", "text/markdown", "demo-job-review", now - 1000);
  put("exec-attempt-1.json", '{"attempt":1,"outcome":"failed"}', "application/json", "demo-job", now - 5000);
  put("exec-attempt-2.json", '{"attempt":2,"outcome":"failed"}', "application/json", "demo-job", now - 4000);

  // The mission's Outputs tab: the answer first, with the goal, then the result of the other task.
  await page.goto(`${governor.url}/missions/${demo.seed.missionIds.active}/outputs?w=${demo.workspaceId}`);
  const answer = page.getByTestId("mission-answer");
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(answer.getByRole("heading", { name: "The answer to your goal" })).toBeVisible();
  await expect(answer).toContainText("Investigate and verify the sign-in flow");
  await expect(page.getByTestId("results-summary")).toContainText("2 results");
  await expect(page.getByTestId("results-summary")).toContainText("1 waiting for your review");
  expect(await page.getByTestId("mission-results").evaluate((element) => element.firstElementChild?.getAttribute("data-testid"))).toBe("mission-answer");
  // Attempt records are folded under Attempts and are not results.
  await expect(answer.getByTestId("attempts-fold")).toContainText("Attempts (2)");
  const text = await page.getByTestId("mission-results").innerText();
  expect(text).not.toMatch(/exec-attempt|job-|run-|att-/u);

  // The workspace page counts results only, with attempt records apart; a long list says how many exist and pages the rest in.
  const total = () => (db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE state='verified' AND id NOT LIKE 'exec-%'").get() as { c: number }).c;
  for (let index = 0; index < 105; index += 1) put(`att-bulk-${index}.md`, `# Bulk ${index}`, "text/markdown", `bulk-job-${index}`, now - 100_000 - index);
  const all = total();
  expect(all).toBeGreaterThan(105);
  await page.goto(`${governor.url}/w/${demo.workspaceId}/outputs?folder=all`);
  await expect(page.getByTestId("output-count")).toHaveText(`100 of ${all} results`, { timeout: 30_000 });
  await expect(page.getByTestId("output-more")).toContainText(`Showing 100 of ${all} results`);
  await page.getByRole("button", { name: "Show more results" }).click();
  await expect(page.getByTestId("output-count")).toHaveText(`${all} results`, { timeout: 30_000 });
  await expect(page.getByTestId("output-more")).toHaveCount(0);
  // Nothing on the cards is a raw run id or an internal file name.
  await expect(page.getByTestId("output-file").filter({ hasText: /from run|job-|run-/u })).toHaveCount(0);
  expect(errors).toEqual([]);
});
