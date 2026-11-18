import AxeBuilder from "@axe-core/playwright";
import { expect, openWorkspace, onPhone, PASSWORD, signIn, starter, test } from "./stack";

test("an admin shares a workspace by email and makes another public; the invited person sees them grouped, and a public one only to read @phone", async ({ page, browser, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await api.command("workspace.create", { name: "Open Lab", packs: ["base"] });
  const lab = (await api.query("me", {})).workspaces.find((entry) => entry.name === "Open Lab")?.id ?? "";
  await api.command("workspace.create", { name: "Secret Lab", packs: ["base"] });
  await signIn(page, stack);

  // Share: a person with no account is asked for a name and a first password, then added with a role.
  await openWorkspace(page, "Starter");
  await expect(page.getByText("Private", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("lina@example.com");
  await dialog.getByRole("combobox", { name: "Role", exact: true }).click();
  await page.getByRole("option", { name: /Viewer/u }).click();
  await dialog.getByRole("button", { name: "Add to the workspace" }).click();
  await expect(dialog.getByText("This person has no account yet")).toBeVisible();
  await dialog.getByLabel("Name").fill("Lina Ben Salah");
  await dialog.getByLabel("First password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Add to the workspace" }).click();
  await expect(dialog.getByText("Lina Ben Salah")).toBeVisible();
  expect((await api.query("members.list", { workspaceId: workspace.id })).members.find((member) => member.email === "lina@example.com")?.role).toBe("viewer");
  // Her role can be changed here, and the workspace can be made public from the same dialog.
  await dialog.getByRole("combobox", { name: "Role of Lina Ben Salah" }).click();
  await page.getByRole("option", { name: /Member/u }).click();
  await expect.poll(async () => (await api.query("members.list", { workspaceId: workspace.id })).members.find((member) => member.email === "lina@example.com")?.role).toBe("member");
  await dialog.getByRole("radio", { name: /^Public/u }).check();
  await expect.poll(async () => (await api.query("file.read", { workspaceId: workspace.id, path: "brain.toml" })).content).toContain('visibility = "public"');
  await dialog.getByRole("radio", { name: /^Private/u }).check();
  await expect.poll(async () => (await api.query("file.read", { workspaceId: workspace.id, path: "brain.toml" })).content).not.toContain("visibility");
  await page.keyboard.press("Escape");
  await api.command("file.write", { workspaceId: lab, files: [{ path: "brain.toml", content: 'name = "Open Lab"\nvisibility = "public"\npacks = ["base"]\n' }] });

  // The invited person: Starter is shared with her, Open Lab is public, Secret Lab is not there at all.
  const context = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 900 } });
  const guest = await context.newPage();
  await guest.goto(stack.url);
  await guest.getByLabel("Email").fill("lina@example.com");
  await guest.getByLabel("Password").fill(PASSWORD);
  await guest.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(guest.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const nav = guest.getByRole("navigation", { name: "Main" });
  if (onPhone(guest)) await guest.getByRole("button", { name: "Open application navigation" }).click();
  await expect(nav.getByText("Shared with me")).toBeVisible();
  await expect(nav.getByText("Public workspaces")).toBeVisible();
  await expect(nav.getByText("My workspaces")).toHaveCount(0);
  await expect(nav.getByRole("link", { name: /^Starter/u })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Open Lab/u })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Secret Lab/u })).toHaveCount(0);
  await nav.getByRole("link", { name: /^Open Lab/u }).click();
  await expect(guest.getByRole("heading", { level: 1, name: "Open Lab" })).toBeVisible();
  await expect(guest.getByText("Public", { exact: true }).first()).toBeVisible();
  await expect(guest.getByText("You see this workspace because it is public")).toBeVisible();
  await expect(guest.getByRole("button", { name: "Share" })).toHaveCount(0);
  await guest.goto(`${guest.url().replace(/\/$/u, "")}/workspace/files`);
  await expect(guest.getByRole("button", { name: "Upload files" })).toHaveCount(0);
  const violations = (await new AxeBuilder({ page: guest }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(violations.map((violation) => violation.id)).toEqual([]);
  // Making it private again takes it away.
  await api.command("file.write", { workspaceId: lab, files: [{ path: "brain.toml", content: 'name = "Open Lab"\npacks = ["base"]\n' }] });
  await guest.goto(stack.url);
  await expect(guest.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const again = guest.getByRole("navigation", { name: "Main" });
  if (onPhone(guest)) await guest.getByRole("button", { name: "Open application navigation" }).click();
  await expect(again.getByRole("link", { name: /^Open Lab/u })).toHaveCount(0);
  await context.close();
});
