import { test, expect } from "./fixtures";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";

// A first-time owner reads spend over time (#112, ADR 0059): the workspace usage block and a mission each open a daily chart whose values are
// also a table, with its definition and the zero days in place; the workspace block also shows cost per verified task by agent and Play.
const DAY = 86_400_000;

test("spend history: a daily chart on the workspace and the mission, and cost per verified task by agent and Play", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "spend");
  brain.createWorkspace(actor, { workspaceId: "ws-spend", slug: "spend" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const ws = (await brain.resolveActor(new Headers({ cookie }), "ws-spend")).actor;
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-spend", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await command("mission.create", "s-create", { title: "Quarterly report", intent: "Write the report", successCriteria: ["done"] })).resourceId ?? "";
  const planId = (await command("plan.propose", "s-plan", { missionId, origin: "manual", tasks: [
    { id: "a", title: "Gather the figures", criteria: ["gathered"], dependsOn: [] }, { id: "b", title: "Write it up", criteria: ["written"], dependsOn: [] },
  ] })).resourceId ?? "";
  await command("plan.confirm", "s-confirm", { planVersionId: planId }, 1);

  // Two days of settled spend, three and nine days ago, by two agents; both tasks reached Done.
  const db = brain.store.workspaceDb("ws-spend", actor.organizationId);
  const now = brain.store.now();
  const items = db.prepare("SELECT id, plan_task_id FROM work_items WHERE mission_id=? ORDER BY plan_task_id").all(missionId) as Array<{ id: string; plan_task_id: string }>;
  const spend = db.prepare(`INSERT INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,settled_micro_usd,input_tokens,output_tokens,cached_input_tokens,accounting,source,agent_id,member_id,engine_id,model_id,created_at_ms,settled_at_ms)
    VALUES (?,?,?,0,?,?,?,0,'final-total','attempt',?,?,'pi','acme-hosted',?,?)`);
  const rows: Array<[string, number, string, number]> = [["a", 3, "task-worker", 420_000], ["b", 9, "operations-assistant", 180_000]];
  let seq = 8000;
  for (const [plan, daysAgo, agent, microUsd] of rows) {
    const item = items.find((entry) => entry.plan_task_id === plan)!;
    const at = now - daysAgo * DAY;
    brain.missions.linkExecution(actor, "ws-spend", item.id, `run-s-${plan}`);
    spend.run(`att-s-${plan}`, missionId, `run-s-${plan}`, microUsd, 1000, 200, agent, plan, at, at);
    db.prepare("INSERT INTO events(event_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(`seed-s-${seq}`, "workItem", item.id, seq++, "workItem.transitioned", JSON.stringify({ workItemId: item.id, state: "done" }), "sha256:seed", at);
  }
  db.prepare("UPDATE missions SET play_id='quarterly-report' WHERE id=?").run(missionId);

  // The workspace: Missions lists the usage block; the chart opens from "Spend over time".
  await page.goto(`${governor.url}/w/ws-spend/missions`);
  const block = page.getByTestId("workspace-usage");
  await expect(block).toBeVisible({ timeout: 20_000 });
  await block.getByTestId("workspace-spend-history").getByText("Spend over time", { exact: true }).click();
  const history = page.getByTestId("workspace-spend-history");
  await expect(history.getByTestId("spend-total")).toContainText("$0.60 over the last 30 days");
  await expect(history.getByTestId("daily-bar")).toHaveCount(30);
  const values = await history.getByTestId("daily-bar").evaluateAll((bars) => bars.map((bar) => Number(bar.getAttribute("data-value"))));
  expect(values.filter((value) => value > 0)).toEqual([180_000, 420_000]);
  expect(values.filter((value) => value === 0)).toHaveLength(28);
  expect(await history.getByTestId("spend-chart").getByRole("img").getAttribute("aria-label")).toContain("$0.42");
  await expect(history).toContainText("Definition: Settled model spend per UTC day");
  // The same numbers as a table, zero days included.
  await history.getByText("Show as a table", { exact: true }).click();
  await expect(history.getByTestId("spend-table").locator("tbody tr")).toHaveCount(30);
  await expect(history.getByTestId("spend-table")).toContainText("$0.42");
  await expect(history.getByTestId("spend-table")).toContainText("$0.18");
  await history.getByTestId("daily-bar").nth(values.indexOf(420_000)).hover();
  await expect(history.getByTestId("daily-bars-readout")).toContainText("$0.42");

  // Cost per verified task by agent and by Play, each with its definition.
  await page.getByTestId("verified-cost").getByText("Cost per verified task", { exact: true }).click();
  const byAgent = page.getByTestId("verified-by-agent");
  await expect(byAgent.locator('[data-row="task-worker"]')).toContainText("$0.42");
  await expect(byAgent.locator('[data-row="operations-assistant"]')).toContainText("$0.18");
  await expect(byAgent).toContainText("divided by tasks that reached Done");
  const byPlay = page.getByTestId("verified-by-play");
  await expect(byPlay.locator('[data-row="quarterly-report"]')).toContainText("$0.30");
  await expect(byPlay.locator('[data-row="quarterly-report"]')).toContainText("2");
  await expect(byPlay).toContainText("started from the Play");

  // The mission: the same chart, scoped to its own spend.
  await page.goto(`${governor.url}/missions/${missionId}/live`);
  const mission = page.getByTestId("mission-spend-history");
  await mission.getByText("Spend over time", { exact: true }).click();
  await expect(mission.getByTestId("spend-total")).toContainText("$0.60 over the last 30 days");
  await expect(mission.getByTestId("daily-bar")).toHaveCount(30);
  expect(errors).toEqual([]);
});
