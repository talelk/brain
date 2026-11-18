import { expect, signIn, test } from "./stack";

test("a workspace is made from a pack and its first goal is started", async ({ page, stack }) => {
  await stack.setUp();
  await signIn(page, stack);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "New workspace" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New workspace" })).toBeVisible();

  await page.getByRole("textbox", { name: /^Name/u }).fill("Customer care");
  // The address is made from the name and kept out of the way until the person asks to change it.
  await expect(page.getByTestId("address-preview")).toContainText("/w/customer-care");
  await expect(page.getByRole("textbox", { name: "Address" })).toHaveCount(0);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("checkbox", { name: /customer-operations/u }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Create the workspace" }).click();

  // The new workspace is open on Today, with the pack's Plays to start from.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Customer care/u })).toBeVisible();
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

test("a workspace with no model says so beside the goal, and the warning goes once a model is connected", async ({ page, stack }) => {
  const api = await stack.setUp();
  const made = await api.command("workspace.create", { name: "Plain", packs: ["base"] });
  await signIn(page, stack);
  await page.goto(`${stack.url}/w/${made.slug}`);
  await expect(page.getByTestId("goal-nomodel")).toContainText("No model is connected yet");
  await page.getByTestId("goal-nomodel").getByRole("button", { name: "Connect a model first" }).click();
  await page.getByLabel("Address").fill("http://127.0.0.1:9/v1");
  await page.getByLabel("Model name").fill("fixture-model");
  await page.getByRole("button", { name: "Connect the model" }).click();
  await expect(page.getByText("Model connected: fixture-model")).toBeVisible();
  await expect(page.getByTestId("goal-nomodel")).toHaveCount(0);
});

test("a name that makes an address a workspace already has is refused while typing; the optional URLs fill the project and the folder remote", async ({ page, stack }) => {
  const api = await stack.setUp();
  await api.command("workspace.create", { name: "Café Réseau", packs: ["base"] });
  await signIn(page, stack);
  await page.goto(`${stack.url}/new`);
  await page.getByRole("textbox", { name: /^Name/u }).fill("CAFE reseau");
  await expect(page.getByText("A workspace already has the address cafe-reseau. Change the name.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

  await page.getByRole("textbox", { name: /^Name/u }).fill("Corner shop");
  await expect(page.getByText("A workspace already has the address")).toHaveCount(0);
  await page.getByRole("button", { name: "Change the address" }).click();
  await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue("");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();

  // One repository field: the name and branch are inferred, and write access is one switch.
  await page.getByRole("textbox", { name: /^Code repository/u }).fill("http://127.0.0.1:9/acme/billing-api.git");
  await expect(page.getByTestId("inferred-project")).toContainText("billing-api");
  await page.getByText("Let agents open pull requests", { exact: true }).click();
  await page.getByRole("textbox", { name: /^Git remote/u }).fill("http://127.0.0.1:9/acme/corner-shop-files.git");
  await page.getByRole("button", { name: "Create the workspace" }).click();
  await expect(page).toHaveURL(/\/w\/corner-shop/u);

  const made = (await api.query("me", {})).workspaces.find((workspace) => workspace.slug === "corner-shop");
  const text = (await api.query("file.read", { workspaceId: made?.id ?? "", path: "brain.toml" })).content;
  expect(text).toContain('name = "billing-api"');
  expect(text).toContain('access = "write"');
  expect(text).toContain("[git]");
  expect(text).toContain('remote = "http://127.0.0.1:9/acme/corner-shop-files.git"');
});

test("the other forms infer what can be inferred: file names from titles, step ids from agents, no defaults in the file", async ({ page, stack }) => {
  const api = await stack.setUp();
  const made = await api.command("workspace.create", { name: "Forms", packs: ["base"] });
  await signIn(page, stack);
  await page.goto(`${stack.url}/w/${made.slug}/workspace/agents`);
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Release Manager");
  await expect(page.getByTestId("file-preview")).toContainText("agents/release-manager/agent.toml");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/workspace\/agents\/release-manager/u);
  await page.getByRole("textbox", { name: /^Description/u }).first().fill("Prepares a release.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  const agent = (await api.query("file.read", { workspaceId: made.workspaceId, path: "agents/release-manager/agent.toml" })).content;
  expect(agent).not.toContain("turns");
  expect(agent).not.toContain("tokens");

  await page.goto(`${stack.url}/w/${made.slug}/workspace/plays`);
  await page.getByRole("button", { name: "New Play" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Weekly report");
  await expect(page.getByTestId("file-preview")).toContainText("plays/weekly-report.toml");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /^Title/u })).toHaveValue("Weekly report");
  await expect(page.getByTestId("step-id").first()).toContainText("checker");
});
