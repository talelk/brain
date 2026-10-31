import { test, expect } from "./fixtures";

async function bootstrapOwner(page: import("@playwright/test").Page, governor: { url: string; credential: string }) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Identity administration");
  await page.getByLabel(/^Email/).fill("owner@example.test");
  await page.getByLabel(/^Password/).fill("owner-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  await page.getByLabel("Display name").fill("Identity workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

test("native people, invitation, verification, acceptance, and workspace access", async ({ page, governor, browser }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await bootstrapOwner(page, governor);
  await page.goto(`${governor.url}/settings?tab=people`);
  await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
  await expect(page.getByText("owner@example.test", { exact: true }).locator("visible=true").first()).toBeVisible();
  await page.getByRole("button", { name: "Invite person", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("invited@example.test");
  await page.getByLabel("Reason", { exact: true }).fill("Browser invitation");
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();
  const invitation = governor.app.brain.store.control.prepare("SELECT id,url FROM auth_email_outbox WHERE kind='organization-invitation' AND email=?").get("invited@example.test") as { id: string; url: string };
  expect(invitation.url).toContain("/accept-invitation/");

  await page.goto(`${governor.url}/settings?tab=invitations`);
  await expect(page.getByRole("heading", { name: "Invitations", exact: true })).toBeVisible();
  await expect(page.getByText("invited@example.test", { exact: true }).locator("visible=true").first()).toBeVisible();
  await expect(page.getByText("pending", { exact: true }).locator("visible=true").first()).toBeVisible();

  const invitedContext = await browser.newContext();
  const invited = await invitedContext.newPage();
  await invited.goto(invitation.url);
  await invited.getByRole("button", { name: "New to Brain? Create the invited account", exact: true }).click({ timeout: 5000 });
  await invited.getByRole("textbox", { name: /^Your name/ }).fill("Invited Person");
  await invited.getByRole("textbox", { name: /^Email/ }).fill("invited@example.test");
  await invited.getByRole("textbox", { name: /^Password/ }).fill("invited-password-1234");
  await invited.getByRole("button", { name: "Create account and send verification", exact: true }).click();
  await expect(invited.getByRole("heading", { name: "Verify your email", exact: true })).toBeVisible();
  const verification = governor.app.brain.store.control.prepare("SELECT url FROM auth_email_outbox WHERE kind='verify-email' AND email=? ORDER BY created_at_ms DESC LIMIT 1").get("invited@example.test") as { url: string };
  expect(verification.url).toContain("callbackURL=%2Faccept-invitation%2F");
  await invited.goto(verification.url);
  await expect(invited.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible();
  const principalId = (governor.app.brain.store.control.prepare("SELECT id FROM user WHERE email=?").get("invited@example.test") as { id: string }).id;
  expect(governor.app.brain.store.control.prepare("SELECT COUNT(*) AS count FROM principals WHERE id=?").get(principalId)).toEqual({ count: 0 });
  await invited.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect(invited.getByRole("heading", { name: "Invitation accepted", exact: true })).toBeVisible();
  await invitedContext.close();

  await page.goto(`${governor.url}/settings?tab=people`);
  await page.getByLabel("Member to manage").click();
  await page.getByRole("option", { name: /Invited Person/ }).click();
  await expect(page.getByRole("heading", { name: "Invited Person", exact: true })).toBeVisible();
  await expect(page.getByText("Current-organization sessions", { exact: true }).first()).toBeVisible();

  await page.goto(`${governor.url}/settings?tab=members`);
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await page.getByLabel("Organization member").click();
  await page.getByRole("option", { name: /Invited Person/ }).click();
  await page.getByLabel("Reason", { exact: true }).fill("Grant browser workspace");
  await page.getByRole("button", { name: "Grant", exact: true }).click();
  await expect.poll(() => governor.app.brain.store.control.prepare("SELECT COUNT(*) AS count FROM workspace_memberships WHERE principal_id=? AND revoked_at_ms IS NULL").get(principalId)).toEqual({ count: 1 });
  expect(errors).toEqual([]);
  await info.attach("identity-administration-screen", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("passkey registration and passwordless sign-in with an emulated authenticator", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await bootstrapOwner(page, governor);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto(`${governor.url}/settings?tab=security`);
  await page.getByLabel("New passkey name").fill("Owner laptop");
  await page.getByRole("button", { name: "Register a passkey", exact: true }).click();
  await expect(page.getByText("Owner laptop", { exact: true })).toBeVisible();
  await expect(page.getByText("Passkey registered.", { exact: true })).toBeVisible();

  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByTestId("account-menu").getByRole("button").click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Keyrus Brain", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeVisible();
  await expect(page.getByText("Owner laptop", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});
