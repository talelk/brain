import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { enrollRunners, signUpOwner } from "../support/flow";
import { observation, registerRunner } from "../support/runnerHello";

/**
 * The Runners page states what a runner reported or probed, and nothing else (spec #90, story 29). A person opens the fleet, then one runner:
 * a real fixture runner shows its engine with the digest of the adapter it really runs and no version it never stated; a runner that
 * reports a version shows exactly that; nothing on the page is a placeholder.
 */
test("runner detail shows only what the runner reported", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor } = await signUpOwner(page, governor, "observed");
  brain.createWorkspace(actor, { workspaceId: "ws-observed", slug: "observed" });
  const starter = fixtureStarter();
  brain.activateRelease(
    actor,
    brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest,
  );
  await enrollRunners(governor, actor, "observed", ["agents"]);
  const probedAt = new Date(Date.now() - 4 * 60_000).toISOString();
  registerRunner(brain, actor, "observed-pi", {
    engines: [{ id: "pi", version: "1.4.0", adapterDigest: `sha256:${"d".repeat(64)}`, features: ["sessions", "steer"] }],
    capabilities: [observation("os:linux", probedAt), observation("engine:pi", probedAt)],
  });

  // The fleet lists both runners; the real one is opened first.
  await page.goto(`${governor.url}/runners`);
  await expect(page.getByRole("heading", { name: "Runners", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("row", { name: /observed-pi/ })).toBeVisible();
  await page
    .getByRole("row", { name: /observed-agents/ })
    .getByRole("button", { name: "Details" })
    .click();
  await expect(page.getByRole("heading", { name: "observed-agents" })).toBeVisible();

  // The engine is the one the runner probed: its adapter's own digest, and no version because the fixture engine states none.
  const fixture = page.getByTestId("runner-engine-fixture");
  await expect(fixture).toBeVisible();
  const adapterDigest = `sha256:${createHash("sha256").update(readFileSync("apps/runner/src/engines/fixture.ts")).digest("hex")}`;
  await expect(fixture).toContainText(`Adapter digest ${adapterDigest}`);
  await expect(fixture).toContainText("Features: sessions, steer");
  await expect(fixture).not.toContainText("version");
  await expect(page.getByText("reported by the runner").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("0".repeat(64));

  // A runner that states a version shows exactly that, with the time it observed its capabilities (not the time of the page).
  await page.goto(`${governor.url}/runners/observed-pi`);
  const pi = page.getByTestId("runner-engine-pi");
  await expect(pi).toContainText("version 1.4.0");
  await expect(pi).toContainText(`Adapter digest sha256:${"d".repeat(64)}`);
  const snapshot = (await brain.executeQuery(actor, { queryType: "runner.get", resourceId: "observed-pi" })) as unknown as {
    snapshot: { capabilities: Array<{ capability: string; observedAt: string }> };
  };
  expect(snapshot.snapshot.capabilities.find((entry) => entry.capability === "engine:pi")!.observedAt).toBe(probedAt);

  // A runner that reported no engine says so instead of showing one.
  registerRunner(brain, actor, "observed-bare", {});
  await page.goto(`${governor.url}/runners/observed-bare`);
  await expect(page.getByText("This runner has not reported an engine.")).toBeVisible();
  expect(errors).toEqual([]);
});
