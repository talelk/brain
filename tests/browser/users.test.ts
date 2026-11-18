import AxeBuilder from "@axe-core/playwright";
import { expect, PASSWORD, sidebar, signIn, starter, test } from "./stack";
import { joinPerson } from "./people";

test("an admin invites someone, they accept the link and sign in, and a deactivation ends their session @phone", async ({ page, browser, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await joinPerson(stack, api, "omar@example.com", "Omar Reyes");
  await signIn(page, stack);

  // Users is in the sidebar for an admin.
  await (await sidebar(page)).getByRole("link", { name: "Users", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Omar Reyes omar@example\.com/u })).toBeVisible();

  // Invite by email with a role on the Starter workspace.
  await page.getByRole("button", { name: "Invite people" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("nora@example.com");
  await dialog.getByRole("button", { name: "Add a workspace" }).click();
  await dialog.getByRole("button", { name: "Create the invitation" }).click();
  await expect(dialog.getByText("Invitation ready")).toBeVisible();
  const link = await dialog.getByLabel("One-use link").inputValue();
  expect(link).toMatch(/\/#invite=[\w-]{40,}$/u);
  await dialog.getByRole("button", { name: "Done" }).click();
  // An invited address is a row that cannot be opened: there is no person yet.
  await expect(page.getByRole("button", { name: /nora@example\.com/u }).first()).toBeDisabled();

  // The person opens the link: no account, no session; they choose a name and a password and land signed in.
  const context = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 900 } });
  const guest = await context.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("heading", { name: "Join Brain" })).toBeVisible();
  const issues = (await new AxeBuilder({ page: guest }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(issues.map((violation) => violation.id)).toEqual([]);
  await guest.getByLabel("Name").fill("Nora Vance");
  await guest.getByLabel("Password").fill(PASSWORD);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await expect(guest.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  expect(guest.url()).not.toContain("invite=");
  // The link works once.
  const other = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 900 } });
  const again = await other.newPage();
  await again.goto(link);
  await again.getByLabel("Name").fill("Someone Else");
  await again.getByLabel("Password").fill(PASSWORD);
  await again.getByRole("button", { name: "Join", exact: true }).click();
  await expect(again.getByText("This link is not valid, or it has expired or been used.")).toBeVisible();
  await other.close();

  // The admin sees her as active, and her access through the invitation.
  await page.reload();
  await page.getByRole("button", { name: /Nora Vance nora@example\.com/u }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Nora Vance" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Access" })).toBeVisible();
  await expect(drawer.getByText("Directly: Member")).toBeVisible();
  await expect(drawer.getByText("Signed in").first()).toBeVisible();
  const drawerIssues = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(drawerIssues.map((violation) => violation.id)).toEqual([]);

  // Deactivate: her open session ends, and she cannot sign in again.
  await drawer.getByRole("button", { name: "Deactivate", exact: true }).click();
  await page.getByRole("dialog").filter({ hasText: "Deactivate Nora Vance?" }).getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(drawer.getByText("Deactivated").first()).toBeVisible();
  await guest.reload();
  await expect(guest.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await guest.getByLabel("Email").fill("nora@example.com");
  await guest.getByLabel("Password").fill(PASSWORD);
  await guest.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(guest.getByText("This account is deactivated")).toBeVisible();
  // Her history stays: she is still a member of Starter, shown as deactivated.
  expect((await api.query("members.list", { workspaceId: workspace.id })).members.find((member) => member.email === "nora@example.com")).toMatchObject({ role: "member", active: false });

  // Reactivating lets her in again.
  await drawer.getByRole("button", { name: "Reactivate" }).click();
  await expect(drawer.getByText("Active").first()).toBeVisible();
  await guest.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(guest.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await context.close();
});
