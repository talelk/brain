import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

test("quality page shows each metric with its definition and window; a ready result is listed but never counted as waiting (#63, #52)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Quality organization");
  await page.getByLabel(/^Email/).fill("quality@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-quality", slug: "quality" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);
  const ws = { ...actor, workspaceId: "ws-quality", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-quality") };
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-quality", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await command("mission.create", "q-create", { title: "Ship the report", intent: "Ship the report", successCriteria: ["shipped"] })).resourceId ?? "";
  const planId = (await command("plan.propose", "q-plan", { missionId, origin: "manual", tasks: [{ id: "a", title: "Write the report", criteria: ["written"], dependsOn: [] }] })).resourceId ?? "";
  await command("plan.confirm", "q-confirm", { planVersionId: planId }, 1);
  const db = brain.store.workspaceDb("ws-quality", actor.organizationId);
  const item = db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string };
  const now = brain.store.now();
  db.prepare("UPDATE work_items SET state='done', evidence_digest=?, updated_at_ms=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, now, item.id);
  db.prepare("INSERT INTO events(event_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES ('q-done','workItem',?,900,'workItem.transitioned',?,'sha256:seed',?)")
    .run(item.id, JSON.stringify({ workItemId: item.id, state: "done" }), now);
  db.prepare("INSERT INTO handoffs(id,mission_id,work_item_id,version,notes_json,submitted_by,created_at_ms) VALUES ('q-handoff',?,?,1,'{}','governor',?)").run(missionId, item.id, now);

  await page.goto(`${governor.url}/w/ws-quality/missions`);
  await page.getByRole("button", { name: "Needs you: nothing waiting" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Result ready: Write the report is verified and done")).toBeVisible();
  await expect(drawer.getByText("Never block anything", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`${governor.url}/quality`);
  await expect(page.getByRole("heading", { name: "Quality", exact: true }).first()).toBeVisible();
  const verified = page.locator('[data-metric="verified-unaided"]');
  await expect(verified).toContainText("100%");
  await expect(verified).toContainText("1 of 1");
  await expect(verified).toContainText("Definition:");
  await expect(verified).toContainText("last 30 days");
  await expect(page.locator('[data-metric="stall-rate"]')).toContainText("0%");
  await expect(page.locator('[data-metric="reopen-rate"]')).toContainText("No data yet");
  await expect(page.locator('[data-metric]')).toHaveCount(5);
  await expect(page.getByText("No tasks were parked in this window.")).toBeVisible();
  expect(errors).toEqual([]);
});
