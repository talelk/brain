import { test, expect } from "./fixtures";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";
import { seedWhyRun } from "../support/why-demo";

/**
 * The run page says why (ticket 144, ADR 0062): a first-time user opens a run, picks the Why tab and reads, in plain sentences, which way of
 * working the task ran on, which team member took it and which model route it was handed first, each with the facts it was judged by, above
 * where the run sits among the runners. The sentences word what the Governor recorded when it chose; nothing is written by a model.
 */
test("the Why tab words the way of working, the team member and the model route a run was given, each with its facts", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "why");
  brain.createWorkspace(actor, { workspaceId: "ws-why", slug: "why" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-why")).actor;
  const { jobId } = await seedWhyRun(governor, scoped, "ws-why", "why");

  await page.goto(`${governor.url}/runs/${jobId}`);
  await expect(page.getByRole("heading", { name: "Run inspector" }).first()).toBeVisible();
  await page.getByRole("radio", { name: "Why", exact: true }).click();
  const choices = page.getByTestId("why-choices");
  await expect(choices).toBeVisible();

  const wayOfWorking = choices.locator("[data-choice-kind='way-of-working']");
  await expect(wayOfWorking).toContainText("This task ran on general-task, the general way of working, because nothing more specific applied.");
  await expect(wayOfWorking).toContainText("The task named no tools it must observe.");

  const member = choices.locator("[data-choice-kind='team-member']");
  await expect(member).toContainText("researcher (Researcher) took this task.");
  await expect(member).toContainText("Its agent is task-worker, running on fixture.");
  await expect(member).toContainText("Also eligible: writer.");

  const route = choices.locator("[data-choice-kind='model-route']");
  await expect(route).toContainText("The second attempt was handed primary-large (primary) first: place 2 in the model routes, cost tier standard.");
  await expect(route).toContainText("quota-out was left out: it is out of quota until");
  await expect(route).toContainText("backup was left out: it is switched off.");

  // Each choice says when it was recorded, and placement still follows below the choices.
  await expect(choices.locator("li").first()).toContainText("Recorded");
  await expect(page.getByRole("heading", { name: "Placement", level: 3 })).toBeVisible();
  await expect(page.getByText("Primary reason").first()).toBeVisible();
  // No sideways scroll at phone width, and nothing raw leaks into the sentences.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(choices).not.toContainText(/\[object|undefined|\{[a-z]+\}/);
  expect(errors).toEqual([]);
});

test("a run a person started by hand says that no choice was made for it", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "whyhand");
  brain.createWorkspace(actor, { workspaceId: "ws-hand", slug: "hand" });
  const bundle = fixtureStarter();
  const release = brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest;
  brain.activateRelease(actor, release);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-hand")).actor;
  const receipt = (await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: "cmd-hand", commandType: "workflow.dispatch", workspaceId: "ws-hand", idempotencyKey: "hand",
    payload: { workflow: { id: "general-task", digest: release }, input: { situation: "Write a short note about the offsite" } },
  } as never, "hand")).receipt;
  expect(receipt.accepted).toBe(true);
  await page.goto(`${governor.url}/runs/${receipt.resourceId}`);
  await page.getByRole("radio", { name: "Why", exact: true }).click();
  await expect(page.getByTestId("why-no-choices")).toContainText("No choice was made for this run");
  await expect(page.getByRole("heading", { name: "Placement", level: 3 })).toBeVisible();
  expect(errors).toEqual([]);
});
