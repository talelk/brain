import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";
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
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();

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
  // Runner operations live on the runner detail route of the Runs area.
  await page.goto(`${governor.url}/runners/runner-ops-1`);
  await expect(page.getByRole("heading", { name: "Runner detail", exact: true, level: 1 })).toBeVisible();

  // Reason-bound confirmation: the command stays disabled until the reason exists.
  await page.getByRole("button", { name: "Drain runner", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Drain this runner", exact: true })).toBeDisabled();
  expect(adminState()).toBe("enabled");

  await dialog.getByLabel(/^Operations reason/).fill("kernel upgrade window");
  await dialog.getByRole("button", { name: "Drain this runner", exact: true }).click();
  await expect.poll(adminState).toBe("draining");
  await expect(page.getByText("Draining", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Quarantine runner", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Operations reason/).fill("suspected compromise");
  await dialog.getByRole("button", { name: "Quarantine this runner", exact: true }).click();
  await expect.poll(adminState).toBe("quarantined");
  expect(errors).toEqual([]);
});

test("operations: issue a one-use enrollment token and enroll an outbound runner", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Enrollment organization");
  await page.getByLabel(/^Email/).fill("enrollment@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-enrollment", slug: "enrollment" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);

  await page.goto(`${governor.url}/runners`);
  await page.getByRole("button", { name: "Enroll runner", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Runner group", { exact: true }).fill("fixture-tools");
  await dialog.getByRole("button", { name: "Issue one-use token", exact: true }).click();
  const token = await dialog.getByLabel("One-use enrollment token", { exact: true }).inputValue();
  expect(token.length).toBeGreaterThan(20);
  brain.jobProtocol.enrollRunner({ token, publicKeyPem: "-----BEGIN PUBLIC KEY-----\nbrowser-runner\n-----END PUBLIC KEY-----", runnerId: "runner-browser-enrolled" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("runner-browser-enrolled", { exact: true })).toBeVisible();
  const consumed = brain.store.control.prepare("SELECT consumed_at_ms,runner_id FROM enrollment_tokens").get() as { consumed_at_ms: number; runner_id: string };
  expect(consumed.consumed_at_ms).toEqual(expect.any(Number));
  expect(consumed.runner_id).toBe("runner-browser-enrolled");
  expect(errors).toEqual([]);
});
