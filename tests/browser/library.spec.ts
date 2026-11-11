import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import type { TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { achievedMission, command } from "../support/reuse";

// A first-time owner finds one Library in the main navigation, sees exact counts for what is waiting and what is
// published, approves a write-up from the Review inbox, and saves a result as knowledge that agents can search.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `library-${name}.png`), fullPage: true });
};

test("Library: one place in the navigation with exact counts, and Save as knowledge is searchable by agents", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Library organization");
  await page.getByLabel(/^Email/).fill("library@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();

  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-lib", slug: "library" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-lib")).actor;
  const world = { brain, owner: scoped, workspaceId: "ws-lib", org: actor.organizationId } as unknown as TestWorld;
  await achievedMission(world, "past", {
    title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["The report names the biggest causes"],
    outputs: [{ name: "churn-report.md", text: "# Churn report\nPricing confusion drove most cancellations." }],
  });
  // Named outputs open on `/outputs/output-…`; the helper's ids are shorter, so give its result a named-output id.
  const ws = brain.store.workspaceDb("ws-lib", actor.organizationId);
  ws.pragma("foreign_keys = OFF");
  ws.prepare("UPDATE output_versions SET output_id='output-past-0' WHERE output_id='out-past-0'").run();
  ws.prepare("UPDATE mission_outputs SET id='output-past-0' WHERE id='out-past-0'").run();
  ws.pragma("foreign_keys = ON");
  // The helper writes only the workspace's artifact row; a person can read the file through its organization association.
  const artifact = ws.prepare("SELECT id, digest FROM artifacts WHERE id='art-past-0'").get() as { id: string; digest: string };
  brain.store.control.prepare("INSERT INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(artifact.id, actor.organizationId, "ws-lib", artifact.digest, "job", "job-past", "internal", Date.now());
  const note = Buffer.from("# Onboarding\nNew engineers request access on day one.").toString("base64");
  await command(world, scoped, "document.upload", "doc-1", { title: "Onboarding notes", fileName: "onboarding.md", mediaType: "text/markdown", bytesBase64: note });

  // 1. Library is in the main navigation (desktop and phone), and opens the overview with exact counts.
  await page.goto(`${governor.url}/w/ws-lib/today`);
  const toggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/ws-lib\/library$/);
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByTestId("library-count-review")).toHaveText("1");
  await expect(page.getByTestId("library-count-knowledge")).toHaveText("0");
  await expect(page.getByTestId("library-count-documents")).toHaveText("1");
  await expect(page.getByTestId("library-count-plays")).toHaveText(/^\d+$/);
  await expect(page.getByTestId("library-count-tools")).toHaveText(/^\d+$/);
  await shot(page, "1-overview");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"), "Library overview accessibility").toEqual([]);

  // 2. The shelf opens the Review inbox inside the same Library tab bar; one approval moves the count.
  await page.getByTestId("library-shelf-review").click();
  await expect(page).toHaveURL(/\/w\/ws-lib\/knowledge\/review$/);
  await expect(page.getByRole("radiogroup", { name: "Library places" })).toBeVisible();
  const proposal = page.locator('[data-testid^="knowledge-proposal-"]').first();
  await expect(proposal).toContainText("Quarterly churn report");
  await proposal.getByRole("button", { name: "Approve and publish", exact: true }).click();
  await expect(proposal).toContainText("Published");
  await page.goto(`${governor.url}/w/ws-lib/library`);
  await expect(page.getByTestId("library-count-review")).toHaveText("0");
  await expect(page.getByTestId("library-count-knowledge")).toHaveText("1");

  // 3. Knowledge and Plays resolve into the Library: same tab bar, Library highlighted in the navigation.
  for (const route of ["knowledge", "plays", "knowledge?tab=documents"]) {
    await page.goto(`${governor.url}/w/ws-lib/${route}`);
    await expect(page.getByRole("radiogroup", { name: "Library places" })).toBeVisible();
  }
  await expect(page.getByRole("radio", { name: /^Documents/ })).toBeChecked();

  // 4a. An achieved mission offers "Propose as Play"; the proposal waits in the review inbox and approving opens a Studio draft only.
  const pastMission = (brain.store.workspaceDb("ws-lib", actor.organizationId).prepare("SELECT id FROM missions WHERE title='Quarterly churn report'").get() as { id: string }).id;
  await page.goto(`${governor.url}/missions/${encodeURIComponent(pastMission)}/outputs?w=ws-lib`);
  const offer = page.getByTestId("propose-play");
  await expect(offer).toContainText("Turn its plan, team and success criteria into a Play");
  await offer.getByRole("button", { name: "Propose as Play", exact: true }).click();
  await expect(offer).toContainText("waits in the Library's review inbox");
  await offer.getByRole("button", { name: "Open the review inbox", exact: true }).click();
  const proposals = page.getByTestId("play-proposals");
  await expect(proposals).toContainText("Quarterly churn report");
  await proposals.getByText("What the Play would contain").click();
  await expect(proposals).toContainText("The report names the biggest causes");
  await expect(proposals).toContainText("No notes, messages or documents are copied");
  await shot(page, "3-play-proposal");
  await expect(page.getByRole("radio", { name: /^Review inbox \(1\)/ })).toBeVisible();
  await proposals.getByRole("button", { name: "Approve and open a draft", exact: true }).click();
  await expect(proposals.getByRole("link", { name: "Open the draft in the Studio" })).toBeVisible();
  await proposals.getByRole("link", { name: "Open the draft in the Studio" }).click();
  await expect(page).toHaveURL(/\/studio\/Play\/draft-/u);
  await shot(page, "4-play-draft");
  // Nothing was activated: the Play only exists as a draft.
  expect(brain.store.control.prepare("SELECT COUNT(*) AS n FROM config_drafts WHERE kind='Play'").get()).toEqual({ n: 1 });

  // 4. Save as knowledge on a result: the document is read and says it is searchable by agents.
  await page.goto(`${governor.url}/outputs/output-past-0?w=ws-lib`);
  await page.getByRole("button", { name: "Save as knowledge", exact: true }).click();
  await expect(page.getByText(/searchable by agents now/)).toBeVisible();
  await shot(page, "2-saved");
  await page.goto(`${governor.url}/w/ws-lib/library`);
  await expect(page.getByTestId("library-count-documents")).toHaveText("2");
  expect(errors).toEqual([]);
});
