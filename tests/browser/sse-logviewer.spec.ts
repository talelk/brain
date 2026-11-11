import { test, expect } from "./fixtures";

// E092 retargeted to the Log Explorer (/w/:id/logs) over the Unified Execution
// Stream. Required observations: bounded server/client memory (the mounted DOM
// stays windowed no matter how long the transcript is), scroll and selection
// preserved while new records stream in, pause/resume with an unread counter,
// full-text search across the retained logs (not only the mounted window), and
// reconnect-from-cursor after the server's hard close. Seeding goes through the
// source logs (workspace.events + a session row); projection-on-read must make
// them visible without a maintenance tick.
test("Log Explorer: bounded DOM, scroll and selection survive streaming, pause/unread, search, reconnect (E092)", async ({ page, governor }) => {
  test.setTimeout(300_000);
  await page.goto(governor.url);
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Transcript organization");
  await page.getByLabel(/^Email/).fill("transcript@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();

  // First run provisions no workspace: create one through the UI when the
  // shell offers it. The shell gates every page behind a selected workspace,
  // so the explorer needs this before any deep link can render.
  const createWorkspace = page.getByRole("button", { name: "Create workspace", exact: true });
  await createWorkspace.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (await createWorkspace.isVisible().catch(() => false)) {
    await page.getByLabel("Display name").fill("Perf");
    await createWorkspace.click();
  }
  await expect(page.getByRole("heading", { name: "Missions", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });

  // Seed through the source logs: one running session plus a 10000-record
  // workspace transcript. The stream projector tails these on every read.
  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  const s = brain.store;
  const workspaceId = (s.control.prepare("SELECT id FROM workspaces WHERE organization_id=? ORDER BY id LIMIT 1").get(actor.organizationId) as { id: string }).id;
  const ws = s.workspaceDb(workspaceId, actor.organizationId);
  ws.prepare("INSERT INTO sessions(id, job_id, attempt_id, engine_id, adapter_digest, engine_features, state, event_sequence, updated_at_ms) VALUES ('ses-perf','job-perf','att-perf','fixture',?, '[\"sessions\"]','running',0,?)")
    .run(`sha256:${"0".repeat(64)}`, Date.now());
  const insert = ws.prepare(`INSERT INTO events(event_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?)`);
  const base = Date.now() - 10000 * 1000;
  const digest = `sha256:${"a".repeat(64)}`;
  for (let i = 1; i <= 10000; i++) {
    const even = i % 2 === 0;
    const payload = even
      ? { channel: "assistant", provisional: true, text: `Transcript line ${i}\n` }
      : { proposalId: `prop-${i}`, invocationId: `inv-${i}`, receipt: { invocationId: `inv-${i}`, result: "succeeded" } };
    // i === 9900 fails inside the visible newest-200 window so the error jump
    // has a target; i in 9910..9919 repeats one identical line (collapse group).
    // The collapse group shares one event type — the projector classifies
    // type+emitter per event type, so mixed types would never collapse.
    const failing = i === 9900;
    const repeated = i >= 9910 && i <= 9919;
    const type = repeated || even ? "text" : "tool.result";
    const body = failing
      ? { proposalId: `prop-${i}`, invocationId: `inv-${i}`, receipt: { invocationId: `inv-${i}`, result: "failed", exitCode: 1 } }
      : repeated
        ? { channel: "diagnostic", text: "heartbeat tick" }
        : payload;
    insert.run(`evt-seed-${i}`, "session", "ses-perf", i, type, JSON.stringify(body), digest, base + i * 1000);
  }

  await page.goto(`${governor.url}/w/${workspaceId}/logs`);
  const list = page.locator('[data-testid="log-list"] ul');
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="log-list"] li').first()).toBeVisible({ timeout: 30_000 });

  // Projection-on-read: the whole seeded transcript surfaced. The global head
  // counts every projected record — the seeded 10000 plus the organization
  // bootstrap record the unified stream carries alongside session events.
  await expect(page.getByText(/head 10\d{3}/)).toBeVisible({ timeout: 60_000 });

  // Bounded client memory: the virtualiser mounts a viewport-sized window,
  // not the 10000-record transcript.
  const rowCount = await page.locator('[data-testid="log-list"] li').count();
  expect(rowCount, `mounted rows ${rowCount}`).toBeLessThan(150);

  // Grouping: the consecutive identical diagnostics collapse into one row.
  // The list virtualizes, so bring the repeat group (seed records 9910-9919,
  // roughly one third into the newest-200 seed window) into the mounted window.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="log-list"] ul') as HTMLElement;
    el.scrollTop = 100 * 32;
  });
  await expect(page.locator('[data-testid="log-list"] li [data-row-kind="repeat"]').first()).toBeVisible({ timeout: 15_000 });
  // Readable mode: each event is one plain sentence, never a JSON line.
  const sentences = await page.locator('[data-testid="log-sentence"]').allTextContents();
  expect(sentences.length).toBeGreaterThan(0);
  for (const sentence of sentences) expect(sentence.trimStart().startsWith("{")).toBe(false);

  // Scroll away from the newest end; the requested offset must survive.
  const ROW = 32;
  await page.evaluate((offset) => {
    const el = document.querySelector('[data-testid="log-list"] ul') as HTMLElement;
    el.scrollTop = offset;
  }, 64 * ROW);
  await expect.poll(() => page.locator('[data-testid="log-list"] ul').evaluate((el) => el.scrollTop)).toBe(64 * ROW);

  // Text selection inside a row, and the row pinned at the viewport top.
  const selection = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="log-list"] ul') as HTMLElement;
    const er = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("li")] as HTMLElement[];
    const target = rows.find((li) => {
      const r = li.getBoundingClientRect();
      return r.top > er.top && r.bottom < er.bottom;
    });
    if (!target) return "";
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return sel?.toString() ?? "";
  });
  expect(selection.length).toBeGreaterThan(0);
  const visibleBefore = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="log-list"] ul') as HTMLElement;
    const r = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("li")] as HTMLElement[];
    const hit = rows.find((li) => { const b = li.getBoundingClientRect(); return b.top >= r.top - 1 && b.top < r.bottom; });
    return hit?.textContent?.trim() ?? "";
  });
  expect(visibleBefore.length).toBeGreaterThan(0);

  // 40 fresh records stream in while the reader is scrolled away.
  const inject = (from: number, to: number): void => {
    for (let i = from; i <= to; i++) {
      insert.run(`evt-live-${i}`, "session", "ses-perf", i, "text",
        JSON.stringify({ channel: "assistant", provisional: true, text: `Live line ${i}\n` }), digest, Date.now());
    }
  };
  inject(10001, 10040);
  await expect(page.getByRole("button", { name: /Jump to newest \(\d+\)/ })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(10_000); // SSE ticks + coalesce settle

  // The reader's view is pinned: same row at the same position, selection intact.
  const visibleAfter = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="log-list"] ul') as HTMLElement;
    const r = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("li")] as HTMLElement[];
    const hit = rows.find((li) => { const b = li.getBoundingClientRect(); return b.top >= r.top - 1 && b.top < r.bottom; });
    return hit?.textContent?.trim() ?? "";
  });
  expect(visibleAfter).toBe(visibleBefore);
  const selectionAfter = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selectionAfter).toBe(selection);

  // Still bounded after the burst.
  const rowCountAfter = await page.locator('[data-testid="log-list"] li').count();
  expect(rowCountAfter, `mounted rows after ${rowCountAfter}`).toBeLessThan(150);

  // Pause: arrivals are counted, not shown; resume flushes the unread counter.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  inject(10041, 10080);
  await expect(page.getByRole("button", { name: /Resume \(40 new\)/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Resume \(40 new\)/ }).click();
  await page.getByRole("button", { name: /Jump to newest/ }).click();
  await expect(page.getByText("Live line 10080", { exact: false })).toBeVisible({ timeout: 15_000 });
  // The flush is proven above (newest record visible, jump control gone); the
  // windowed list stays bounded after the resumed burst.
  const resumedRows = await page.locator('[data-testid="log-list"] li').count();
  expect(resumedRows, `mounted rows after resume ${resumedRows}`).toBeLessThan(150);
  await expect(page.getByRole("button", { name: /Jump to newest/ })).toBeHidden();

  // Long-stream regression: one SSE connection serves far more than the
  // client's 500-frame window over its lifetime. The tail must keep consuming
  // across window trims — with an absolute consumption index it silently
  // stalls at the 500th frame and the reconnect assertion at the end of this
  // test would never see its record.
  inject(10101, 10620);
  await expect(page.getByText("Live line 10620", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  // Full-text search reaches the whole retained transcript, not only the
  // mounted window: record 7778 sits far outside the newest-200 seed.
  await page.getByLabel("Search retained logs (full text)").fill("Transcript line 7778");
  await expect(page.getByText("Transcript line 7778", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Search retained logs (full text)").fill("");

  // Reconnect-from-cursor: the server hard-closes the stream after 55s; the
  // client must reconnect from the last seen stream_seq and keep delivering.
  await page.waitForTimeout(57_000);
  inject(10081, 10100);
  await expect(page.getByText("Live line 10100", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
});
