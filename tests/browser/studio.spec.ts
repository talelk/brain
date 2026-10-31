import { test, expect } from "./fixtures";
import { createGitHttpBackend } from "../support/git-http-backend";

test("studio: edit spec.jobs, validate, publish exact commit and activate separately (T56, E109)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const remote = await createGitHttpBackend();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(governor.url);
    await page.getByLabel(/^Setup credential/).fill(governor.credential);
    await page.getByLabel(/^Organization name/).fill("Studio organization");
    await page.getByLabel(/^Email/).fill("studio@example.test");
    await page.getByLabel(/^Password/).fill("browser-password-1234");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
    const cookies = await page.context().cookies();
    const brain = governor.app.brain;
    const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }));
    const actor = resolved.actor;
    brain.createWorkspace(actor, { workspaceId: "ws-studio", slug: "studio" });
    const run = (commandType: string, key: string, payload: Record<string, unknown>) => brain.executeCommand(actor, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
      workspaceId: "ws-studio", idempotencyKey: key, payload,
    } as never, key).receipt;
    const connectionId = run("integration.connect", "browser-studio-connect", { name: "Studio remote", repositoryUrl: remote.remote }).resourceId!;
    expect(await brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const bindingId = run("integration.bind", "browser-studio-bind", { connectionId, workspaceId: "ws-studio", kind: "configuration", repositoryKey: remote.remote, access: "write" }).resourceId!;
    expect(await brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const activeBefore = brain.activeRelease(actor.organizationId);

    await page.goto(`${governor.url}/studio/Workflow`);
    await page.getByLabel("Definition title", { exact: true }).fill("Browser Workflow");
    await page.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Browser Workflow", exact: true, level: 1 })).toBeVisible();
    await page.getByLabel("Job id", { exact: true }).fill("audit");
    await page.getByRole("button", { name: "Save immutable revision", exact: true }).click();
    await expect(page.getByText("unsaved", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(page.getByText("passed", { exact: true })).toBeVisible();
    await page.getByLabel("Configuration write binding ID", { exact: true }).fill(bindingId);
    await page.getByRole("button", { name: "Publish and compile commit", exact: true }).click();
    expect(await brain.drafts.publishPending()).toEqual({ published: 1, failed: 0 });
    await expect(page.getByText("compiled", { exact: true })).toBeVisible();
    const publication = brain.store.control.prepare("SELECT commit_oid,release_digest FROM publication_requests").get() as { commit_oid: string; release_digest: string };
    expect(publication.commit_oid).toMatch(/^[0-9a-f]{40}$/);
    expect(brain.activeRelease(actor.organizationId)?.digest).toBe(activeBefore?.digest);

    await page.getByRole("button", { name: "Activate this release", exact: true }).click();
    await expect.poll(() => brain.activeRelease(actor.organizationId)?.digest).toBe(publication.release_digest);
    const source = brain.store.control.prepare("SELECT source_documents_json FROM config_releases WHERE digest=?").get(publication.release_digest) as { source_documents_json: string };
    expect(source.source_documents_json).toContain("audit");
    expect(errors).toEqual([]);
  } finally {
    await remote.cleanup();
  }
});
