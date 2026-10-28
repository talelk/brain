import { test, expect } from "./fixtures";

// E092: slow SSE log viewer with a long transcript. Required observation:
// bounded server/client memory (the mounted DOM stays windowed no matter how
// long the transcript is) and scroll selection preserved while new events
// stream in above the reader's position.
test("long SSE transcript: bounded DOM, scroll and selection survive new events (E092)", async ({ page, governor }) => {
  await page.goto(governor.url);
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Transcript organization");
  await page.getByLabel(/^Email/).fill("transcript@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  // Seed a running session with a 1200-event transcript through the real store.
  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-perf", slug: "perf" });
  const s = brain.store;
  const ws = s.workspaceDb("ws-perf", actor.organizationId);
  ws.prepare("INSERT INTO sessions(id, job_id, attempt_id, engine_id, adapter_digest, state, event_sequence, updated_at_ms) VALUES ('ses-perf','job-perf','att-perf','fixture',?,'running',0,?)")
    .run(`sha256:${"0".repeat(64)}`, Date.now());
  const insert = s.control.prepare(`INSERT INTO events(event_id, organization_id, workspace_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const base = Date.now() - 1200 * 1000;
  for (let i = 1; i <= 1200; i++) {
    insert.run(`evt-seed-${i}`, actor.organizationId, "ws-perf", "session", `evt-${i}`, i,
      i % 2 === 0 ? "tool.exec" : "session.message", JSON.stringify({ n: i }), `sha256:${"a".repeat(64)}`, base + i * 1000);
  }

  await page.goto(`${governor.url}/sessions/ses-perf`);
  const list = page.locator('[data-slot="virtual-list"]');
  await expect(list).toBeVisible();
  await expect(page.locator('[data-slot="virtual-list"] li').first()).toBeVisible({ timeout: 20000 });

  // Bounded client memory: the virtualiser mounts a viewport-sized window,
  // not the 1200-row transcript.
  const rowCount = await page.locator('[data-slot="virtual-list"] li').count();
  expect(rowCount, `mounted rows ${rowCount}`).toBeLessThan(150);
  const finalCursor = (s.control.prepare("SELECT MAX(cursor) AS cursor FROM events WHERE organization_id=?").get(actor.organizationId) as { cursor: number }).cursor;
  await expect(page.getByText(`${finalCursor} events`, { exact: false })).toBeVisible({ timeout: 20000 });

  // Scroll only after the full replay exists; otherwise the browser clamps the
  // requested position to the short list's current maximum.
  await page.evaluate(() => {
    const el = document.querySelector('[data-slot="virtual-list"]') as HTMLElement;
    el.scrollTop = 64 * 120;
  });
  await expect.poll(() => page.locator('[data-slot="virtual-list"]').evaluate((el) => el.scrollTop)).toBe(64 * 120);
  await expect(page.getByRole("button", { name: /^Jump to newest/ })).toBeVisible({ timeout: 5000 });
  const selection = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="virtual-list"]') as HTMLElement;
    const er = el.getBoundingClientRect();
    const ps = [...el.querySelectorAll("li p")] as HTMLElement[];
    const target = ps.find((p) => {
      const r = p.getBoundingClientRect();
      return r.top > er.top && r.bottom < er.bottom && p.firstChild?.nodeType === 3 && (p.firstChild as Text).data.length > 3;
    });
    if (!target) return "";
    const range = document.createRange();
    range.selectNodeContents(target.firstChild as Text);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return sel?.toString() ?? "";
  });
  expect(selection.length).toBeGreaterThan(0);
  const visibleBefore = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="virtual-list"]') as HTMLElement;
    const r = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("li")] as HTMLElement[];
    const hit = rows.find((li) => { const b = li.getBoundingClientRect(); return b.top >= r.top - 1 && b.top < r.bottom; });
    return hit?.textContent?.trim() ?? "";
  });
  expect(visibleBefore.length).toBeGreaterThan(0);

  // 40 fresh events stream in while the reader is scrolled away.
  for (let i = 1; i <= 40; i++) {
    insert.run(`evt-live-${i}`, actor.organizationId, "ws-perf", "session", `evt-live-${i}`, 1200 + i,
      "session.message", JSON.stringify({ n: 1200 + i }), `sha256:${"b".repeat(64)}`, Date.now());
  }
  await expect(page.getByRole("button", { name: /Jump to newest \(\d+\)/ })).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1200); // SSE tick + coalesce settle

  // The reader's view is pinned: same row at the same position, selection intact.
  const visibleAfter = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="virtual-list"]') as HTMLElement;
    const r = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("li")] as HTMLElement[];
    const hit = rows.find((li) => { const b = li.getBoundingClientRect(); return b.top >= r.top - 1 && b.top < r.bottom; });
    return hit?.textContent?.trim() ?? "";
  });
  expect(visibleAfter).toBe(visibleBefore);
  const selectionAfter = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selectionAfter).toBe(selection);

  // Still bounded after the burst.
  const rowCountAfter = await page.locator('[data-slot="virtual-list"] li').count();
  expect(rowCountAfter, `mounted rows after ${rowCountAfter}`).toBeLessThan(150);

  // Jump to newest returns to the current end of the transcript.
  await page.getByRole("button", { name: /Jump to newest/ }).click();
  const atTop = await page.evaluate(() => (document.querySelector('[data-slot="virtual-list"]') as HTMLElement).scrollTop);
  expect(atTop).toBeLessThanOrEqual(1);
});
