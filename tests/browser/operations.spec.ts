import { test, expect } from "./fixtures";
const DIGEST_A = `sha256:${"a".repeat(64)}`;

// T36: operations controls — an operator drains then quarantines a runner
// from Settings with a recorded reason; state changes are server-authoritative.
test("operations: drain and quarantine a runner from settings (T36)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Ops organization");
  await page.getByLabel(/^Email/).fill("ops@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();

  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-ops", slug: "ops" });
  brain.store.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES ('runner-ops-1', ?, 'fixture', ?, 'enabled', 'healthy', ?, 4000, 8192, 10240, 4)`)
    .run(actor.organizationId, DIGEST_A, DIGEST_A);
  const adminState = () => (brain.store.control.prepare("SELECT admin_state FROM runners WHERE id='runner-ops-1'").get() as { admin_state: string }).admin_state;

  await page.reload();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText(/runner-ops-1/)).toBeVisible();

  // No reason: refused client-side, state untouched.
  await page.getByRole("button", { name: "Drain runner runner-ops-1", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/operations reason/i);
  expect(adminState()).toBe("enabled");

  await page.getByLabel(/^Operations reason/).fill("kernel upgrade window");
  await page.getByRole("button", { name: "Drain runner runner-ops-1", exact: true }).click();
  await expect.poll(adminState).toBe("draining");
  await expect(page.getByText("draining", { exact: true })).toBeVisible();

  await page.getByLabel(/^Operations reason/).fill("suspected compromise");
  await page.getByRole("button", { name: "Quarantine runner runner-ops-1", exact: true }).click();
  await expect.poll(adminState).toBe("quarantined");
  expect(errors).toEqual([]);
});
