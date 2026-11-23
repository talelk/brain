import { readFileSync } from "node:fs";
import { putArtifact, linkArtifact } from "../../apps/governor/src/trust/artifacts";
import { expect, openWorkspace, signIn, starter, test } from "./stack";

const writer = 'description = "Writes."\nengine = ["pi"]\nnative = "none"\ntools = []\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const play = 'title = "Note"\n[[step]]\nid = "draft"\nagent = "writer"\ngoal = "Write.\\nFIXTURE @work reply Draft ready.\\nFIXTURE @check json {\\"pass\\": false, \\"score\\": 0.3, \\"findings\\": \\"No.\\"}"\n';
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("what an agent saved in /out is a folder tree shown by type: the manifest's entry first, a page sandboxed, a table, a JSON tree, and all as one zip", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({ "agents/writer/agent.toml": writer, "agents/writer/prompt.md": "You are the writer.\n", "plays/note.toml": play });
  const goal = (await api.command("task.create", { workspaceId: workspace.id, play: "note", inputs: {} })).taskId;
  // The step that ran: its page shows the Evidence, with the files its attempt kept.
  await expect.poll(async () => (await api.query("task.get", { workspaceId: workspace.id, taskId: goal })).subtasks.some((sub) => sub.state === "needs_you")).toBe(true);
  const taskId = (await api.query("task.get", { workspaceId: workspace.id, taskId: goal })).subtasks[0]?.id ?? "";
  const files: Record<string, Uint8Array | string> = {
    "manifest.json": JSON.stringify({ title: "Snake", kind: "game", entry: "site/snake.html" }),
    "site/snake.html": "<!doctype html><title>snake</title><p id=o>starting</p><script>document.getElementById('o').textContent = 'snake runs on origin ' + window.origin;</script>",
    "notes/README.md": "# Read me\n\nSome **notes**.\n",
    "data/table.csv": "name,score\nada,3\n\"grace, h\",5\n",
    "data/config.json": JSON.stringify({ level: { speed: 3, walls: [1, 2] } }),
    "logo.png": PNG,
    "deck.pptx": "not really a deck",
  };
  const gov = stack.governor.gov;
  const digests: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const digest = putArtifact(gov, typeof content === "string" ? new TextEncoder().encode(content) : content);
    digests[name] = digest;
    linkArtifact(gov.db, { digest, workspaceId: workspace.id, taskId, name, kind: "output", mediaType: "application/octet-stream" }, Date.now());
  }


  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.goto(`${page.url().replace(/\/$/u, "")}/tasks/${goal}?link=${taskId}`);

  // The deliverable the manifest names comes first, running in a frame that has no origin of Brain's.
  const deliverable = page.getByRole("region", { name: "Deliverable" });
  await expect(deliverable).toContainText("Snake");
  await expect(deliverable).toContainText("game");
  await expect(deliverable.frameLocator("iframe").getByText("snake runs on origin null")).toBeVisible();
  expect(await deliverable.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");

  // The rest is a tree by folder, each file previewed by its type.
  for (const folder of ["site", "notes", "data"]) await expect(page.getByText(folder, { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.getByRole("heading", { name: "Read me" })).toBeVisible();
  await page.getByRole("button", { name: "table.csv" }).click();
  await expect(page.getByRole("cell", { name: "grace, h" })).toBeVisible();
  await page.getByRole("button", { name: "config.json" }).click();
  await expect(page.getByText("level").first()).toBeVisible();
  await expect(page.getByText("walls").first()).toBeVisible();
  await page.getByRole("button", { name: "logo.png" }).click();
  await expect(page.getByRole("img", { name: "logo.png" })).toBeVisible();
  // A type with no preview is only a download.
  await expect(page.getByRole("button", { name: "deck.pptx" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Download deck.pptx" })).toBeVisible();

  const [zip] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download all as zip" }).click()]);
  expect(zip.suggestedFilename()).toBe("results.zip");
  const bytes = readFileSync(await zip.path());
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  for (const name of Object.keys(files)) expect(bytes.includes(Buffer.from(name))).toBe(true);

  // Only a page, image, PDF or video is ever served to be shown, and a page only sandboxed; the rest is a download.
  const get = async (name: string, view: boolean) => fetch(`${stack.url}/v1/artifacts/${digests[name]}${view ? "?view=1" : ""}`, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } });
  const shown = await get("site/snake.html", true);
  expect(shown.headers.get("content-type")).toBe("text/html");
  expect(shown.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  expect((await get("site/snake.html", false)).headers.get("content-disposition")).toMatch(/^attachment/u);
  expect((await get("data/table.csv", true)).headers.get("content-disposition")).toMatch(/^attachment/u);

  // The same page right to left and in French.
  await page.goto(`${page.url().split("?")[0]}?link=${taskId}&lang=ar`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("region", { name: "المُخرَج" })).toBeVisible();
  await page.getByRole("button", { name: "table.csv" }).click();
  await expect(page.getByRole("button", { name: "تنزيل الكل بصيغة zip" })).toBeVisible();
  await page.getByRole("region", { name: "المُخرَج" }).locator("xpath=..").screenshot({ path: process.env["OUT_SHOT"] ?? "test-results/outputs-ar.png" });
  await page.goto(`${page.url().split("?")[0]}?link=${taskId}&lang=fr`);
  await expect(page.getByRole("button", { name: "Tout télécharger en zip" })).toBeVisible();
});
