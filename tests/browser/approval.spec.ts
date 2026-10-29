import { test, expect } from "./fixtures";
import { totpCode } from "../support/totp";
import { approvalSubjectDigest, type JsonValue } from "../../packages/contracts/src/index";
test.use({ requireTwoFactor: true });
const DIGEST_A = `sha256:${"a".repeat(64)}`;

test("approval decision: exact review, TOTP step-up, recorded decision (T35)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Approval organization");
  await page.getByLabel(/^Email/).fill("approver@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
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
  brain.createWorkspace(actor, { workspaceId: "ws-decide", slug: "decide" });
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-decide', ?, ?, 'approver', 1, ?, ?)")
    .run(actor.organizationId, actor.actorId, actor.actorId, Date.now());
  brain.ensurePrincipal(actor.organizationId, "requester-1", "human");
  const subject = {
    organizationId: actor.organizationId, workspaceId: "ws-decide", operation: "fixture.publish",
    tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
    target: { targetId: "t-decide", environmentId: "prod", preconditionDigest: DIGEST_A },
    artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: "decide-n1",
  };
  const digest = approvalSubjectDigest(subject as unknown as JsonValue);
  brain.store.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
    VALUES ('apr-decide-1', ?, 'ws-decide', 'requester-1', ?, ?, 'pending', ?, ?)`)
    .run(actor.organizationId, digest, JSON.stringify(subject), Date.now() + 3600000, Date.now());

  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await page.getByRole("row").filter({ hasText: "apr-decide-1" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: /^Review(?: \(\d+\))?$/, exact: true }).click();
  await page.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/^Decision note/).fill("reviewed exact subject");
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
  await page.getByRole("button", { name: "Verify identity and approve", exact: true }).click();
  await expect(page.getByText(/Decision recorded/)).toBeVisible();
  await expect.poll(() => (brain.store.control.prepare("SELECT state FROM approval_requests WHERE id='apr-decide-1'").get() as { state: string }).state).toBe("approved");
  const decision = brain.store.control.prepare("SELECT decision FROM approval_decisions WHERE approval_id='apr-decide-1'").get() as { decision: string } | undefined;
  expect(decision?.decision).toBe("approve");
  expect(errors).toEqual([]);
});
