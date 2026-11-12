import { join } from "node:path";
import { test, expect } from "./fixtures";
import { sha256Digest } from "../../packages/contracts/src/index.ts";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello } from "../../apps/runner/src/supervisor";
import { GovernorClient } from "../../apps/runner/src/governor-client";
import { putBytes } from "../../apps/governor/src/modules/artifacts/index";

/** Issue #84: the Tools tab says what each tool does, who may call it, how often it ran, and "Never used" when it did not, and whether it is available at all. */
test("Tools tab lists what each tool does, which agents may use it, calls, last failure and the run behind them", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const shots = process.env["BRAIN_SHOTS"] ?? "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const brain = governor.app.brain;
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Tools organization");
  await page.getByLabel(/^Email/).fill("tools@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-tools", slug: "tools" });
  const bundle = fixtureStarter();
  const release = brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  brain.activateRelease(actor, release.digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-tools")).actor;

  // One real run whose agent proposed documents.read twice (one call failed) and csv.query once, recorded through the runner protocol.
  await brain.executeCommand(scoped, { contractVersion: "brain.command/v1", commandId: "cmd-tools-run", commandType: "workflow.dispatch", workspaceId: "ws-tools", idempotencyKey: "tools-run", payload: { workflow: { id: "general-task", digest: release.digest }, input: { situation: "Compare two venues" } } } as never, "tools-run");
  const cfg = { governorUrl: governor.url, runnerId: "tools-agents", stateDir: join(brain.store.dataDir, "agents"), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
  const session = await enrollAndHello(cfg, brain.jobProtocol.issueEnrollment(actor, "agents").token);
  const client = new GovernorClient(cfg);
  client.setToken(session.sessionToken);
  const offer = (await client.claim("tools-claim"))!;
  await client.ack(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  const digestOf = (id: string) => sha256Digest(new TextEncoder().encode(bundle.documents.find((doc) => doc.path.endsWith(`${id}.yaml`))!.text));
  const testNow = Math.floor(Date.now() / 1000) * 1000;
  const recentAt = (seconds: number) => new Date(testNow - 3_600_000 + seconds * 1000).toISOString();
  const oldAt = (seconds: number) => new Date(testNow - 30 * 86_400_000 + seconds * 1000).toISOString();
  let sequence = 0;
  const event = (kind: string, payload: Record<string, unknown>, at: string) => ({ sequence: ++sequence, kind: "engine", payload: { contractVersion: "brain.engine-event/v1", eventId: `e${sequence}`, sessionId: "s", attemptId: offer.attemptId, sequence, occurredAt: at, kind, payload } });
  const proposed = (proposalId: string, id: string, at: string) => event("tool.proposed", { proposalId, tool: { id, digest: digestOf(id) }, input: {}, target: { targetId: `tool:${id}`, environmentId: "local", preconditionDigest: digestOf(id) }, inputDigest: sha256Digest(new TextEncoder().encode("{}")) }, at);
  const errorBytes = new TextEncoder().encode(JSON.stringify({ error: "document not found in this workspace. Use an id exactly as given in your context." }));
  const errorDigest = putBytes(brain.store, errorBytes);
  const result = (proposalId: string, outcome: string, at: string) => event("tool.result", { proposalId, invocationId: proposalId, receipt: { invocationId: proposalId, attemptId: offer.attemptId, jobFence: offer.jobFence, result: outcome, startedAt: at, finishedAt: at, ...(outcome === "failed" ? { stdout: { artifactId: "att-err", digest: errorDigest, bytes: errorBytes.length, mediaType: "application/json", classification: "internal" } } : {}), effects: [] } }, at);
  await client.events(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, events: [
    proposed("p1", "documents.read", recentAt(0)), result("p1", "succeeded", recentAt(1)),
    proposed("p2", "documents.read", recentAt(300)), result("p2", "failed", recentAt(301)),
    proposed("p3", "csv.query", recentAt(360)), result("p3", "succeeded", recentAt(361)),
    // Before the 7-day window: documents.read failed once before a fix; web.fetch has only this old call.
    proposed("p4", "documents.read", oldAt(0)), result("p4", "failed", oldAt(1)),
    proposed("p5", "web.fetch", oldAt(60)), result("p5", "succeeded", oldAt(61)),
  ] });

  await page.goto(`${governor.url}/w/ws-tools/knowledge?tab=tools`);
  await expect(page.getByRole("heading", { name: "Trusted capability registry" })).toBeVisible();
  const row = (id: string) => page.getByRole("button", { name: new RegExp(`^${id.replace(".", "\\.")}\\.`) });
  // This workspace holds no documents and no CSV files: both tools say so instead of looking trusted and ready.
  await expect(row("documents.read")).toContainText("Not available: no documents yet");
  await expect(row("documents.read")).toContainText("2 calls, 1 failed (50%)");
  await expect(row("csv.query")).toContainText("Not available: no CSV files yet");
  await expect(row("csv.query")).toContainText("1 call, none failed");
  await expect(row("web.fetch")).toContainText("no calls in the last 7 days");
  await expect(row("web.fetch")).not.toContainText("Not available");
  await expect(row("operations.context")).toContainText("Never used");
  if (shots) await page.screenshot({ path: `${shots}/tools-1-list.png`, fullPage: true });

  await row("documents.read").click();
  await expect(page.locator("[data-tool-description]")).toContainText("Reads one saved workspace document");
  await expect(page.locator("[data-tool-agents]")).toHaveText("task-worker");
  await expect(page.locator("[data-tool-calls]")).toHaveText("2 calls, 1 failed (50%)");
  await expect(page.locator("[data-tool-lifetime]")).toHaveText("lifetime: 3 calls, 2 failed");
  await expect(page.locator("[data-tool-availability]")).toHaveText("Not available: no documents yet");
  await expect(page.locator("[data-tool-last-error]")).toContainText("document not found in this workspace");
  await expect(page.getByText("Last failure", { exact: true })).toBeVisible();
  // The evidence row shows the pinned script itself instead of "Preview unavailable: artifact not found".
  await expect(page.getByText("Preview unavailable")).toHaveCount(0);
  await expect(page.getByText("set -euo pipefail").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the run" }).first()).toHaveAttribute("href", new RegExp(`/runs/${offer.workflowRunId}`));
  await expect(page.getByText("Active since", { exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/tools-2-detail.png`, fullPage: true });

  await row("web.fetch").click();
  await expect(page.locator("[data-tool-calls]")).toHaveText("no calls in the last 7 days");
  await expect(page.locator("[data-tool-lifetime]")).toHaveText("lifetime: 1 call, none failed");
  await expect(page.locator("[data-tool-availability]")).toHaveText("Available");
  await expect(page.locator("[data-tool-hosts]")).toContainText("en.wikipedia.org");
  await expect(page.locator("[data-tool-agents]")).toHaveText("task-worker");
  await row("operations.context").click();
  await expect(page.locator("[data-tool-calls]")).toHaveText("Never used");
  await row("task.validate").click();
  await expect(page.locator("[data-tool-agents]")).toContainText("No agent has this tool in its allowlist");
  expect(errors).toEqual([]);
});
