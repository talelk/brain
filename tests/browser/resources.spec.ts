import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { Brain } from "../../apps/governor/src/application/brain";

interface GovernorFixture { url: string; credential: string; app: { brain: Brain } }
const DIGEST_A = `sha256:${"a".repeat(64)}`;

async function resourceWorld(page: Page, governor: GovernorFixture) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Resource organization");
  await page.getByLabel(/^Email/).fill("resources@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-resources", slug: "resources" });
  const ws = brain.store.workspaceDb("ws-resources", actor.organizationId);
  const now = Date.now();
  ws.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-resource','Resource objective','Resource intent','[\"echo\"]','owner',?,?)").run(now, now);
  ws.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-resource','obj-resource',1,?,'confirmed','manual','owner','[]',?)").run(DIGEST_A, now);
  ws.prepare("INSERT INTO work_items(id,objective_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('work-ui-resource','obj-resource','plan-resource','task','Document-backed task','ready','[\"echo\"]','Start',?,?)").run(now, now);
  await page.goto(`${governor.url}/w/ws-resources/resources`);
  await expect(page.getByRole("heading", { name: "Resources", exact: true, level: 1 })).toBeVisible();
  return { brain, ws };
}

test("resources: upload, safely preview, revise, associate, search and revoke workspace documents (T54, E107)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { ws } = await resourceWorld(page, governor);

  await page.getByLabel("Document title", { exact: true }).fill("Incident guide");
  await page.getByLabel("Document file", { exact: true }).setInputFiles({ name: "guide.md", mimeType: "text/markdown", buffer: Buffer.from("# Guide\n<script>alert('safe')</script>\nold-browser-token") });
  await page.getByRole("button", { name: "Upload document", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(1);
  await expect(page.locator("pre")).toContainText("<script>alert('safe')</script>");
  await expect(page.locator("pre")).toContainText("old-browser-token");
  const documentId = (ws.prepare("SELECT id FROM documents").get() as { id: string }).id;
  const firstDigest = (ws.prepare("SELECT digest FROM document_versions WHERE revision=1").get() as { digest: string }).digest;

  await page.getByLabel("Resource id", { exact: true }).fill("work-ui-resource");
  await page.getByRole("button", { name: "Associate document", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT COUNT(*) AS n FROM resource_associations WHERE document_id=?").get(documentId) as { n: number }).n).toBe(1);
  await expect(page.getByText("workItem · work-ui-resource", { exact: true })).toBeVisible();

  await page.getByLabel("New version file", { exact: true }).setInputFiles({ name: "guide-v2.md", mimeType: "text/markdown", buffer: Buffer.from("# Guide\nnew-browser-token") });
  await page.getByRole("button", { name: "Create new version", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT version FROM documents WHERE id=?").get(documentId) as { version: number }).version).toBe(2);
  await expect(page.locator("pre")).toContainText("new-browser-token");
  await expect(page.locator("pre")).not.toContainText("old-browser-token");
  expect((ws.prepare("SELECT digest FROM document_versions WHERE revision=1").get() as { digest: string }).digest).toBe(firstDigest);
  await expect(page.getByText("v1", { exact: true })).toBeVisible();
  await expect(page.getByText("v2", { exact: true })).toBeVisible();

  await page.getByLabel("Search documents", { exact: true }).fill("old-browser-token");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No matching documents", { exact: true })).toBeVisible();
  await page.getByLabel("Search documents", { exact: true }).fill("new-browser-token");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Incident guide", { exact: true })).toBeVisible();
  expect((ws.prepare("SELECT COUNT(*) AS n FROM memory_publications").get() as { n: number }).n).toBe(0);

  await page.getByLabel("Revocation reason", { exact: true }).fill("Retired for browser acceptance");
  await page.getByRole("button", { name: "Revoke document", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM documents WHERE id=?").get(documentId) as { state: string }).state).toBe("revoked");
  await expect(page.getByText("No matching documents", { exact: true })).toBeVisible();
  expect((ws.prepare("SELECT COUNT(*) AS n FROM document_versions WHERE document_id=?").get(documentId) as { n: number }).n).toBe(2);
  expect(errors).toEqual([]);
});
