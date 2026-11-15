import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { sendTaskBack } from "../support/evalCases";

/**
 * A first-time quality reviewer finds the eval cases from Quality, sees the empty explanation, then (after a task is sent back)
 * the case with its source, mission link, findings and date, and the by-hand replay instructions (ADR 0010: never automatic).
 */
test("eval cases: found from Quality, listed with source, mission, findings and date, replayed by hand only (#99)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Eval organization");
  await page.getByLabel(/^Email/).fill("eval@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const owner = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(owner, { workspaceId: "ws-eval", slug: "eval" });
  const bundle = fixtureStarter();
  brain.activateRelease(owner, brain.stageRelease(owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const actor = (await brain.resolveActor(new Headers({ cookie }), "ws-eval")).actor;
  const drafts = () => brain.store.control.prepare("SELECT (SELECT COUNT(*) FROM config_drafts) AS drafts, (SELECT COUNT(*) FROM config_releases) AS releases").get();
  const before = drafts();

  // From Quality, the page says where cases come from while none exist.
  await page.goto(`${governor.url}/w/ws-eval/quality/cases`);
  await expect(page.getByRole("heading", { name: "Eval cases", exact: true }).first()).toBeVisible();
  await expect(page.getByText("No eval cases yet")).toBeVisible();
  await page.goto(`${governor.url}/quality`);
  await page.getByRole("link", { name: "Open eval cases" }).click();
  await expect(page).toHaveURL(/\/w\/ws-eval\/quality\/cases$/);
  await expect(page.getByText("No eval cases yet")).toBeVisible();

  // Two tasks are sent back from review; each leaves a case.
  const first = await sendTaskBack(brain, actor, "ws-eval", { key: "e1", title: "Churn report", finding: "Cause two had no cited source" });
  const second = await sendTaskBack(brain, actor, "ws-eval", { key: "e2", title: "Refund summary", finding: "The refund total does not add up" });
  await page.goto(`${governor.url}/w/ws-eval/quality/cases`);
  const cards = page.locator("[data-eval-case]");
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "2 cases" })).toBeVisible();
  // Newest first; each card names its source, mission, date, findings and replay instruction.
  const newest = cards.nth(0);
  await expect(newest).toContainText("Refund summary");
  await expect(newest).toContainText("Task sent back from review");
  await expect(newest).toContainText("The refund total does not add up");
  await expect(newest).toContainText("Recorded ");
  await expect(newest).toContainText("Write Refund summary");
  await expect(newest.locator("[data-eval-replay]")).toContainText("Replay by hand");
  await expect(cards.nth(1)).toContainText("Cause two had no cited source");
  // The whole-list instruction names the script and says nothing runs by itself.
  await expect(page.getByText("node scripts/qualification/task-quality.mjs --cases brain-eval-cases.json")).toBeVisible();
  await expect(page.getByText("no case changes a prompt, a workflow or a release", { exact: false })).toBeVisible();

  // The cases file is what the replay script reads: an array of the cases, here one case from its card.
  const [single] = await Promise.all([page.waitForEvent("download"), newest.getByRole("button", { name: "Download this case" }).click()]);
  const one = JSON.parse(readFileSync(await single.path(), "utf8")) as Array<{ missionId: string; kind: string; findings: string[] }>;
  expect(one).toHaveLength(1);
  expect(one[0]).toMatchObject({ missionId: second, kind: "task-sent-back", findings: ["The refund total does not add up"] });
  const [all] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download cases file" }).click()]);
  expect(all.suggestedFilename()).toBe("brain-eval-cases.json");
  expect((JSON.parse(readFileSync(await all.path(), "utf8")) as Array<{ missionId: string }>).map((entry) => entry.missionId)).toEqual([second, first]);

  // The case links to its mission.
  await newest.getByRole("link", { name: "Refund summary" }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${second}`));
  // Recording and reading cases changed no prompt, draft or release.
  expect(drafts()).toEqual(before);
  expect(errors).toEqual([]);
});
