import { test, expect } from "./fixtures";
import { createGitHttpBackend } from "../support/git-http-backend";
import { goldenDocs } from "../helpers";

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
    await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
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

test("studio: edit an active Agent as a candidate with versioned instructions", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Agent studio organization");
  await page.getByLabel(/^Email/).fill("agent-studio@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-agent-studio", slug: "agent-studio" });
  const agentDocument = {
    path: "config/browser-agent.yaml",
    text: "apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: browser-agent\n  version: 1.0.0\nspec:\n  instructionsPath: agents/browser-agent.md\n  tools: []\n  engine:\n    anyOf: [pi]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: 0\n",
  };
  const release = brain.stageRelease(actor, [...goldenDocs(), agentDocument], "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4", [], [{ agentId: "browser-agent", path: "agents/browser-agent.md", text: "# Original browser instructions\n" }]);
  brain.activateRelease(actor, release.digest);

  await page.goto(`${governor.url}/w/ws-agent-studio/agents?selected=browser-agent`);
  await page.getByRole("button", { name: "Edit candidate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser agent", exact: true, level: 1 })).toBeVisible();
  const instructions = page.getByLabel("Versioned instructions (Markdown)", { exact: true });
  await expect(instructions).toHaveValue("# Original browser instructions\n");
  await instructions.fill("# Revised browser instructions\n\nRemain read-only.\n");
  await page.getByRole("button", { name: "Save immutable revision", exact: true }).click();
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByText("passed", { exact: true })).toBeVisible();
  expect(brain.activeRelease(actor.organizationId)?.digest).toBe(release.digest);
  const revision = brain.store.control.prepare("SELECT documents_json,assets_json FROM config_draft_revisions ORDER BY created_at_ms DESC LIMIT 1").get() as { documents_json: string; assets_json: string };
  expect(revision.assets_json).toContain("Revised browser instructions");
  expect(errors).toEqual([]);
});
