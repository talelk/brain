import { expect, openWorkspace, signIn, starter, test } from "./stack";

// A step whose checker always sends the work back, so after its rounds a person is asked for the check.
const writer = 'description = "Writes."\nengine = ["pi"]\nnative = "none"\ntools = []\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const play = 'title = "Note"\n[inputs.topic]\ntype = "string"\nrequired = true\n[[step]]\nid = "draft"\nagent = "writer"\ngoal = "Write about {{topic}}.\\nFIXTURE @work reply Draft ready.\\nFIXTURE @check json {\\"pass\\": false, \\"score\\": 0.3, \\"findings\\": \\"Not convincing.\\"}"\n';

test("a goal waiting for a check for a day is closed when the same Play with the same inputs asks for a check; its page says which goal replaced it", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({ "agents/writer/agent.toml": writer, "agents/writer/prompt.md": "You are the writer.\n", "plays/note.toml": play });
  const waiting = async (taskId: string): Promise<void> => {
    await expect.poll(async () => (await api.query("task.get", { workspaceId: workspace.id, taskId })).subtasks.some((sub) => sub.state === "needs_you" && sub.needs?.kind === "check")).toBe(true);
  };
  const start = async (): Promise<string> => (await api.command("task.create", { workspaceId: workspace.id, play: "note", inputs: { topic: "tides" } })).taskId;

  const old = await start();
  await waiting(old);
  // A day goes by without anyone checking it; the same Play is started again with the same inputs.
  stack.governor.gov.db.prepare("UPDATE tasks SET updated_at_ms = updated_at_ms - ? WHERE root_id = ?").run(25 * 3_600_000, old);
  const newer = await start();
  await waiting(newer);
  await expect.poll(async () => (await api.query("task.get", { workspaceId: workspace.id, taskId: old })).state).toBe("stopped");

  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.goto(`${page.url().replace(/\/$/u, "")}/tasks/${old}`);
  const note = page.getByRole("note").filter({ hasText: "Closed automatically" });
  await expect(note).toContainText("a newer identical goal needs a check");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await note.getByRole("link", { name: "Open the newer goal" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${newer}`));
});
