import { expect, openWorkspace, signIn, starter, test } from "./stack";

// The planner's prompt makes every plan crash; the healer (its prompt is its script) proposes a plain prompt in its place.
const crashing = "You are the planner.\nFIXTURE @plan fail The planner crashed on this goal\n";
const healer = `You are the workspace healer.
FIXTURE @work tool workspace.fix {"files": [{"path": "agents/planner/prompt.md", "content": "You are the planner.\\\\n"}], "message": "Let the planner finish", "why": "The planner prompt made every plan crash."}
FIXTURE @work reply **Cause**: the planner prompt ended every plan in a crash. **Proposal**: a plain prompt.
`;

test("a failed goal gets an analysis and a proposed fix; the admin approves it and the goal runs again on the new files", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({ "agents/planner/prompt.md": crashing, "agents/workspace-healer/prompt.md": healer });
  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.getByRole("textbox", { name: "Your goal" }).fill("Summarise the release notes");
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // The goal failed: the page says why, and a heal task already looks into it. Its fix is shown where the person decides.
  await expect(page.getByRole("heading", { level: 1, name: "Summarise the release notes" })).toBeVisible();
  const why = page.getByLabel("Looking into it");
  await expect(why.getByText("The planner prompt made every plan crash.")).toBeVisible();
  await expect(why.getByText("The change to the workspace's files")).toBeVisible();
  await expect(why.getByText("FIXTURE @plan fail The planner crashed on this goal")).toBeVisible();

  // Today lists it as a fix to decide, not as a bare approval.
  await page.getByRole("link", { name: "Today" }).first().click();
  await expect(page.getByText("A fix is proposed for Summarise the release notes").first()).toBeVisible();

  await page.getByRole("button", { name: "Approve this change and run the task again" }).click();
  await page.getByRole("link", { name: "Open Summarise the release notes" }).click();

  // The same goal ran again on the new files and its plan now waits to be confirmed; the analysis stays beside the failure.
  await expect(page.getByText("Confirm the plan").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Summarise the release notes" })).toBeVisible();
  expect((await api.query("file.read", { workspaceId: workspace.id, path: "agents/planner/prompt.md" })).content).toBe("You are the planner.\n");
});
