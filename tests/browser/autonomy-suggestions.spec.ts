import { test, expect } from "./fixtures";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";
import { autonomyContext, cleanMission, cleanPlayMissions, missionWithTasks, finishTasks, sendBack, tasksOf } from "../support/autonomy-world";

// Autonomy suggestions (#158, ADR 0066): a first-time owner finds, on a mission, a Play and Quality, what Brain suggests from a clean record, with the
// figures and their definitions and the evidence to open. They can accept or dismiss; neither is an attention item, a problem withdraws a suggestion, and
// nothing about it approves an effect. Every record is made through commands; only the verdicts a real evaluator run would leave are seeded.

test("a first-time owner reads, dismisses and accepts autonomy suggestions; none is an attention item, and a problem withdraws one", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "autonomy");
  brain.createWorkspace(actor, { workspaceId: "ws-autonomy", slug: "autonomy" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-autonomy")).actor;
  const ctx = autonomyContext(brain, actor.organizationId, scoped, "ws-autonomy");
  const db = brain.store.workspaceDb("ws-autonomy", actor.organizationId);
  const presetOf = (missionId: string) => (JSON.parse((db.prepare("SELECT policy_json FROM missions WHERE id=?").get(missionId) as { policy_json: string }).policy_json) as { preset: string }).preset;

  // Two missions and a Play with a clean record; a third with five clean tasks and one that will be sent back.
  const review = await cleanMission(ctx, "review", 5, { autonomy: "supervised", title: "Weekly vendor review" });
  const close = await cleanMission(ctx, "close", 5, { autonomy: "supervised", title: "Month-end close" });
  const slip = await missionWithTasks(ctx, "slip", 6, { autonomy: "supervised", title: "Contract renewal" });
  await finishTasks(ctx, slip, tasksOf(1, 5));
  await cleanPlayMissions(ctx, "runbook", "checklist-runbook", 5);

  // Nothing is asked of the owner on Today: a suggestion is never an attention item.
  await page.goto(`${governor.url}/w/ws-autonomy/today`);
  await expect(page.getByRole("heading", { name: "Today" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/autonomy suggestion/i)).toHaveCount(0);

  // The Quality page lists every suggestion of the workspace, each with its figures.
  await page.goto(`${governor.url}/quality`);
  const all = page.getByTestId("autonomy-suggestion");
  await expect(all).toHaveCount(4, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Let Weekly vendor review work at Standard?" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: /^Let .* work at Standard\?$/ })).toHaveCount(3);
  await expect(page.getByRole("heading", { name: /Start missions from .* at Autonomous\?/ })).toHaveCount(1);

  // The mission page shows its own: one step up, the figures, what each counts and what it needs, and where to look.
  await page.goto(`${governor.url}/missions/${review}/live`);
  const card = page.getByTestId("autonomy-suggestion");
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId("autonomy-heading")).toHaveText("Let Weekly vendor review work at Standard?");
  await expect(card).toContainText("Now: Supervised. Suggested: Standard.");
  await expect(card.getByTestId("autonomy-figure")).toHaveCount(5);
  const completed = card.locator('[data-figure="completed-tasks"]');
  await expect(completed.getByTestId("autonomy-figure-value")).toHaveText("5");
  await expect(completed.getByTestId("autonomy-figure-definition")).toContainText("Tasks that reached Done in the counted period");
  await expect(completed).toContainText("Needs: at least 5");
  await expect(card.locator('[data-figure="verified-rate"]').getByTestId("autonomy-figure-value")).toHaveText("100% (5 of 5)");
  await expect(card.getByTestId("autonomy-counted")).toContainText("Counted over the last 30 days.");
  await expect(card.getByTestId("autonomy-effects")).toContainText("Never approves an effect");
  // The evidence is a link away: the eval cases the record would have saved, none so far.
  await expect(card.getByTestId("autonomy-evidence-cases")).toContainText("Eval cases: 0 in the last 30 days");
  await card.getByTestId("autonomy-evidence-cases").click();
  await expect(page).toHaveURL(/\/w\/ws-autonomy\/quality\/cases/);
  await page.goBack();
  await expect(card.getByTestId("autonomy-heading")).toBeVisible({ timeout: 20_000 });

  // Not now: remembered, so it is not asked again, and nothing changed.
  await card.getByTestId("autonomy-dismiss").click();
  await expect(page.getByText("Dismissed. It will not be suggested again until there is new evidence.")).toBeVisible();
  expect(presetOf(review)).toBe("supervised");
  await page.reload();
  await expect(page.getByTestId("autonomy-suggestion")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Weekly vendor review" }).first()).toBeVisible({ timeout: 20_000 });

  // Accept on another mission: the preset goes up one step, recorded under the owner's name with the figures.
  await page.goto(`${governor.url}/missions/${close}/live`);
  await page.getByTestId("autonomy-accept").click();
  await expect(page.getByText("Accepted: Month-end close is now Standard.")).toBeVisible();
  expect(presetOf(close)).toBe("standard");
  const record = db.prepare("SELECT decision, decided_by, from_value, to_value, figures_json FROM autonomy_decisions WHERE subject_id=?").get(close) as { decision: string; decided_by: string; from_value: string; to_value: string; figures_json: string };
  expect(record).toMatchObject({ decision: "accepted", decided_by: scoped.actorId, from_value: "supervised", to_value: "standard" });
  expect(JSON.parse(record.figures_json).figures).toHaveLength(5);
  await page.reload();
  await expect(page.getByTestId("autonomy-suggestion")).toHaveCount(0);

  // A problem withdraws a suggestion at once: the contract renewal's sixth task is sent back, and its offer is gone on the next look.
  await page.goto(`${governor.url}/missions/${slip}/live`);
  await expect(page.getByTestId("autonomy-suggestion")).toHaveCount(1, { timeout: 20_000 });
  await sendBack(ctx, slip, "t6", "The renewal terms do not match the contract");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Contract renewal" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("autonomy-suggestion")).toHaveCount(0);

  // The Play page: its missions' record earned a step for the next mission it starts. Accepting it shows on the page, and the effects line stays.
  await page.goto(`${governor.url}/plays/checklist-runbook`);
  const playCard = page.getByTestId("autonomy-suggestion");
  await expect(playCard).toHaveCount(1, { timeout: 20_000 });
  await expect(playCard.getByTestId("autonomy-effects")).toContainText("every effect still needs its own approval");
  await playCard.getByTestId("autonomy-accept").click();
  await expect(page.getByText(/Accepted: .* is now Autonomous\./)).toBeVisible();
  await expect(page.getByText("autonomous", { exact: true }).first()).toBeVisible();
  const effectsBefore = brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() as { n: number };
  expect(effectsBefore.n).toBe(0);
  expect(errors).toEqual([]);
});
