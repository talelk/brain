import { EMAIL, expect, NAME, PASSWORD, test } from "./stack";

test("from the setup link to a checked result @phone", async ({ page, stack }) => {
  await page.goto(stack.setupLink);
  await expect(page.getByRole("heading", { name: "Set up Brain" })).toBeVisible();
  // The link carries the token, so the first-time user only says who they are.
  await page.getByLabel("Your name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create the account" }).click();

  await expect(page.getByRole("heading", { name: "What do you want done?" })).toBeVisible();
  // The first screen is never empty: the Starter workspace asks for a model, then offers the sample goal.
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByLabel("Address").fill("http://127.0.0.1:9/v1");
  await page.getByLabel("Model name").fill("fixture-model");
  await page.getByRole("button", { name: "Connect the model" }).click();
  await expect(page.getByText("Model connected: fixture-model")).toBeVisible();

  await page.getByRole("button", { name: 'Start "Say hello"' }).click();
  // A goal started from a Play is on its own page, and the page follows it until the result is checked.
  await expect(page.getByRole("heading", { level: 1, name: "Say hello" })).toBeVisible();
  await expect(page.getByText(`Started by ${NAME}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Result" }).first()).toBeVisible();
  await expect(page.getByText("Done, checked by checker")).toBeVisible();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();

  // The step: what it produced, who checked it, what it cost.
  await page.getByRole("button", { name: /Describe/u }).click();
  await expect(page.getByRole("heading", { name: "Result" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check", exact: true })).toBeVisible();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cost" })).toBeVisible();

  // Back on Today, the goal is among the recent results.
  await page.goto(stack.url);
  await expect(page.getByRole("heading", { name: "Recent results" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Say hello/u })).toBeVisible();
});
