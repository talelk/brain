import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";
test("plans: explicit confirmation creates exact work and replanning preserves history (T58, E101/E102)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Planning organization");
  await page.getByLabel(/^Email/).fill("plans@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-plans", slug: "plans" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }), "ws-plans")).actor;
  const run = (commandType: string, key: string, payload: Record<string, unknown>) => brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-plans", idempotencyKey: key, payload,
  } as never, key).receipt;
  const tasks = (inspectTitle: string) => [
    { id: "inspect", title: inspectTitle, criteria: ["Evidence is attached"], dependsOn: [] },
    { id: "verify", title: "Verify independently", criteria: ["Independent verdict passes"], dependsOn: ["inspect"] },
  ];
  run("objective.create", "objective", { title: "Stabilize planning", intent: "Create reviewed work only", successCriteria: ["Every task is reviewed"] });
  const objective = brain.store.workspaceDb("ws-plans", actor.organizationId).prepare("SELECT id FROM objectives").get() as { id: string };
  run("plan.propose", "plan-1", { objectiveId: objective.id, origin: "manual", summary: "Review the two-step strategy", tasks: tasks("Inspect current state") });
  const db = brain.store.workspaceDb("ws-plans", actor.organizationId);
  const firstPlan = db.prepare("SELECT id FROM plan_versions WHERE revision=1").get() as { id: string };
  db.prepare("INSERT INTO planning_requests(objective_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,'seed-plan-1','ready',?,?,?)")
    .run(objective.id, actor.actorId, firstPlan.id, brain.store.now(), brain.store.now());
  expect((db.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number }).count).toBe(0);

  await page.goto(`${governor.url}/w/ws-plans/plans?objective=${encodeURIComponent(objective.id)}`);
  await expect(page.getByText("Review the two-step strategy", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => (db.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number }).count).toBe(2);
  const firstInspect = db.prepare("SELECT id FROM work_items WHERE plan_task_id='inspect'").get() as { id: string };
  const firstVerify = db.prepare("SELECT id FROM work_items WHERE plan_task_id='verify'").get() as { id: string };

  run("plan.propose", "plan-2", { objectiveId: objective.id, origin: "manual", summary: "Review the revised strategy", tasks: tasks("Inspect changed state") });
  const secondPlan = db.prepare("SELECT id FROM plan_versions WHERE revision=2").get() as { id: string };
  db.prepare("UPDATE planning_requests SET run_id='seed-plan-2',state='ready',plan_version_id=?,updated_at_ms=? WHERE objective_id=?").run(secondPlan.id, brain.store.now(), objective.id);
  await expect(page.getByText("Review the revised strategy", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => (db.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number }).count).toBe(3);
  expect((db.prepare("SELECT state FROM work_items WHERE id=?").get(firstInspect.id) as { state: string }).state).toBe("abandoned");
  expect((db.prepare("SELECT id FROM work_items WHERE id=?").get(firstVerify.id) as { id: string }).id).toBe(firstVerify.id);
  expect((db.prepare("SELECT title FROM work_items WHERE plan_task_id='inspect' AND state!='abandoned'").get() as { title: string }).title).toBe("Inspect changed state");
  expect(errors).toEqual([]);
});
