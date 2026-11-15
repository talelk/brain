import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { totpCode } from "../support/totp";

/**
 * Risk tiers (#149, ADR 0071), walked as a first-time approver: each approval says how risky it is and why, what the tier asks of the
 * decision, and a critical one waits for a second, different person after the first approves. Nothing here skips an approval.
 */
test.use({ requireTwoFactor: true });
const DIGEST = `sha256:${"a".repeat(64)}`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test("an approval shows its risk tier and reasons; a critical one needs a second person after the first approves", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Risk organization");
  await page.getByLabel(/^Email/).fill("risk@example.test");
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
  brain.createWorkspace(actor, { workspaceId: "ws-risk", slug: "risk" });
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-risk', ?, ?, 'approver', 1, ?, ?)")
    .run(actor.organizationId, actor.actorId, actor.actorId, Date.now());
  brain.ensurePrincipal(actor.organizationId, "risk-requester", "human");
  const propose = (stepId: string, tool: string, environmentId: string, summary: string, files?: Array<{ path: string; content: string }>) => brain.createApprovalForGate({
    organizationId: actor.organizationId, workspaceId: "ws-risk", runId: "risk-run", stepId, requestedBy: "risk-requester", expiresAtMs: Date.now() + 30 * 60_000,
    subject: {
      organizationId: actor.organizationId, workspaceId: "ws-risk", operation: tool, tool: { id: tool, digest: DIGEST }, inputDigest: DIGEST,
      target: { targetId: `target-${stepId}`, environmentId, preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: DIGEST,
      effectBounds: { summary, ...(files ? { arguments: { files, title: "Change", branch: "brain/change" } } : {}), attemptId: "att-1", proposalId: stepId, once: true },
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), nonce: `risk-${stepId}`,
    } as never,
  });
  const low = propose("low", "ticket.create", "demo-host", "Create a ticket for the memory alert");
  const elevated = propose("elevated", "git.open-pr", "demo-host", "Open a pull request that edits the CI pipeline", [{ path: ".github/workflows/ci.yml", content: "on: push\n" }]);
  const critical = propose("critical", "git.open-pr", "production", "Open a pull request that edits the CI pipeline of production", [{ path: ".github/workflows/deploy.yml", content: "on: push\n" }]);

  // A low-risk approval says so and asks for nothing extra.
  await page.goto(`${governor.url}/approvals/${low}`);
  await expect(page.getByText(/Asked by .* · Low risk/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-approval-risk-stepup]")).toHaveCount(0);

  // An elevated one asks for the authenticator code and says why it is elevated.
  await page.goto(`${governor.url}/approvals/${elevated}`);
  const elevatedCard = page.locator("[data-approval-risk=elevated]").first();
  await expect(elevatedCard).toBeVisible({ timeout: 30_000 });
  await expect(elevatedCard).toContainText("Elevated risk");
  await expect(elevatedCard.locator("[data-approval-risk-stepup]")).toContainText("authenticator code");
  await elevatedCard.locator("summary").click();
  await expect(elevatedCard.locator("[data-risk-reason=files-outside-target]")).toContainText(".github/workflows/ci.yml");

  // The critical one needs two different people. The first approver decides it, and it stays open for a second.
  await page.goto(`${governor.url}/approvals/${critical}`);
  const criticalCard = page.locator("[data-approval-risk=critical]").first();
  await expect(criticalCard).toBeVisible({ timeout: 30_000 });
  await expect(criticalCard).toContainText("Critical risk");
  await expect(criticalCard.locator("[data-approval-risk-second]")).toContainText("two different people");
  await criticalCard.locator("summary").click();
  await expect(criticalCard.locator("[data-risk-reason=production-environment]")).toBeVisible();
  await expect(criticalCard.locator("[data-risk-reason=no-rollback]")).toBeVisible();
  await expect(page.locator("[data-approval-card]").first()).toHaveScreenshot("risk-critical-card.png", { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/^Decision note/).fill("first of two");
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
  await page.getByRole("button", { name: "Verify identity and approve", exact: true }).click();
  await expect(page.getByText(/Decision recorded/).first()).toBeVisible();
  await expect.poll(() => (brain.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(critical) as { state: string }).state).toBe("pending");
  await expect(page.locator("[data-approval-risk-progress]").first()).toContainText("You already approved this");

  // The same person cannot be the second: the page offers them nothing to decide, and the approval is still pending.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.locator("[data-approval-risk-progress]").first()).toContainText("A second, different person must approve it");
  expect((brain.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(critical) as { state: string }).state).toBe("pending");
  expect(await noSideways(page)).toBe(true);
  expect(errors).toEqual([]);
});
