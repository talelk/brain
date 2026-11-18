import { expect, openWorkspace, onPhone, signIn, starter, test } from "./stack";

const editor = 'description = "Polishes what the others wrote."\nengine = ["pi"]\nnative = "none"\ntools = []\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const step = (id: string, agent: string, after: string[], reply: string, review = false): string =>
  `[[step]]\nid = "${id}"\nagent = "${agent}"\nafter = ${JSON.stringify(after)}\n${review ? 'review_by = "checker"\n' : ""}goal = """Do ${id}.\nFIXTURE @work reply ${reply}"""\n`;
const relay = `title = "Relay"\ndescription = "Research, draft, publish."\n${step("research", "worker", [], "Facts.")}${step("draft", "editor", ["research"], "A draft.", true)}${step("publish", "worker", ["draft"], "Published.")}`;

test("a goal is drawn as a graph by what waits for what, and Team shows who handed work to whom", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({ "agents/editor/agent.toml": editor, "agents/editor/prompt.md": "You are the editor.\n", "plays/relay.toml": relay });
  const { taskId } = await api.command("task.create", { workspaceId: workspace.id, play: "relay", inputs: {} });
  await expect.poll(async () => (await api.query("task.get", { workspaceId: workspace.id, taskId })).state, { timeout: 45_000 }).toBe("done");
  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.getByRole("link", { name: /Relay/u }).first().click();

  // Task: one node per step, a column further right for each step it waits behind, and a click selects it.
  const back = page.getByRole("button", { name: "The record of this goal", exact: true });
  if (onPhone(page)) await back.click();
  const graph = page.getByRole("group", { name: "The record of this goal" });
  const nodes = graph.getByRole("button");
  await expect(nodes).toHaveCount(4);
  const x = async (name: RegExp): Promise<number> => (await graph.getByRole("button", { name }).boundingBox())?.x ?? -1;
  expect(await x(/^Research/u)).toBeLessThan(await x(/^Draft/u));
  expect(await x(/^Draft/u)).toBeLessThan(await x(/^Publish/u));
  await expect(graph.getByText("Checked by checker: passed (round 1)").first()).toBeVisible();
  await graph.getByRole("button", { name: /^Draft/u }).click();
  await expect(page).toHaveURL(/link=t_/u);
  await expect(graph.getByRole("button", { name: /^Draft/u })).toHaveAttribute("aria-current", "true");

  // Team: the agents, and the arrows the Play and the finished work make; an agent opens in the agents tab.
  await page.goto(page.url().replace(/\/tasks\/.*/u, "/workspace/team"));
  await expect(page.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
  const handoffs = page.getByRole("list", { name: "Handoffs between agents" });
  await expect(handoffs.getByRole("listitem").filter({ hasText: "worker hands over to editor: 1 handoff" })).toHaveCount(1);
  await expect(handoffs.getByRole("listitem").filter({ hasText: "checker checks editor: 1 check" })).toHaveCount(1);
  await expect(page.getByText("Agents never message each other")).toBeVisible();
  await page.getByRole("list", { name: "Agents" }).getByRole("link", { name: /^editor/u }).click();
  await expect(page).toHaveURL(/\/workspace\/agents\/editor$/u);
  await expect(page.getByRole("heading", { level: 2, name: "editor" })).toBeVisible();
});
