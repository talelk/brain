import { expect, signIn, starter, test } from "./stack";

const planner = `You are the planner.
FIXTURE @plan json {"summary": "Research, then write.", "tasks": [{"title": "Research", "goal": "Find the facts.\\\\nFIXTURE @work reply The facts: the moon pulls the sea.", "agent": "worker", "after": []}, {"title": "Write", "goal": "Write it up.\\\\nFIXTURE @work reply Written from the facts.", "agent": "worker", "after": ["Research"]}]}
`;
const editor = 'description = "Polishes what the others wrote."\nengine = ["pi"]\nnative = "none"\ntools = []\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';

test("a typed goal gets a plan that the person changes, confirms and sees finish", async ({ page, stack }) => {
  const workspace = await starter(await stack.setUp());
  await workspace.connectModel();
  await workspace.write({
    "agents/planner/prompt.md": planner, "agents/editor/agent.toml": editor,
    "agents/editor/prompt.md": "You are the editor.\n",
  });
  await signIn(page, stack);

  await page.getByRole("textbox", { name: "Your goal" }).fill("Explain how tides work\nfor a school magazine.");
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // The planner proposes sub-tasks; nothing runs before the person confirms.
  await expect(page.getByRole("heading", { level: 1, name: "Explain how tides work" })).toBeVisible();
  await expect(page.getByText("Confirm the plan").first()).toBeVisible();
  await expect(page.getByText("Research", { exact: true }).first()).toBeVisible();

  // Change one sub-task: hand "Write" to the editor and say what it is asked.
  const write = page.getByRole("listitem").filter({ hasText: "After: Research" });
  await write.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "editor" }).click();
  await expect(write.getByText("editor")).toBeVisible();
  await write.getByText("Change the wording").click();
  await write.getByLabel("Title").fill("Polish");
  await write.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Polish", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Confirm plan" }).click();
  await expect(page.getByText("Done, checked by checker").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Result" }).first()).toBeVisible();
  await expect(page.getByText("Written from the facts.").first()).toBeVisible();
  // It ran as the person changed it: under the new title, by the editor.
  await expect(page.getByRole("button", { name: /^Polish/u })).toBeVisible();
  await page.getByRole("button", { name: /^Polish/u }).click();
  await expect(page.getByText("Agent: editor")).toBeVisible();
});
