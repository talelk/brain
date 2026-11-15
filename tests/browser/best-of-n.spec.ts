import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";
import { finishCandidates, itemOf, runOfCandidate, seedCandidateMission, stageSingleStepWorkflows } from "../support/candidates-world";

/**
 * Best of several (#127), walked like a first-time user on the seeded Operations workspace: a person asks for three candidates on a step in
 * the plan editor, the three start together once work begins, each is shown with its own verdict, cost and time, the person compares two
 * outputs side by side, keeps one, binds that candidate's own evidence and finishes the task. The candidates not kept stay readable.
 */
test("a person plans three candidates, compares them, keeps one and finishes the task on its evidence", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const brain = governor.app.brain;
  stageSingleStepWorkflows(brain, demo.actor);
  const { missionId, workItemId } = await seedCandidateMission(brain, demo.actor, demo.workspaceId, { key: "bon", title: "Compare three briefs", autoStart: false, candidates: false });

  // The step is a plain one: nothing about it says best-of. In the editor the person asks for three candidates, each a member or a way of working.
  await page.goto(`${governor.url}/missions/${missionId}/plan?w=operations`);
  await page.getByRole("button", { name: /^See the confirmed plan's \d+ steps$/u }).click();
  await page.getByRole("button", { name: "Edit steps", exact: true }).first().click();
  const sheet = page.getByRole("dialog");
  const step = sheet.getByRole("region", { name: "Step 1" });
  await expect(step.getByTestId("plan-step-candidates")).toContainText("One attempt");
  await step.getByLabel("Candidates for this step").click();
  await page.getByRole("option", { name: "Best of 3", exact: true }).click();
  // Until every candidate says who runs it, and no two alike, the edits cannot be kept.
  await expect(step.getByTestId("plan-step-candidates")).toContainText("Choose who runs every candidate");
  await expect(sheet.getByRole("button", { name: "Keep edits", exact: true })).toBeDisabled();
  await step.getByLabel("Candidate 1 runs as").click();
  await page.getByRole("option", { name: "Team member: Writer (writer)", exact: true }).click();
  await step.getByLabel("Candidate 2 runs as").click();
  await expect(page.getByRole("option", { name: "Team member: Writer (writer)", exact: true })).toBeDisabled();
  await page.getByRole("option", { name: "Team member: Reviewer (reviewer)", exact: true }).click();
  await step.getByLabel("Candidate 3 runs as").click();
  await page.getByRole("option", { name: "Way of working: Second opinion", exact: true }).click();
  await expect(step.getByTestId("plan-step-candidates")).not.toContainText("Choose who runs every candidate");
  await sheet.getByRole("button", { name: "Keep edits", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("plan-step-candidates-line")).toContainText("Best of 3: writer, reviewer, general-single-b");
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm this plan", exact: true })).toHaveCount(0, { timeout: 20_000 });

  // Work begins: all three candidates start at once, none is kept, and the task says it is waiting for them.
  const planned = (brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId).prepare("SELECT id FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY rowid DESC LIMIT 1").get(missionId) as { id: string }).id;
  expect(planned).not.toBe(workItemId);
  await brain.executeCommand(demo.actor, { contractVersion: "brain.command/v1", commandId: "cmd-bon-on", commandType: "mission.policy.set", workspaceId: demo.workspaceId, idempotencyKey: "bon-on", expectedVersion: ((await brain.executeQuery(demo.actor, { queryType: "missions.get", workspaceId: demo.workspaceId, resourceId: missionId } as never)) as unknown as { snapshot: { version: number } }).snapshot.version, payload: { missionId, autoStart: true } } as never, "bon-on");
  await expect.poll(async () => (await itemOf(brain, demo.actor, demo.workspaceId, planned)).candidates?.items.length, { timeout: 20_000 }).toBe(3);
  await page.goto(`${governor.url}/missions/${missionId}/plan?w=operations&item=${planned}`);
  const candidates = page.getByTestId("work-candidates");
  await expect(candidates.getByTestId("work-candidate")).toHaveCount(3);
  await expect(candidates.getByTestId("work-candidates-waiting")).toBeVisible();
  await expect(candidates.getByRole("button", { name: /^Keep /u })).toHaveCount(0);

  // The candidates finish and are judged on their own: the first verified, the second not, the third failed.
  const { verifiedDigest } = await finishCandidates(brain, demo.actor, demo.workspaceId, planned);
  await page.reload();
  const one = candidates.locator('[data-candidate="c1"]'), two = candidates.locator('[data-candidate="c2"]'), three = candidates.locator('[data-candidate="c3"]');
  await expect(one).toContainText("writer");
  await expect(one).toContainText("Finished");
  await expect(one).toContainText("Check passed");
  await expect(one).toContainText("Suggested");
  await expect(two).toContainText("Check not passed");
  await expect(two).not.toContainText("Suggested");
  await expect(three).toContainText("Failed");
  await expect(one.getByTestId("work-candidate-cost")).toBeVisible();
  await expect(one.getByTestId("work-candidate-duration")).toContainText(/\d/u);
  // The task did not fail because one candidate did.
  await expect(page.getByRole("heading", { name: "Write the one-page brief" })).toBeVisible();
  await expect(page.getByText("2 of 3 candidates finished: compare them and keep one")).toBeVisible();
  await expect(three.getByRole("button", { name: /^Keep /u })).toHaveCount(0);

  // Reading the two finished outputs side by side is the output compare view.
  await candidates.getByRole("button", { name: "Compare outputs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Version comparison" })).toBeVisible();
  await expect(page.getByText("Writer's brief").first()).toBeVisible();
  await page.goBack();

  // The person keeps the suggested one; nothing was kept before, and the other output stays.
  expect((await itemOf(brain, demo.actor, demo.workspaceId, planned)).candidates?.keptRunId).toBeUndefined();
  await one.getByRole("button", { name: "Keep writer", exact: true }).click();
  await expect(one).toContainText("Kept");
  await expect(candidates.getByTestId("work-candidates-kept-note")).toBeVisible();
  expect((await itemOf(brain, demo.actor, demo.workspaceId, planned)).candidates?.keptRunId).toBe(runOfCandidate(brain, demo.actor, demo.workspaceId, planned, "c1"));

  // Done needs the kept candidate's own evidence: its bundle is offered, the other candidate's is not.
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  const move = page.getByRole("dialog");
  await move.getByLabel("Verified evidence for Write the one-page brief").click();
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option").first().click();
  await move.getByLabel(/^Move /u).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await move.getByRole("button", { name: "Move work item", exact: true }).click();
  await expect(move).toBeHidden();
  const done = await itemOf(brain, demo.actor, demo.workspaceId, planned);
  expect(done).toMatchObject({ state: "done", evidenceDigest: verifiedDigest });

  // Both outputs are still there to read; only the kept one is verified.
  await expect(candidates.getByRole("button", { name: "Compare outputs", exact: true })).toBeEnabled();
  const outputId = done.candidates!.items.find((entry) => entry.outputId)!.outputId!;
  const detail = ((await brain.executeQuery(demo.actor, { queryType: "missionOutputs.get", workspaceId: demo.workspaceId, resourceId: outputId } as never)) as unknown as { snapshot: { output: { versions: Array<{ verified: boolean }> } } }).snapshot;
  expect(detail.output.versions.map((version) => version.verified).sort()).toEqual([false, true]);
  expect(errors).toEqual([]);
});
