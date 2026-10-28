import { test, expect } from "./fixtures";

// T34: Work area lists decisions/support/SRE/delivery from the pack queries.
test("work area shows decisions, tickets, incidents and delivery (T34)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Work organization");
  await page.getByLabel(/^Email/).fill("worker@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-work", slug: "work" });
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-work', ?, ?, 'operator', 1, ?, ?)")
    .run(actor.organizationId, actor.actorId, actor.actorId, Date.now());
  const scoped = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }), "ws-work");
  Object.assign(actor, scoped.actor);
  brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: "cmd-work-1", commandType: "board.create",
    workspaceId: "ws-work", idempotencyKey: "work-1",
    payload: { title: "Golden workflow", criteria: ["c1"] },
  }, "work-corr");
  const card = brain.store.workspaceDb("ws-work", actor.organizationId)
    .prepare("SELECT id FROM cards LIMIT 1").get() as { id: string };
  brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: "cmd-work-2", commandType: "decision.record",
    workspaceId: "ws-work", idempotencyKey: "work-2", expectedVersion: 1,
    payload: { cardId: card.id, decision: "go", note: "ship the golden workflow" },
  }, "work-corr");

  await page.reload();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("ship the golden workflow")).toBeVisible();
  await expect(page.getByText("No support tickets.")).toBeVisible();
  await expect(page.getByText("No incidents.")).toBeVisible();
  await expect(page.getByText("No delivery dossiers.")).toBeVisible();
  expect(errors).toEqual([]);
});
