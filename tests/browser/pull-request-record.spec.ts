import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";
import { PULL_REQUEST_TOKEN, PULL_REQUEST_URL, seedPullRequest } from "../support/pullRequestDemo";

/**
 * A pull request an approved change opened is kept on its task and shown in the approval's page (#121), walked like a first-time user on
 * the seeded Operations workspace: open the mission, open the task, find the request and where it stands, read its state again by hand
 * (a provider that cannot be reached says so and changes nothing; a merged one is shown as merged), then follow the link to the approval it
 * came from. Nothing is shown on a task that no request was opened for.
 */
test("a person finds the pull request on its task, refreshes its state and follows it to the approval", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const brain = governor.app.brain;
  const taskId = demo.seed.workItems["review"];
  const other = demo.seed.workItems["in-progress"];
  const seeded = await seedPullRequest(brain, demo.actor, demo.workspaceId, { runId: "demo-run-review", key: "pr-walk" });
  try {
    // The mission's work: open the task the request was opened for.
    await page.goto(`${governor.url}/missions/${demo.seed.missionIds.active}/plan?w=operations`);
    await page.getByRole("radio", { name: "Board" }).click();
    const board = page.getByTestId("work-board");
    await board.locator(`[data-work-item="${taskId}"]`).getByRole("button", { name: /^Manage /u }).click();
    const section = page.getByTestId("pull-requests");
    await expect(section.getByRole("heading", { name: "Pull requests", level: 4 })).toBeVisible({ timeout: 20_000 });
    const record = section.getByTestId("pull-request");

    // What it is: the title as a link to the provider's page, where it stands, and where it came from.
    const link = record.getByTestId("pull-request-link");
    await expect(link).toHaveText(/Raise the demo-app memory limit/u);
    await expect(link).toHaveAttribute("href", PULL_REQUEST_URL);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/u);
    await expect(record.getByTestId("pull-request-state")).toHaveText("Open");
    await expect(record).toContainText("GitHub Enterprise request #7: branch brain/raise-demo-app-memory into main");
    await expect(record).toContainText(/Opened .* · State read /u);
    await expect(record.getByTestId("pull-request-history")).toBeHidden();
    await record.getByText("History of its state (1)").click();
    await expect(record.getByTestId("pull-request-history").locator("li")).toHaveText([/^Open, .*, when it was opened$/u]);

    // Reading the state when the provider cannot be reached says so in words and changes nothing.
    seeded.provider.fail = true;
    await record.getByRole("button", { name: "Refresh state", exact: true }).click();
    await expect(record.getByTestId("pull-request-error")).toContainText("The state could not be read:");
    await expect(record.getByTestId("pull-request-state")).toHaveText("Open");
    await expect(record.getByTestId("pull-request-history").locator("li")).toHaveCount(1);

    // The request was merged meanwhile: a refresh shows it, and the earlier state stays in the history.
    seeded.provider.fail = false; seeded.provider.state = "closed"; seeded.provider.merged = true;
    await record.getByRole("button", { name: "Refresh state", exact: true }).click();
    await expect(record.getByTestId("pull-request-state")).toHaveText("Merged");
    await expect(record.getByTestId("pull-request-error")).toHaveCount(0);
    await expect(record.getByTestId("pull-request-history").locator("li")).toHaveText([/^Merged, .*, checked by /u, /^Open, .*, when it was opened$/u]);

    // A task no request was opened for shows nothing of the kind.
    await page.getByRole("button", { name: "Back to mission work", exact: true }).click();
    await board.locator(`[data-work-item="${other}"]`).getByRole("button", { name: /^Manage /u }).click();
    await expect(page.getByRole("heading", { name: "Comments", level: 4 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("pull-requests")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to mission work", exact: true }).click();

    // Follow the request to the approval it came from.
    await board.locator(`[data-work-item="${taskId}"]`).getByRole("button", { name: /^Manage /u }).click();
    await page.getByTestId("pull-requests").getByRole("link", { name: "See the approval it came from" }).click();
    await expect(page.getByRole("heading", { name: "Approval review" }).first()).toBeVisible({ timeout: 20_000 });
    const onApproval = page.getByTestId("pull-requests");
    await expect(onApproval.getByTestId("pull-request-state")).toHaveText("Merged");
    await expect(onApproval.getByTestId("pull-request-link")).toHaveAttribute("href", PULL_REQUEST_URL);
    // The approval's history says it was opened and that it merged.
    const history = page.getByText("Decision history").locator("xpath=ancestor::section[1]");
    await expect(history).toContainText(`A pull request was opened: ${PULL_REQUEST_URL}`);
    await expect(history).toContainText(`The pull request is now merged: ${PULL_REQUEST_URL}`);
    // ...and takes the person back to the task.
    await onApproval.getByRole("link", { name: "See the task it was opened for" }).click();
    await expect(page.getByTestId("pull-requests").getByTestId("pull-request-state")).toHaveText("Merged", { timeout: 20_000 });

    // Nothing the provider needs to be trusted with ever reaches the page.
    expect(await page.content()).not.toContain(PULL_REQUEST_TOKEN);
    expect(errors).toEqual([]);
  } finally {
    await seeded.cleanup();
  }
});
