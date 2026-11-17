import { expect, openWorkspace, signIn, test } from "./stack";

// The capitalizer's prompt is its script: it proposes a tool in the platform workspace's base pack, which an admin approves; releasing the pack makes Alpha offer the update.
const files = [
  { path: "packs/base/tools/style.lint/tool.toml", content: 'description = "Lints the repository."\neffect = "read"\nneeds = ["bash"]\n' },
  { path: "packs/base/tools/style.lint/run.sh", content: "#!/bin/sh\ncat >/dev/null\necho '{\"ok\": true}'\n" },
  { path: "packs/base/tools/style.lint/test.sh", content: '#!/bin/sh\necho "style.lint: ok"\n' },
];
// The fixture engine unescapes a line once, so the JSON's own escapes are written twice.
const call = JSON.stringify({ files, message: "Add the style.lint tool", why: "dev ran lint four times in alpha." }).replaceAll("\\", "\\\\");
const capitalizer = `You are the capitalizer.
FIXTURE @work tool workspace.fix ${call}
FIXTURE @work reply **Proposed**: style.lint for alpha.
`;
const model = { name: "main", provider: "openai-compatible" as const, url: "http://127.0.0.1:9/v1", model: "fixture-model" };

test("the platform workspace is badged; a tool it proposes is approved, released with its pack, and a workspace updates to it", async ({ page, stack }) => {
  const api = await stack.setUp();
  const alpha = await api.command("workspace.create", { name: "Alpha", slug: "alpha", description: "", packs: ["base"], platform: false, model });
  const admin = await api.command("workspace.create", { name: "Brain admin", slug: "brain-admin", description: "", packs: ["base", "platform"], platform: true, model });
  await api.command("file.write", { workspaceId: admin.workspaceId, files: [{ path: "agents/capitalizer/prompt.md", content: capitalizer }] });
  await signIn(page, stack);

  // The sidebar and the Overview mark it.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /^Brain admin/u }).getByText("Platform")).toBeVisible();
  await expect(page.getByRole("row", { name: /Brain admin/u }).getByText("Platform")).toBeVisible();
  await openWorkspace(page, "Brain admin");

  // Its Capitalize Play runs by hand and proposes a change to its own base pack, shown as a diff; approving it commits it there.
  await api.command("task.create", { workspaceId: admin.workspaceId, play: "capitalize" });
  await page.getByRole("link", { name: "Today" }).first().click();
  await expect(page.getByText("packs/base/tools/style.lint/run.sh").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve this change to the packs" }).click();
  await expect.poll(async () => (await api.query("file.read", { workspaceId: admin.workspaceId, path: "packs/base/tools/style.lint/test.sh" }).catch(() => ({ content: "" }))).content).toContain("style.lint: ok");
  expect((await api.query("workspace.get", { workspaceId: alpha.workspaceId })).updates).toEqual([]);

  // Releasing the pack from its Packs tab offers it to the workspaces; Alpha's admin updates and gets the tool.
  await page.goto(`${stack.url}/w/brain-admin/workspace`);
  await page.getByRole("tab", { name: "Packs" }).click();
  await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "base", exact: true }) }).getByRole("button", { name: "Release" }).click();
  await expect(page.getByText("base released as v1")).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Alpha/u }).getByText("Update available")).toBeVisible();
  await page.goto(`${stack.url}/w/alpha/workspace`);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Update to v1" }).click();
  await expect.poll(async () => Object.keys((await api.query("workspace.get", { workspaceId: alpha.workspaceId })).snapshot.tools)).toContain("style.lint");
  expect((await api.query("workspace.get", { workspaceId: alpha.workspaceId })).updates).toEqual([]);
});
