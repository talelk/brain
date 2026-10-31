import { test, expect } from "./fixtures";
import { createGitRemote } from "../support/git-fixture";

test("integrations: connect a TypeScript Git remote, bind repository classes and review ref proposals (T55, E108)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const fixture = await createGitRemote();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(governor.url);
    await page.getByLabel(/^Setup credential/).fill(governor.credential);
    await page.getByLabel(/^Organization name/).fill("Git organization");
    await page.getByLabel(/^Email/).fill("git@example.test");
    await page.getByLabel(/^Password/).fill("browser-password-1234");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
    const cookies = await page.context().cookies();
    const brain = governor.app.brain;
    const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }));
    brain.createWorkspace(resolved.actor, { workspaceId: "ws-git", slug: "git" });
    await page.goto(`${governor.url}/administration/integrations`);
    await expect(page.getByRole("heading", { name: "Integrations", exact: true, level: 1 })).toBeVisible();

    await page.getByLabel("Connection name", { exact: true }).fill("Protocol remote");
    await page.getByLabel("Remote repository URL", { exact: true }).fill(fixture.remote);
    await page.getByLabel("HTTP username (optional)", { exact: true }).fill("git-user");
    await page.getByLabel("HTTP token (optional)", { exact: true }).fill("browser-secret-token");
    await page.getByRole("button", { name: "Connect remote", exact: true }).click();
    await expect.poll(() => (brain.store.control.prepare("SELECT COUNT(*) AS n FROM git_connections").get() as { n: number }).n).toBe(1);
    const connectionId = (brain.store.control.prepare("SELECT id FROM git_connections").get() as { id: string }).id;
    expect(await brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/verified/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Bind repository", exact: true }).first().click();
    await page.getByLabel("Repository", { exact: true }).click();
    await page.getByRole("option", { name: /repo · main/ }).click();
    await page.getByRole("button", { name: "Bind repository", exact: true }).last().click();
    await expect.poll(() => (brain.store.control.prepare("SELECT COUNT(*) AS n FROM repository_bindings").get() as { n: number }).n).toBe(1);
    expect(await brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("configuration · write · ws-git", { exact: true })).toBeVisible();

    await fixture.update("browser protocol change\n");
    await page.getByRole("button", { name: "Verify remote", exact: true }).click();
    expect(await brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/refs\/heads\/main@/).first()).toBeVisible();
    expect((brain.store.control.prepare("SELECT COUNT(*) AS n FROM git_proposals").get() as { n: number }).n).toBe(1);
    expect((brain.store.control.prepare("SELECT state FROM git_proposals").get() as { state: string }).state).toBe("proposed");
    expect(await page.locator("body").textContent()).not.toContain("browser-secret-token");
    expect((brain.store.control.prepare("SELECT encrypted_credentials FROM git_connections WHERE id=?").get(connectionId) as { encrypted_credentials: string }).encrypted_credentials).not.toContain("browser-secret-token");
    expect(errors).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});
