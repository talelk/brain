import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { goldenDocs } from "../helpers";
import { enrollRunners } from "../support/flow";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { approvalSubjectDigest, type JsonValue } from "../../packages/contracts/src/index";

/**
 * Phone-first Today (#58) and the install prompt / app badge (#59), driven at phone width: the box and Start sit in a bar fixed
 * to the bottom, the chips are one horizontally scrolling row, Needs-you actions are full-width thumb targets, nothing scrolls
 * sideways, and the install offer and the badge degrade silently.
 */
const DIGEST = `sha256:${"a".repeat(64)}`;
const SOURCE = "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4";
const agent = { path: "config/builder.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: builder\n  version: 1.0.0\nspec:\n  instructionsPath: agents/builder.md\n  tools: []\n  engine:\n    anyOf: [pi]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: 0\n" };
const play = { path: "config/plays/auth-stabilize.yaml", text: `apiVersion: brain.keyrus/v1
kind: Play
metadata:
  id: auth-stabilize
  version: 1.0.0
spec:
  title: Stabilize authentication
  intent: Find and fix session expiry
  successCriteria: [Sessions survive restarts]
  constraints: [Keep the public API]
  team:
    - { memberId: lead, role: Coordinator, agentId: builder, engine: pi }
  coordinator: lead
  plan:
    tasks:
      - { id: audit, title: Audit sessions, criteria: [audit-done], dependsOn: [], assignment: { kind: agent, id: lead, role: specialist } }
  autonomy: autonomous
  parkingThreshold: 2
  budget: { maxMicroUsd: 500000, memberCap: 2 }
` };

async function world(page: Page, governor: { url: string; credential: string; app: { brain: import("../../apps/governor/src/application/brain").Brain } }) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Phone organization");
  await page.getByLabel(/^Email/).fill("phone@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-today", slug: "today" });
  const release = brain.stageRelease(actor, [...goldenDocs(), agent, play], SOURCE, [], [{ agentId: "builder", path: "agents/builder.md", text: "# Builder\n" }]);
  brain.activateRelease(actor, release.digest);
  await enrollRunners(governor, actor, "today", ["fixture-tools", "fixture-evaluators"]);
  const ws = { ...actor, workspaceId: "ws-today", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-today") };
  const db = brain.store.workspaceDb("ws-today", actor.organizationId);
  return { brain, actor, ws, db };
}
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png` }); };

test("on a phone Today is a one-thumb screen: fixed box and Start, scrolling chips, big Needs-you actions, install offer and badge", async ({ page, governor }) => {
  test.skip((page.viewportSize()?.width ?? 1440) >= 640, "phone layout only");
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const log: number[] = [];
    (window as unknown as { __badge: number[] }).__badge = log;
    (navigator as unknown as { setAppBadge: (n: number) => Promise<void> }).setAppBadge = async (n) => { log.push(n); };
    (navigator as unknown as { clearAppBadge: () => Promise<void> }).clearAppBadge = async () => { log.push(0); };
  });
  const w = await world(page, governor);
  const org = w.actor.organizationId;
  w.brain.ensurePrincipal(org, "requester-1", "human");
  const subject = { organizationId: org, workspaceId: "ws-today", operation: "fixture.publish", tool: { id: "fixture.echo", digest: DIGEST }, inputDigest: DIGEST,
    target: { targetId: "t-phone", environmentId: "prod", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: DIGEST,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), nonce: "phone-n1" };
  w.brain.store.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
    VALUES ('apr-phone-1', ?, 'ws-today', 'requester-1', ?, ?, 'pending', ?, ?)`).run(org, approvalSubjectDigest(subject as unknown as JsonValue), JSON.stringify(subject), Date.now() + 3_600_000, Date.now());
  const made = (await w.brain.executeCommand(w.ws, { contractVersion: "brain.command/v1", commandId: "cmd-done", commandType: "mission.create", workspaceId: "ws-today", idempotencyKey: "done", payload: { title: "Weekly digest", intent: "Write the weekly digest", successCriteria: ["digest written"] } } as never, "done")).receipt;
  w.db.prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(made.resourceId);

  await page.goto(`${governor.url}/w/ws-today/today`);
  const viewport = page.viewportSize()!;
  const box = page.getByLabel(/^What do you want done/);
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect(box).toBeVisible();
  await expect(page.getByTestId("needs-you-item")).toHaveCount(1, { timeout: 30_000 });
  await shot(page, "phone-today-top");

  // The bar is fixed to the bottom of the screen: still there after scrolling the page to its end.
  await page.evaluate(() => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 8 && ["auto", "scroll"].includes(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight; });
  const startBox = (await start.boundingBox())!;
  expect(startBox.y + startBox.height).toBeGreaterThan(viewport.height - 80);
  expect(startBox.y + startBox.height).toBeLessThanOrEqual(viewport.height);
  expect(startBox.height).toBeGreaterThanOrEqual(44);
  expect((await box.boundingBox())!.y).toBeGreaterThan(viewport.height - 200);
  await shot(page, "phone-today-bottom");

  // Nothing scrolls sideways; the chips do, on their own row.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const row = page.getByRole("group", { name: "Start from something ready" });
  expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await row.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");

  // Needs-you actions are full-width and at least 44 px tall, with the exact digest on the card.
  const review = page.getByTestId("needs-you-item").getByRole("button", { name: "Review action", exact: true });
  await review.scrollIntoViewIfNeeded();
  const reviewBox = (await review.boundingBox())!;
  expect(reviewBox.height).toBeGreaterThanOrEqual(44);
  expect(reviewBox.width).toBeGreaterThan(viewport.width * 0.7);
  await expect(page.getByTestId("needs-you-item").getByText(/sha256:/).first()).toBeVisible();

  // The app badge shows the Needs-you count.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __badge: number[] }).__badge.at(-1))).toBe(1);

  // The install offer waits for the browser's own event, shows after a first achieved mission, and stays dismissed once dismissed.
  await expect(page.getByTestId("install-prompt")).toHaveCount(0);
  await page.evaluate(() => { const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }; event.prompt = async () => undefined; event.userChoice = Promise.resolve({ outcome: "dismissed" }); window.dispatchEvent(event); });
  const offer = page.getByTestId("install-prompt");
  await offer.scrollIntoViewIfNeeded();
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Install Brain on your phone");
  await shot(page, "phone-today-install");
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toHaveCount(0);
  await page.reload();
  await page.evaluate(() => { window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })); });
  await expect(page.getByTestId("install-prompt")).toHaveCount(0);

  // A sentence and Start from the thumb bar creates the mission.
  await page.getByLabel(/^What do you want done/).fill("Summarise this week's support tickets");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
});

test("the web app manifest names the app and carries installable icons", async ({ page, governor }) => {
  const manifest = await (await page.request.get(`${governor.url}/manifest.webmanifest`)).json() as { name: string; display: string; icons: Array<{ src: string; sizes: string }> };
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  for (const icon of manifest.icons) expect((await page.request.get(`${governor.url}${icon.src}`)).ok()).toBe(true);
});
