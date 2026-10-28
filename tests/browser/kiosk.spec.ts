import { test, expect } from "./fixtures";
const DIGEST_A = `sha256:${"a".repeat(64)}`;

// T34: TV kiosk is a read-only auto-refreshing operations board; Work detail
// screens fetch the exact record behind a list row.
test("tv kiosk renders read-only board; ticket detail opens exact record (T34)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Kiosk organization");
  await page.getByLabel(/^Email/).fill("kiosk@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();

  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-kiosk", slug: "kiosk" });
  const ws = brain.store.workspaceDb("ws-kiosk", actor.organizationId);
  ws.prepare("INSERT INTO tickets(id, connector_id, remote_id, state, title, body_digest, source_version, observed_at_ms) VALUES ('tkt-1','gitlab','42','open','Printer on fire',?,'v1',?)")
    .run(DIGEST_A, Date.now());

  await page.reload();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByText("Printer on fire")).toBeVisible();
  await page.getByRole("button", { name: "Details for ticket Printer on fire", exact: true }).click();
  const detail = page.getByRole("region", { name: "Detail", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("tkt-1");
  await expect(detail).toContainText("Printer on fire");
  await expect(detail).toContainText("sourceVersion");
  await page.getByRole("button", { name: "Close detail", exact: true }).click();
  await expect(detail).toHaveCount(0);

  await page.goto(`${governor.url}/?tv=1`);
  await expect(page.getByTestId("tv-kiosk")).toBeVisible();
  await expect(page.getByRole("heading", { name: /operations board/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
