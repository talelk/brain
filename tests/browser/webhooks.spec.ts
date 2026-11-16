import { createHmac } from "node:crypto";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { signUpOwner } from "../support/flow";

/**
 * Spec #90 ticket #138: a first-time administrator adds a signed ticket webhook under Administration > Integrations, copies the address and
 * the secret once, and a signed incident from the ticket system then becomes a subject whose trigger starts a mission that waits for them. The
 * screen shows the last deliveries (status only), a wrong signature changes nothing, rotating the secret retires the old one at once, and the
 * secret is never shown again.
 */
const signed = (secret: string, delivery: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const stamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: { "content-type": "application/json", "x-brain-delivery": delivery, "x-brain-timestamp": stamp, "x-brain-signature": `sha256=${createHmac("sha256", secret).update(`${stamp}.${body}`).digest("hex")}` } };
};

test("an administrator adds a ticket webhook, an incident arrives and waits in Needs you, and rotation retires the old secret", async ({ page, governor }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor: organizationActor, cookie } = await signUpOwner(page, governor, "hooks");
  const actor = organizationActor;
  brain.createWorkspace(actor, { workspaceId: "ws-hooks", slug: "hooks" });
  const inWorkspace = (await brain.resolveActor(new Headers({ cookie }), "ws-hooks")).actor;
  const starter = fixtureStarter();
  brain.activateRelease(inWorkspace, brain.stageRelease(inWorkspace, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  // The subject trigger is set up on the Schedules screen elsewhere; here it is the thing a delivery starts.
  await brain.executeCommand(inWorkspace, { contractVersion: "brain.command/v1", commandId: "cmd-hook-trigger", commandType: "automation.upsert", workspaceId: "ws-hooks", idempotencyKey: "hook-trigger", payload: { title: "Every new incident", target: { kind: "play", id: "support-reply-draft" }, trigger: { kind: "subject", subjectKind: "incident" } } } as never, "hook-trigger");
  const ws = brain.store.workspaceDb("ws-hooks", actor.organizationId);
  const missions = () => (ws.prepare("SELECT COUNT(*) AS n FROM missions").get() as { n: number }).n;

  await page.goto(`${governor.url}/administration/integrations`);
  await expect(page.getByRole("heading", { name: "Integrations", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  const section = page.getByTestId("webhooks");
  await expect(page.getByRole("heading", { name: "Signed webhooks" })).toBeVisible();
  await expect(section.getByText("No webhook yet")).toBeVisible();

  // Add one: choose the source, see the secret Brain made, add it.
  await section.getByRole("button", { name: "Add a webhook", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Source").click();
  await page.getByRole("option", { name: "Ticket or incident system" }).click();
  const generated = await dialog.getByLabel("Secret", { exact: true }).inputValue();
  expect(generated).toMatch(/^[0-9a-f]{64}$/u);
  await dialog.getByRole("button", { name: "Add webhook", exact: true }).click();

  // The address and the secret are shown once, with what to do with them.
  const reveal = page.getByTestId("webhook-reveal");
  await expect(reveal.getByRole("heading", { name: "Copy the secret now" })).toBeVisible({ timeout: 20_000 });
  const url = await reveal.getByTestId("webhook-reveal-url").getByRole("textbox").inputValue();
  const secret = await reveal.getByTestId("webhook-reveal-secret").getByRole("textbox").inputValue();
  expect(url).toMatch(new RegExp(`^${governor.url}/hooks/ticket/whk-`, "u"));
  expect(secret).toBe(generated);
  await expect(reveal).toContainText("X-Brain-Signature");
  await reveal.getByRole("button", { name: "I have copied it", exact: true }).click();
  await expect(reveal).toHaveCount(0);
  const card = section.getByTestId("webhook-endpoint");
  await expect(card).toContainText("Ticket or incident system");
  await expect(card.getByTestId("webhook-url")).toContainText(url);
  await expect(card).toContainText("Nothing received yet.");
  await expect(card).toContainText("never shown again");
  await expect(page.locator("body")).not.toContainText(secret);

  // The ticket system sends a signed incident: it is recorded, and the trigger's mission waits for the administrator.
  const first = signed(secret, "inc-1", { kind: "incident", event: "opened", id: "INC-42", title: "Payments API is down", severity: "critical" });
  expect((await page.request.post(url, { headers: first.headers, data: first.body })).status()).toBe(200);
  expect(missions()).toBe(1);
  expect(ws.prepare("SELECT state FROM plan_versions").all()).toEqual([{ state: "proposed" }]);
  // A replay and a wrong signature change nothing and tell the sender nothing.
  expect(await (await page.request.post(url, { headers: first.headers, data: first.body })).json()).toEqual({ status: "duplicate" });
  const forged = signed("not-the-secret-not-the-secret", "inc-2", { kind: "incident", event: "opened", id: "INC-43", title: "Forged" });
  const refused = await page.request.post(url, { headers: forged.headers, data: forged.body });
  expect(refused.status()).toBe(401);
  expect(await refused.json()).toEqual({ error: "the request was not accepted" });
  expect(missions()).toBe(1);

  await page.reload();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const deliveries = card.getByTestId("webhook-deliveries").getByRole("listitem");
  await expect(deliveries).toHaveCount(1);
  await expect(deliveries.first()).toContainText("Recorded");
  await expect(deliveries.first()).toContainText("incident.opened");
  await expect(card).not.toContainText("Payments API is down");

  // The new mission asks for the administrator's OK; nothing was confirmed on their behalf.
  const missionId = (ws.prepare("SELECT id FROM missions").get() as { id: string }).id;
  await page.goto(`${governor.url}/missions/${missionId}/plan`);
  await expect(page.getByRole("button", { name: /Confirm/ }).first()).toBeVisible({ timeout: 30_000 });
  expect(ws.prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE state='confirmed'").get()).toEqual({ n: 0 });

  // Rotate: a new secret is shown once, the old one stops working at once and the new one works.
  await page.goto(`${governor.url}/administration/integrations`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Rotate secret", exact: true }).click();
  const rotate = page.getByRole("dialog");
  const renewed = await rotate.getByLabel("Secret", { exact: true }).inputValue();
  expect(renewed).not.toBe(secret);
  await rotate.getByRole("button", { name: "Replace secret", exact: true }).click();
  await expect(page.getByTestId("webhook-reveal").getByTestId("webhook-reveal-secret").getByRole("textbox")).toHaveValue(renewed, { timeout: 20_000 });
  await page.getByTestId("webhook-reveal").getByRole("button", { name: "I have copied it", exact: true }).click();
  await expect(card).toContainText("secret replaced");
  const old = signed(secret, "inc-3", { kind: "incident", event: "opened", id: "INC-44", title: "Old secret" });
  expect((await page.request.post(url, { headers: old.headers, data: old.body })).status()).toBe(401);
  const fresh = signed(renewed, "inc-4", { kind: "incident", event: "closed", id: "INC-42", title: "Payments API is down" });
  expect((await page.request.post(url, { headers: fresh.headers, data: fresh.body })).status()).toBe(200);
  await page.reload();
  await expect(card.getByTestId("webhook-deliveries").getByRole("listitem")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(renewed);
  expect(missions()).toBe(1);

  // A phone shows the same screen without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByTestId("webhook-url")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
