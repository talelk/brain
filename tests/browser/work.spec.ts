import { test, expect } from "./fixtures";

// T34: Work area lists support/SRE/delivery from the pack queries.
test("work area shows tickets, incidents and delivery (T34)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Work organization");
  await page.getByLabel(/^Email/).fill("worker@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();

  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-work", slug: "work" });
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-work', ?, ?, 'operator', 1, ?, ?)")
    .run(actor.organizationId, actor.actorId, actor.actorId, Date.now());
  const scoped = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }), "ws-work");
  Object.assign(actor, scoped.actor);
  const seeded = Date.now();
  const wdb = brain.store.workspaceDb("ws-work", actor.organizationId);
  wdb.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-work','Golden workflow','Prove the work screens','[\"c1\"]',?,?,?)").run(actor.actorId, seeded, seeded);
  wdb.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms,confirmed_at_ms) VALUES ('plan-work','obj-work',1,?,'confirmed','manual',?,?,?,?)")
    .run(`sha256:${"d".repeat(64)}`, actor.actorId, JSON.stringify([{ id: "golden", title: "Golden workflow", criteria: ["c1"], dependsOn: [] }]), seeded, seeded);
  wdb.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('work-golden','obj-work','plan-work','golden','Golden workflow','review','[\"c1\"]','Review acceptance and evidence',?,?)").run(seeded, seeded);

  await page.reload();
  // Each pack view is its own contract route under the workspace.
  await page.goto(`${governor.url}/w/ws-work/support`);
  await expect(page.getByRole("heading", { name: "Support", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("No support tickets")).toBeVisible();
  await page.goto(`${governor.url}/w/ws-work/sre`);
  await expect(page.getByRole("heading", { name: "Incidents", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("No incidents")).toBeVisible();
  await page.goto(`${governor.url}/w/ws-work/delivery`);
  await expect(page.getByRole("heading", { name: "Delivery", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("No delivery dossiers")).toBeVisible();
  expect(errors).toEqual([]);
});
