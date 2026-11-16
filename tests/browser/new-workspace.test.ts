import { expect, signIn, test } from "./stack";

test("a workspace is made from a pack and its first goal is started", async ({ page, stack }) => {
  await stack.setUp();
  await signIn(page, stack);
  await page.getByRole("button", { name: /Switch workspace/u }).click();
  await page.getByRole("menuitem", { name: "New workspace" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New workspace" })).toBeVisible();

  await page.getByRole("textbox", { name: /^Name/u }).fill("Customer care");
  await expect(page.getByText(/Found at/u)).toContainText("customer-care");
  await page.getByRole("checkbox", { name: /customer-operations/u }).check();
  await page.getByRole("button", { name: "Create the workspace" }).click();

  // The new workspace is open on Today, with the pack's Plays to start from.
  await expect(page.getByRole("button", { name: "Customer care" })).toBeVisible();
  await expect(page).toHaveURL(/\/w\/customer-care/u);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByLabel("Address").fill("http://127.0.0.1:9/v1");
  await page.getByLabel("Model name").fill("fixture-model");
  await page.getByRole("button", { name: "Connect the model" }).click();
  await expect(page.getByText("Model connected: fixture-model")).toBeVisible();

  await page.getByRole("textbox", { name: "Your goal" }).fill("Answer the customer who asked where their invoice is");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Answer the customer who asked where their invoice is" })).toBeVisible();
  await expect(page.getByText("Confirm the plan").first()).toBeVisible();
});
