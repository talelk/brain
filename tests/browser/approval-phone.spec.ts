import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { totpCode } from "../support/totp";
import { seedBrowserDemo } from "../support/browserDemo";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PHONE = { width: 390, height: 844 };

/** One approval of an effect the way the engine proposes it: a plain summary, the exact input, and the pinned target. */
function proposeEffect(brain: import("../../apps/governor/src/application/brain").Brain, organizationId: string, workspaceId: string, stepId: string) {
  const subject = {
    organizationId, workspaceId, operation: "host.restart", tool: { id: "host.restart", digest: DIGEST }, inputDigest: DIGEST,
    target: { targetId: "web-1", environmentId: "demo-host", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: DIGEST,
    effectBounds: { summary: "Restart the web-1 container on the demo host", arguments: { container: "web-1", reason: "memory above 90% for ten minutes" }, attemptId: "att-1", proposalId: "p-1", once: true },
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), nonce: `phone-${stepId}`,
  };
  return brain.createApprovalForGate({ organizationId, workspaceId, runId: "phone-run", stepId, subject: subject as never, expiresAtMs: Date.now() + 30 * 60_000, requestedBy: "phone-requester" });
}

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

/**
 * Approving an effect must be great on a phone (backlog row 89): the link in the notification, `/approvals/:id`, opens one card with what
 * will happen in plain words, the exact target, what it is given, and Approve or Deny, at 390 px, with nothing to scroll sideways.
 */
test.describe("approval on a phone, with an authenticator", () => {
  test.use({ requireTwoFactor: true, viewport: PHONE });
  test("the deep link opens one card; Approve asks for the authenticator code and records the decision", async ({ page, governor }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(governor.url);
    await page.getByLabel(/^Setup credential/).fill(governor.credential);
    await page.getByLabel(/^Organization name/).fill("Phone organization");
    await page.getByLabel(/^Email/).fill("phone@example.test");
    await page.getByLabel(/^Password/).fill("browser-password-1234");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page.getByRole("region", { name: "Authenticator setup" })).toBeVisible();
    await page.getByLabel(/^Confirm password/).fill("browser-password-1234");
    await page.getByRole("button", { name: "Begin setup", exact: true }).click();
    const link = page.getByRole("link", { name: "Keyrus Brain to your authenticator", exact: true });
    await expect(link).toBeVisible();
    const secret = new URL((await link.getAttribute("href"))!).searchParams.get("secret")!;
    await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
    await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
    await expect(page.getByRole("region", { name: "Authenticator setup" })).toHaveCount(0);

    const brain = governor.app.brain;
    const cookies = await page.context().cookies();
    const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }))).actor;
    brain.createWorkspace(actor, { workspaceId: "ws-phone", slug: "phone" });
    brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-phone', ?, ?, 'approver', 1, ?, ?)").run(actor.organizationId, actor.actorId, actor.actorId, Date.now());
    brain.ensurePrincipal(actor.organizationId, "phone-requester", "human");
    const approvalId = proposeEffect(brain, actor.organizationId, "ws-phone", "approve");

    await page.goto(`${governor.url}/approvals/${approvalId}`);
    const card = page.locator("[data-approval-card]");
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Plain words first: the summary leads, then what happens, the exact target and what it is given.
    await expect(page.getByTestId("needs-you-item").getByRole("heading", { level: 3 })).toHaveText("Restart the web-1 container on the demo host");
    await expect(card.locator("[data-approval-what]")).toContainText("Restart");
    await expect(card.locator("[data-approval-target]")).toHaveText("web-1 in demo-host");
    await expect(card.locator("[data-approval-arguments]")).toContainText("container: web-1");
    await expect(card.locator("[data-approval-arguments]")).toContainText("reason: memory above 90% for ten minutes");
    await expect(card).not.toContainText("attemptId");
    // Both decisions are in view on a phone without scrolling, and nothing scrolls sideways.
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    const deny = page.getByRole("button", { name: "Deny", exact: true });
    await expect(approve).toBeVisible();
    await expect(deny).toBeVisible();
    for (const button of [approve, deny]) { const box = (await button.boundingBox())!; expect(box.y + box.height, "decision buttons sit above the fold").toBeLessThanOrEqual(PHONE.height); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width); expect(box.height, "a thumb can hit it").toBeGreaterThanOrEqual(32); }
    expect(await noSideways(page)).toBe(true);
    if (process.env["BRAIN_SHOTS"]) await page.screenshot({ path: `${process.env["BRAIN_SHOTS"]}/approval-phone-card.png`, fullPage: true });

    await approve.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify identity and approve", exact: true })).toBeDisabled();
    await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
    await page.getByRole("button", { name: "Verify identity and approve", exact: true }).click();
    await expect(page.getByText(/Decision recorded/).first()).toBeVisible();
    await expect.poll(() => (brain.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(approvalId) as { state: string }).state, { timeout: 30_000 }).toBe("approved");
    expect(errors).toEqual([]);
  });
});

test.describe("approval on a phone, signed out first", () => {
  test.use({ viewport: PHONE });
  test("a notification link signs in and lands on the same approval; Deny needs a reason and records a refusal", async ({ page, governor, browser }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const demo = await seedBrowserDemo(page, governor);
    const brain = governor.app.brain;
    const org = (brain.store.control.prepare("SELECT organization_id AS org FROM workspaces WHERE id=?").get(demo.workspaceId) as { org: string }).org;
    brain.ensurePrincipal(org, "phone-requester", "human");
    const approvalId = proposeEffect(brain, org, demo.workspaceId, "deny");

    // The link as a notification carries it, opened in a browser that is not signed in.
    const guest = await browser.newContext({ viewport: PHONE });
    const phone = await guest.newPage();
    await phone.goto(`${governor.url}/approvals/${approvalId}`);
    await phone.getByLabel(/^Email/).fill("demo@example.test");
    await phone.getByLabel(/^Password/).fill("demo-password-12345");
    await phone.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(phone).toHaveURL(new RegExp(`/approvals/${approvalId}$`));
    const card = phone.locator("[data-approval-card]");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("[data-approval-target]")).toHaveText("web-1 in demo-host");
    expect(await noSideways(phone)).toBe(true);

    await phone.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(phone.getByLabel(/^Decision note/)).toBeFocused();
    await expect(phone.getByText("A reason is required to deny.")).toBeVisible();
    await expect(phone.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
    await phone.getByLabel(/^Decision note/).fill("Not during the sprint demo");
    await phone.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(phone.getByText(/Decision recorded/).first()).toBeVisible();
    await expect.poll(() => brain.store.control.prepare("SELECT decision FROM approval_decisions WHERE approval_id=?").get(approvalId), { timeout: 30_000 }).toEqual({ decision: "reject" });
    expect(await noSideways(phone)).toBe(true);
    await guest.close();
    expect(errors).toEqual([]);
  });
});
