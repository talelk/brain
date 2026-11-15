import { test, expect } from "./fixtures";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";
import { pastRun, seedPastRunner } from "../support/past-runs";
import type { PlanTask } from "@brain/contracts";
import type { TestWorld } from "../helpers";

// Estimates from history (#132): a first-time user opens the plan of a mission from a Play that has run before and reads what it may take, with
// the basis of every figure: the median of past runs, or what the planner declared. The Governor computes it; no model does. The estimate never
// changes a budget: Change limits offers the suggestion and the person decides.

test("a plan's estimate says where it comes from, and the limits dialog offers a suggestion that changes nothing until saved", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "estimates");
  brain.createWorkspace(actor, { workspaceId: "ws-estimates", slug: "estimates" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-estimates")).actor;
  const w = { brain, org: actor.organizationId, owner: scoped, workspaceId: "ws-estimates" } as unknown as TestWorld;
  const db = brain.store.workspaceDb("ws-estimates", actor.organizationId);
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-estimates", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;

  // Before any history: the Play's task shows what the planner declared.
  const before = (await command("mission.create", "e-first", { title: "Status for week 1", playId: "weekly-status", autoStart: false, budget: { maxMicroUsd: 2_000_000, memberCap: 3 } })).resourceId ?? "";
  await page.goto(`${governor.url}/missions/${before}/plan`);
  const estimate = page.getByTestId("plan-estimate");
  await expect(estimate.getByTestId("estimate-time")).toContainText("declared by the planner", { timeout: 15_000 });
  await expect(estimate.getByTestId("estimate-time")).not.toContainText("median of");
  await expect(estimate).toContainText("estimate");

  // Four earlier missions from the same Play finished their first task in 5, 7, 9 and 20 minutes for 120, 150, 180 and 400 thousandths of a cent.
  const planned = JSON.parse((db.prepare("SELECT tasks_json FROM plan_versions WHERE mission_id=?").get(before) as { tasks_json: string }).tasks_json) as PlanTask[];
  const collect = planned.find((task) => task.id === "collect")!;
  const ctx = { w, runner: seedPastRunner(w), count: { value: 0 } };
  for (const [minutes, microUsd] of [[5, 120_000], [7, 150_000], [9, 180_000], [20, 400_000]] as const) await pastRun(ctx, { playId: "weekly-status", task: collect, minutes, microUsd });

  // A new mission from the Play: its plan now rests on those runs (median 8 min, $0.165), and says so; the other tasks keep the planner's figures.
  const next = (await command("mission.create", "e-second", { title: "Status for week 2", playId: "weekly-status", autoStart: false, budget: { maxMicroUsd: 2_000_000, memberCap: 3 } })).resourceId ?? "";
  await page.goto(`${governor.url}/missions/${next}/plan`);
  await expect(estimate.getByTestId("estimate-time-basis")).toContainText("median of at least 4 runs", { timeout: 15_000 });
  await expect(estimate.getByTestId("estimate-time")).toContainText("typically");
  await expect(estimate.getByTestId("estimate-cost")).toContainText("about $0.17");
  await expect(estimate.getByTestId("estimate-cost-basis")).toContainText("median of 4 runs");
  await page.getByText("Estimate for each task").click();
  await expect(estimate.getByRole("list", { name: "Estimates by task" })).toContainText("about 8 min (median of 4 runs)");
  await expect(estimate.getByRole("list", { name: "Estimates by task" })).toContainText("declared by the planner");
  await expect(page.getByText("No task has a time estimate")).toHaveCount(0);

  // The limits dialog offers what history suggests; taking it only fills the field.
  const budgetOf = () => (db.prepare("SELECT budget_micro_usd AS usd, budget_wall_ms AS wall, version FROM missions WHERE id=?").get(next) as { usd: number; wall: number | null; version: number });
  const stored = budgetOf();
  await page.getByRole("button", { name: "Change limits" }).click();
  const dialog = page.getByRole("dialog");
  const suggestion = dialog.getByTestId("suggested-limits");
  await expect(suggestion).toContainText("Suggested from past runs. Nothing changes until you save the limits.");
  await expect(suggestion.getByTestId("suggested-dollars")).toContainText("median of");
  await expect(dialog.getByLabel(/^Dollar budget/)).toHaveValue("2");
  await suggestion.getByTestId("suggested-dollars").getByRole("button", { name: "Use suggested" }).click();
  await expect(dialog.getByLabel(/^Dollar budget/)).not.toHaveValue("2");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(budgetOf()).toEqual(stored); // the suggestion changed nothing by itself
  await page.getByRole("button", { name: "Change limits" }).click();
  await expect(page.getByRole("dialog").getByLabel(/^Dollar budget/)).toHaveValue("2");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect(errors).toEqual([]);
});
