import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./fixtures";

test.use({ localRuntime: true });
test("administrator connects a model and both local runners enroll without a human session", async ({ page, governor }) => {
  test.setTimeout(120000);
  const upstream = createServer((request, response) => {
    if (request.url !== "/v1/models" || request.headers.authorization !== "Bearer test-model-key") { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "local-browser-model" }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No model endpoint address");
  const children: ChildProcess[] = [];
  try {
    const bootstrap = await page.request.post(`${governor.url}/v1/setup`, { headers: { authorization: `Setup ${governor.credential}` }, data: { email: "operator@example.test", password: "model-setup-password-123", name: "Setup test", organizationId: "org-local" } });
    expect(bootstrap.status()).toBe(201);
    const result = await bootstrap.json();
    const identity = await governor.app.brain.resolveActor(new Headers({ authorization: `Bearer ${result.sessionToken}` }));
    governor.app.brain.createWorkspace(identity.actor, { workspaceId: "operations", slug: "My workspace" });
    await page.goto(`${governor.url}/settings?tab=setup`);
    await expect(page.getByRole("heading", { name: "Connect your local model", exact: true })).toBeVisible();
    for (const group of ["agents", "evaluators"]) {
      const id = `runner-${group}-1`;
      const claude = group === "evaluators" ? { BRAIN_ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, BRAIN_CLAUDE_MODEL: "local-browser-model", ANTHROPIC_API_KEY: "test-model-key" } : {};
      const child = spawn(process.execPath, ["--import", "tsx", "apps/runner/src/main.ts"], { env: { PATH: process.env["PATH"], BRAIN_GOVERNOR_URL: governor.url, BRAIN_RUNNER_ID: id, BRAIN_RUNNER_STATE_DIR: join(governor.app.brain.store.dataDir, "local-runtime", `${id}-state`), BRAIN_LOCAL_RUNNER: "true", ...claude }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.resume(); child.stderr?.resume(); children.push(child);
    }
    await page.getByLabel(/^Model API URL/).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel(/^Model ID/).fill("unknown-model");
    await page.getByLabel(/^Model API key/).fill("test-model-key");
    await page.getByRole("button", { name: "Test connection and start runners", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Could not find that model");
    await page.getByLabel(/^Model ID/).fill("local-browser-model");
    await page.getByRole("button", { name: "Test connection and start runners", exact: true }).click();
    await expect(page.getByText("Task runner: Ready", { exact: true })).toBeVisible({ timeout: 45000 });
    await expect(page.getByText("Independent validator: Ready", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/^Model API key/)).toHaveValue("");
    const snapshot = await page.request.get(`${governor.url}/v1/local-runtime`);
    expect(await snapshot.text()).not.toContain("test-model-key");
    const diagnostics = await page.request.get(`${governor.url}/v1/diagnostics?workspaceId=operations`); expect(diagnostics.status()).toBe(200); expect(await diagnostics.text()).not.toContain("test-model-key");
    await page.reload();
    await expect(page.getByLabel(/^Model ID/)).toHaveValue("local-browser-model");
    expect(children.every((child) => child.exitCode === null)).toBe(true);
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM"); await exited;
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
