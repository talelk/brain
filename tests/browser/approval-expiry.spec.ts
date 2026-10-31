import { test, expect } from "./fixtures";
import { totpCode } from "../support/totp";
import { approvalSubjectDigest, type JsonValue } from "../../packages/contracts/src/index";
test.use({ requireTwoFactor: true });
const DIGEST_A = `sha256:${"a".repeat(64)}`;

// T35: if the session expires while an approval review is open, submitting
// must fail closed — an error is surfaced, no decision is recorded, and the
// approval stays pending for a fresh authenticated review.
test("approval decision: session expiry mid-review fails closed (T35)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Expiry organization");
  await page.getByLabel(/^Email/).fill("approver@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  await page.getByLabel(/^Confirm password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Begin setup", exact: true }).click();
  const link = page.getByRole("link", { name: "Keyrus Brain to your authenticator", exact: true });
  await expect(link).toBeVisible();
  const secret = new URL((await link.getAttribute("href"))!).searchParams.get("secret")!;
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await expect(page.getByRole("region", { name: "Authenticator setup" })).toHaveCount(0);

  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  const sessionId = resolved.humanSession!.sessionId;
  brain.createWorkspace(actor, { workspaceId: "ws-exp", slug: "exp" });
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-exp', ?, ?, 'approver', 1, ?, ?)")
    .run(actor.organizationId, actor.actorId, actor.actorId, Date.now());
  brain.ensurePrincipal(actor.organizationId, "requester-1", "human");
  const subject = {
    organizationId: actor.organizationId, workspaceId: "ws-exp", operation: "fixture.publish",
    tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
    target: { targetId: "t-exp", environmentId: "prod", preconditionDigest: DIGEST_A },
    artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: "exp-n1",
  };
  const digest = approvalSubjectDigest(subject as unknown as JsonValue);
  brain.store.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
    VALUES ('apr-exp-1', ?, 'ws-exp', 'requester-1', ?, ?, 'pending', ?, ?)`)
    .run(actor.organizationId, digest, JSON.stringify(subject), Date.now() + 3600000, Date.now());

  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await page.getByRole("region", { name: "Approvals", exact: true }).getByRole("button", { name: "Review: apr-exp-1", exact: true }).click();
  await page.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/^Decision note/).fill("reviewed before expiry");

  // Session expires mid-review (server-side revocation).
  brain.store.control.prepare('DELETE FROM "session" WHERE id=?').run(sessionId);

  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
  await page.getByRole("button", { name: "Verify identity and approve", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: /.+/ }).first();
  await expect(alert).toBeVisible();
  await expect.poll(() => (brain.store.control.prepare("SELECT state FROM approval_requests WHERE id='apr-exp-1'").get() as { state: string }).state).toBe("pending");
  const decisions = brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_decisions WHERE approval_id='apr-exp-1'").get() as { n: number };
  expect(decisions.n).toBe(0);
  expect(errors).toEqual([]);
});
