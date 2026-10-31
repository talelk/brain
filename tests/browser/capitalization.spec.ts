import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";
import { captureOperation } from "../support/capitalization";

test("knowledge studio: capitalize verified operations with governed L3 promotion (T57, E110)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Capitalization organization");
  await page.getByLabel(/^Email/).fill("capitalization@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();

  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-capitalization", slug: "capitalization" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);
  const fixture = { brain, org: actor.organizationId, workspaceId: "ws-capitalization" };
  for (const root of ["browser-cap-1", "browser-cap-2", "browser-cap-3"]) captureOperation(fixture, root);

  await page.goto(`${governor.url}/w/ws-capitalization/knowledge`);
  await expect(page.getByText("Knowledge Studio", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run capitalization", exact: true }).click();
  expect(brain.runCapitalization()).toEqual({ processed: 4, failed: 0 });
  const asset = page.getByTestId("knowledge-asset-fixture.echo");
  const candidate = page.getByTestId("capability-candidate-fixture.echo");
  await expect(asset).toContainText("3 distinct runs");
  await expect(asset).toContainText("extracted");
  await expect(candidate).toContainText("quarantined");
  await expect(candidate).toContainText("tests passed");
  await expect(candidate).toContainText("3 test fixtures");

  await page.getByRole("button", { name: "Approve fixture.echo", exact: true }).click();
  const publish = page.getByRole("button", { name: "Publish exact release fixture.echo", exact: true });
  await expect(publish).toBeVisible();
  await publish.click();
  await expect(candidate).toContainText("published");
  expect((brain.store.control.prepare("SELECT COUNT(*) AS count FROM memory_assets").get() as { count: number }).count).toBe(0);
  expect(errors).toEqual([]);
});
