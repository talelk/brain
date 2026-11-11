import { test, expect } from "./fixtures";

test("admin invites a person, gets a link to share, and sees clear failures and names", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const brain = governor.app.brain;
  const boot = await brain.bootstrap({ organizationId: "org-invite", name: "Invite org", email: "owner@example.test", password: "owner-password-1234" }, governor.credential);
  const { actor } = await brain.resolveActor(new Headers({ authorization: `Bearer ${boot.sessionToken}` }));
  brain.createWorkspace(actor, { workspaceId: "ops", slug: "ops" });
  await page.goto(governor.url);
  await page.getByLabel(/^Email/).fill("owner@example.test");
  await page.getByLabel(/^Password/).fill("owner-password-1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Missions", level: 1 })).toBeVisible();

  await page.goto(`${governor.url}/settings?tab=people`);
  await page.getByRole("button", { name: "Invite person" }).click();
  await page.getByLabel(/^Email/).fill("owner@example.test");
  await page.getByLabel(/^Reason/).fill("self");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("is already a member of this organization")).toBeVisible();

  await page.getByLabel(/^Email/).fill("new.person@example.test");
  await page.getByLabel(/^Reason/).fill("joins the team");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("a queued email is not proof it arrived")).toBeVisible();
  await expect(page.getByLabel("Invitation link")).toHaveValue(/\/accept-invitation\/.+/);
  await page.getByRole("button", { name: "Done" }).click();

  await page.goto(`${governor.url}/settings?tab=invitations`);
  await expect(page.getByText("new.person@example.test").first()).toBeVisible();
  await expect(page.getByText(/^Invited by Invite org$/)).toBeVisible();
  await page.getByRole("button", { name: "Get link or cancel" }).click();
  await expect(page.getByLabel("Invitation link")).toHaveValue(/\/accept-invitation\/.+/);

  await page.goto(`${governor.url}/settings?tab=members`);
  await expect(page.getByText("owner@example.test").first()).toBeVisible();
});
