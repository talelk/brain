import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { ActorContext } from "@brain/contracts";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { startPushReceiver } from "../support/push-receiver";
import { test, expect } from "./fixtures";

// A first-time owner is offered push where something first needs them (Needs you on Today), turns it on, is pushed when new work needs
// them, turns it off for this device from Settings, and is no longer pushed. The browser's push service is the one thing replaced: a
// headless browser cannot reach a real one, so subscribing hands back a subscription to a local push service that decrypts what arrives.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `push-${name}-${page.viewportSize()?.width}.png`), fullPage: true });
};

test("opt in on Needs you, get pushed when work needs you, opt out per device in settings", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const device = await startPushReceiver("/push/this-browser");
  try {
    await page.addInitScript((subscription) => {
      // The browser's notification permission (asked once, remembered) and its own push subscription, kept across reloads the way real ones are.
      const ASKED = "test-notification-permission";
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => localStorage.getItem(ASKED) ?? "default" });
      Notification.requestPermission = async () => { localStorage.setItem(ASKED, "granted"); return "granted"; };
      const KEY = "test-push-subscription";
      const make = () => ({
        endpoint: subscription.endpoint,
        toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }),
        unsubscribe: async () => { localStorage.removeItem(KEY); return true; },
      });
      PushManager.prototype.getSubscription = async () => (localStorage.getItem(KEY) ? (make() as unknown as PushSubscription) : null);
      PushManager.prototype.subscribe = async () => { localStorage.setItem(KEY, "1"); return make() as unknown as PushSubscription; };
    }, device.subscription);

    await page.goto(governor.url);
    await page.getByLabel(/^Setup credential/).fill(governor.credential);
    await page.getByLabel(/^Organization name/).fill("Push organization");
    await page.getByLabel(/^Email/).fill("push@example.test");
    await page.getByLabel(/^Password/).fill("browser-password-1234");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
    await page.getByLabel("Display name").fill("Push workspace");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
    const workspaceId = /\/w\/([^/]+)\/today/u.exec(page.url())?.[1] ?? "";
    expect(workspaceId).not.toBe("");

    // Nothing needs the person yet, so nothing is offered: push is offered where it is first needed.
    await expect(page.getByTestId("push-offer")).toHaveCount(0);

    // Work arrives that needs a decision: a plan to confirm.
    const brain = governor.app.brain;
    const cookies = await page.context().cookies();
    const identity = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }), workspaceId)).actor;
    const actor: ActorContext = { ...identity, workspaceId, scopes: scopesForPrincipal(brain.store, identity.actorId, identity.organizationId, workspaceId) };
    const propose = async (title: string) => {
      const slug = title.toLowerCase().replace(/[^a-z]+/gu, "-");
      const created = (await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${slug}-c`, commandType: "mission.create", workspaceId, idempotencyKey: `${slug}-c`, payload: { title, intent: `${title} intent`, successCriteria: ["done"], autoStart: false } } as never, `${slug}-c`)).receipt;
      const missionId = created.resourceId ?? "";
      const plan = (await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${slug}-p`, commandType: "plan.propose", workspaceId, idempotencyKey: `${slug}-p`, payload: { missionId, origin: "manual", summary: `Plan for ${title}`, tasks: [{ id: "t", title: `${title} task`, criteria: ["The note exists"], dependsOn: [] }] } } as never, `${slug}-p`)).receipt;
      return { missionId, planId: plan.resourceId ?? "" };
    };
    const first = await propose("Venue shortlist");
    brain.notifyAttention(); // told in the inbox already, with no device to push to yet
    await page.reload();
    const offer = page.getByTestId("push-offer");
    await expect(page.getByRole("heading", { name: "Needs you", level: 2 })).toBeVisible();
    await expect(offer).toBeVisible();
    await expect(offer).toContainText("Get a notification on this device when something needs you");
    await shot(page, "1-offer");

    await offer.getByRole("button", { name: "Turn on notifications", exact: true }).click();
    await expect(page.getByTestId("push-offer-done")).toContainText("Notifications are on for this device.");
    await expect(offer).toHaveCount(0);
    expect(brain.store.control.prepare("SELECT COUNT(*) AS n FROM notification_subscriptions").get()).toEqual({ n: 1 });
    await shot(page, "2-on");

    // The next thing that needs the person reaches this device, once, and links to where it is decided.
    const second = await propose("Catering quote");
    brain.notifyAttention(); // the maintenance pass, which the test server does not run on a timer
    await expect.poll(() => device.messages.length, { timeout: 30_000 }).toBe(1);
    expect(device.messages[0]).toEqual({ title: "Plan proposal for Catering quote", body: "A mission needs you.", url: `/missions/${second.missionId}/plan?w=${workspaceId}&proposal=${second.planId}` });
    expect(first.missionId).not.toBe(second.missionId);

    // Settings says the same for this device, and turns it off.
    await page.goto(`${governor.url}/settings?tab=security`);
    const control = page.getByTestId("push-device");
    await expect(control).toContainText("Notifications are on for this device.");
    await shot(page, "3-settings-on");
    const accessibility = await new AxeBuilder({ page }).include('[data-testid="push-device"]').analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"), "push control accessibility").toEqual([]);
    await control.getByRole("button", { name: "Turn off on this device", exact: true }).click();
    await expect(control).toContainText("Notifications are off for this device.");
    await expect(control.getByRole("button", { name: "Turn on for this device", exact: true })).toBeVisible();
    expect(brain.store.control.prepare("SELECT COUNT(*) AS n FROM notification_subscriptions").get()).toEqual({ n: 0 });
    await shot(page, "4-settings-off");

    // Turned off: new work that needs the person is in the inbox but is not pushed here, however long the pass has had.
    await propose("Speaker briefing");
    expect(brain.notifyAttention()).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1500);
    expect(device.messages).toHaveLength(1);
    expect(device.requests).toHaveLength(1);

    // It stays off after a reload, and Today offers it again until the person says "Not now" on this device.
    await page.reload();
    await expect(control).toContainText("Notifications are off for this device.");
    await page.goto(`${governor.url}/w/${workspaceId}/today`);
    await expect(page.getByTestId("push-offer")).toBeVisible();
    await page.getByTestId("push-offer").getByRole("button", { name: "Not now", exact: true }).click();
    await expect(page.getByTestId("push-offer")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Needs you", level: 2 })).toBeVisible();
    await expect(page.getByTestId("push-offer")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await device.close(); }
});

test("a browser that blocked notifications is told so, in settings, and is not offered them", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { Object.defineProperty(Notification, "permission", { get: () => "denied" }); });
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Blocked organization");
  await page.getByLabel(/^Email/).fill("blocked@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  await page.getByLabel("Display name").fill("Blocked workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  await page.goto(`${governor.url}/settings?tab=security`);
  const control = page.getByTestId("push-device");
  await expect(control).toContainText("This browser blocks notifications from Brain");
  await expect(control.getByRole("button")).toHaveCount(0);
  expect(errors).toEqual([]);
});
