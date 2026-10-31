import { test, expect } from "./fixtures";

test("AppShell navigation: list to detail to decision dialog and Back with focus restoration (E093)", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Navigation organization");
  await page.getByLabel(/^Email/).fill("nav@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  // Seed a workspace + pending approval through the real Governor surface.
  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-nav", slug: "nav" });
  const s = brain.store;
  const subject = {
    organizationId: actor.organizationId, workspaceId: "ws-nav", operation: "fixture.publish",
    target: { targetId: "t-nav", environmentId: "prod" },
  };
  s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
    VALUES ('apr-nav-1', ?, 'ws-nav', ?, ?, ?, 'pending', ?, ?)`)
    .run(actor.organizationId, actor.actorId, `sha256:${"c".repeat(64)}`, JSON.stringify(subject), Date.now() + 3600000, Date.now());

  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await expect(page.getByText("Keyrus Brain", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approvals", exact: true, level: 1 })).toBeVisible();
  const approvalList = page.getByRole("region", { name: "Approvals", exact: true });
  await expect(approvalList.getByText("apr-nav-1", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await approvalList.getByRole("button", { name: "Review: apr-nav-1", exact: true }).click();

  const reviewButton = page.getByRole("button", { name: "Review action", exact: true });
  await reviewButton.click({ timeout: 5000 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/fixture\.publish/).first()).toBeVisible();
  // The dialog must be pointer-operable: the Back button is the top element
  // at its own center point (no overlay or page root intercepting clicks).
  const hit = await page.getByRole("button", { name: "Back", exact: true }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const chain: string[] = [];
    let node: Element | null = el;
    while (node && chain.length < 8) {
      const cs = getComputedStyle(node);
      chain.push(`${node.tagName}[pe=${cs.pointerEvents},vis=${cs.visibility},op=${cs.opacity},disp=${cs.display},inert=${String((node as HTMLElement).inert ?? "?")},style=${(node as HTMLElement).getAttribute("style") ?? ""}]`);
      node = node.parentElement;
    }
    return { inside: top ? el.contains(top) || top === el : false, top: top ? `${top.tagName}.${top.className}`.slice(0, 120) : "none", rect: `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`, chain: chain.join(" < ") };
  });
  expect(hit.inside, `top=${hit.top} rect=${hit.rect} chain=${hit.chain}`).toBe(true);
  // Keyboard activation also proves the dialog remains operable without a pointer.
  await page.getByRole("button", { name: "Back", exact: true }).focus({ timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(reviewButton).toBeFocused();

  // One navigation model across areas: Runs list renders its bounded window.
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("No runs match", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});
