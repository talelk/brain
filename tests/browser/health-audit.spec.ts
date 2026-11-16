import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { enrollRunners, signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";

// Spec #90 story 107 (ticket #152), walked as a first-time administrator: Health has an "Audit log" line saying the log was verified and when
// the last signed checkpoint was written; when someone changes an event behind Brain's back, the next check turns the line red, says where, and
// Health says something needs attention. The diagnostics download carries the public audit key.
const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;

test("Health reports the audit log chain, and turns red when an event is changed behind Brain's back", async ({ page, governor }, info) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "audit");
  await page.getByLabel("Display name").fill("Audit workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  await enrollRunners(governor, actor, "audit");
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
  const inWorkspace = (await brain.resolveActor(new Headers({ cookie }), workspaceId)).actor;
  await brain.executeCommand(inWorkspace, { contractVersion: "brain.command/v1", commandId: "cmd-audit-1", commandType: "mission.create", workspaceId, idempotencyKey: "audit-mission", payload: { title: "Check the audit trail", intent: "Give the audit log something to hold", successCriteria: ["Every event is accounted for"] } }, "audit-mission");
  const refresh = async () => { await brain.runEngineProbes(fakeFetch); await page.reload(); await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible(); };
  const card = (name: string) => page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });

  // From the menu, as a person would: Administration, then Health.
  const openNav = async () => { const toggle = page.getByRole("button", { name: "Open application navigation", exact: true }); if (await toggle.isVisible()) await toggle.click(); };
  await openNav();
  await page.getByRole("navigation", { name: "Brain navigation" }).getByRole("button", { name: "Administration", exact: true }).click();
  await openNav();
  await page.getByRole("navigation", { name: "Brain navigation" }).getByRole("button", { name: "Health", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible();
  await refresh();

  // 1. A fresh install: the chain is verified and a signed checkpoint already exists.
  await expect(card("Audit log")).toContainText(/Audit log verified: \d+ events in 2 logs\. Last checkpoint just now\./u);
  await expect(card("Audit log").getByText("Healthy", { exact: true })).toBeVisible();
  await info.attach("health-audit-ok", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // 2. Someone with write access to the data files edits one of the newest events (an older one is found at the next full walk, see the Governor-seam test). The attack is a table write; Brain only reads.
  const db = brain.store.workspaceDb(workspaceId, actor.organizationId);
  db.prepare("UPDATE events SET actor_id='intruder' WHERE cursor=(SELECT MAX(cursor) FROM events)").run();
  await refresh();
  await expect(card("Audit log")).toContainText("The audit log failed verification");
  await expect(card("Audit log")).toContainText("Run brain audit verify for the full report");
  await expect(card("Audit log").getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Something needs attention", { exact: true })).toBeVisible();
  await expect(page.getByText(/Audit log is not healthy/)).toBeVisible();
  await info.attach("health-audit-broken", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // 3. The diagnostics bundle carries the public audit key and where each log stands, and no event content.
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download diagnostics", exact: true }).click();
  const download = await downloading;
  const path = info.outputPath("diagnostics.json");
  await download.saveAs(path);
  const text = readFileSync(path, "utf8");
  const bundle = JSON.parse(text) as { audit: { activeKeyId: string; keys: Array<{ keyId: string; algorithm: string; publicKey: string }>; scopes: Array<{ scope: string; headSeq: number; lastCheckpoint: { keyId: string } | null }> } };
  expect(bundle.audit.keys).toHaveLength(1);
  expect(bundle.audit.keys[0]).toMatchObject({ keyId: bundle.audit.activeKeyId, algorithm: "ed25519" });
  expect(bundle.audit.scopes.map((scope) => scope.scope).sort()).toEqual(["control", `workspace:${workspaceId}`].sort());
  expect(bundle.audit.scopes.every((scope) => scope.headSeq > 0 && scope.lastCheckpoint?.keyId === bundle.audit.activeKeyId)).toBe(true);
  expect(text).not.toContain("Check the audit trail");
});
