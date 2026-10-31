# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: board.spec.ts >> board: desktop drag and compact controls move a card across columns (T37)
- Location: tests/browser/board.spec.ts:104:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "in-progress"
Received: "verifying"

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - generic [ref=f1e4]:
    - banner [ref=f1e5]:
      - generic [ref=f1e6]:
        - button "Open application navigation" [ref=f1e7]
        - generic [ref=f1e9]: Board
      - generic [ref=f1e10]:
        - button "Search Brain (Control K)" [ref=f1e11] [cursor=pointer]:
          - generic [ref=f1e12]: Search
        - button "Account" [ref=f1e14] [cursor=pointer]
        - button "Switch to light theme" [ref=f1e17] [cursor=pointer]
    - main [ref=f1e19]:
      - link "Skip to workspace" [ref=f1e20] [cursor=pointer]:
        - /url: "#app-shell-content"
      - generic [ref=f1e21]:
        - heading "Board" [level=1] [ref=f1e25]
        - generic [ref=f1e27]:
          - generic [ref=f1e28]:
            - generic [ref=f1e29]:
              - heading "Board" [level=2] [ref=f1e30]
              - paragraph [ref=f1e31]: Done is only accepted when verified evidence covers every criterion.
            - button "New card" [ref=f1e33] [cursor=pointer]
          - list "Workspace board" [ref=f1e38]:
            - listitem [ref=f1e39]:
              - generic [ref=f1e41]:
                - heading "To decide" [level=2] [ref=f1e43]
                - generic [ref=f1e44]: "0"
              - list [ref=f1e46]:
                - listitem [ref=f1e47]: Nothing in this column.
            - listitem [ref=f1e48]:
              - generic [ref=f1e50]:
                - heading "Todo" [level=2] [ref=f1e52]
                - generic [ref=f1e53]: "0"
              - list [ref=f1e55]:
                - listitem [ref=f1e56]: Nothing in this column.
            - listitem [ref=f1e57]:
              - generic [ref=f1e59]:
                - heading "In progress" [level=2] [ref=f1e61]
                - generic [ref=f1e62]: "0"
              - list [ref=f1e64]:
                - listitem [ref=f1e65]: Nothing in this column.
            - listitem [ref=f1e66]:
              - generic [ref=f1e68]:
                - heading "Verifying" [level=2] [ref=f1e70]
                - generic [ref=f1e71]: "1"
              - list [ref=f1e73]:
                - listitem [ref=f1e74]:
                  - generic [ref=f1e76]:
                    - generic [ref=f1e78]:
                      - paragraph [ref=f1e79]: Drag the fixture
                      - generic [ref=f1e80]: "echo: pending"
                      - group [ref=f1e83]:
                        - generic "Manage Drag the fixture" [ref=f1e84] [cursor=pointer]
                    - button "Actions for card-drag-1" [ref=f1e86] [cursor=pointer]
            - listitem [ref=f1e88]:
              - generic [ref=f1e90]:
                - heading "Done" [level=2] [ref=f1e92]
                - generic [ref=f1e93]: "0"
              - list [ref=f1e95]:
                - listitem [ref=f1e96]: Nothing in this column.
            - listitem [ref=f1e97]:
              - generic [ref=f1e99]:
                - heading "Blocked" [level=2] [ref=f1e101]
                - generic [ref=f1e102]: "0"
              - list [ref=f1e104]:
                - listitem [ref=f1e105]: Nothing in this column.
  - generic:
    - region "Notifications, bottom-end (alt+T)"
```

# Test source

```ts
  32  |
  33  | test("board: cards render by state, move applies, Done without evidence is refused in UI (T37)", async ({ page, governor }) => {
  34  |   const errors: string[] = [];
  35  |   page.on("pageerror", (error) => errors.push(error.message));
  36  |   await page.goto(governor.url);
  37  |   await page.getByLabel(/^Setup credential/).fill(governor.credential);
  38  |   await page.getByLabel(/^Organization name/).fill("Board organization");
  39  |   await page.getByLabel(/^Email/).fill("board@example.test");
  40  |   await page.getByLabel(/^Password/).fill("browser-password-1234");
  41  |   await page.getByRole("button", { name: "Create organization", exact: true }).click();
  42  |   await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  43  |
  44  |   const cookies = await page.context().cookies();
  45  |   const brain = governor.app.brain;
  46  |   const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  47  |   const actor = resolved.actor;
  48  |   brain.createWorkspace(actor, { workspaceId: "ws-board", slug: "board" });
  49  |   const ws = brain.store.workspaceDb("ws-board", actor.organizationId);
  50  |   ws.prepare("INSERT INTO cards(id, title, state, criteria_json, version, created_at_ms) VALUES ('card-ui-1', 'Ship the fixture', 'todo', '[\"echo\"]', 1, ?)").run(Date.now());
  51  |
  52  |   await page.reload();
  53  |   await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  54  |   const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  55  |   if (await navToggle.isVisible()) await navToggle.click();
  56  |   await page.getByRole("button", { name: "Board", exact: true }).click();
  57  |   await expect(page.getByRole("heading", { name: "Board", exact: true, level: 1 })).toBeVisible();
  58  |   await expect(page.getByText("Ship the fixture", { exact: true })).toBeVisible();
  59  |   expect(new URL(page.url()).pathname).toBe("/w/ws-board/board");
  60  |
  61  |   await page.getByText("Manage Ship the fixture",{exact:true}).click();
  62  |   await page.getByLabel("Move Ship the fixture", { exact: true }).click();
  63  |   await page.getByRole("option", { name: "In progress", exact: true }).click();
  64  |   await page.getByRole("button", { name: "Move Ship the fixture to selected column", exact: true }).click();
  65  |   await expect.poll(() => (ws.prepare("SELECT state FROM cards WHERE id='card-ui-1'").get() as { state: string }).state).toBe("in-progress");
  66  |
  67  |   await page.getByLabel("Move Ship the fixture", { exact: true }).click();
  68  |   await page.getByRole("option", { name: "Done", exact: true }).click();
  69  |   await page.getByRole("button", { name: "Move Ship the fixture to selected column", exact: true }).click();
  70  |   await expect(page.getByRole("alert")).toContainText(/evidence/i);
  71  |   expect((ws.prepare("SELECT state FROM cards WHERE id='card-ui-1'").get() as { state: string }).state).toBe("in-progress");
  72  |   expect(errors).toEqual([]);
  73  | });
  74  |
  75  | test("board: Done succeeds with explicitly bound verified evidence (T37)", async ({ page, governor }) => {
  76  |   test.setTimeout(120_000);
  77  |   const errors: string[] = [];
  78  |   page.on("pageerror", (error) => errors.push(error.message));
  79  |   const { brain, actor, ws } = await boardWorld(page, governor);
  80  |   ws.prepare("INSERT INTO cards(id, title, state, criteria_json, version, created_at_ms) VALUES ('card-ui-2', 'Verify the fixture', 'verifying', '[\"echo\"]', 1, ?)").run(Date.now());
  81  |   const manifest = {
  82  |     contractVersion: "brain.evidence/v1", bundleId: "bundle-ui", organizationId: actor.organizationId, workspaceId: "ws-board",
  83  |     workflowRunId: "run-ui", jobId: "job-ui", attemptId: "att-ui", jobFence: 1,
  84  |     sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [],
  85  |     artifacts: [], checks: [{ criterionId: "echo", checkId: "c1", status: "passed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" }],
  86  |     approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  87  |   };
  88  |   ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?, 'bundle-ui', 'job-ui', 'att-ui', 'verified', ?, ?)").run(DIGEST_A, JSON.stringify(manifest), brain.store.now());
  89  |   ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES ('verdict-ui', ?, 'eval-ui', ?, 'verified', '{}', ?)").run(DIGEST_A, DIGEST_A, brain.store.now());
  90  |
  91  |   await openBoard(page);
  92  |   await expect(page.getByText("Verify the fixture", { exact: true })).toBeVisible();
  93  |   await page.getByText("Manage Verify the fixture",{exact:true}).click();
  94  |   await page.getByLabel("Verified evidence for Verify the fixture", { exact: true }).click();
  95  |   await page.getByRole("option", { name: /1 passed criteria/ }).click();
  96  |   await page.getByLabel("Move Verify the fixture", { exact: true }).click();
  97  |   await page.getByRole("option", { name: "Done", exact: true }).click();
  98  |   await page.getByRole("button", { name: "Move Verify the fixture to selected column", exact: true }).click();
  99  |   await expect.poll(() => (ws.prepare("SELECT state FROM cards WHERE id='card-ui-2'").get() as { state: string }).state).toBe("done");
  100 |   await expect(page.getByText(/evidence attached/)).toBeVisible();
  101 |   expect(errors).toEqual([]);
  102 | });
  103 |
  104 | test("board: desktop drag and compact controls move a card across columns (T37)", async ({ page, governor }, info) => {
  105 |   test.setTimeout(120_000);
  106 |   const errors: string[] = [];
  107 |   page.on("pageerror", (error) => errors.push(error.message));
  108 |   const { ws } = await boardWorld(page, governor);
  109 |   ws.prepare("INSERT INTO cards(id, title, state, criteria_json, version, created_at_ms) VALUES ('card-drag-1', 'Drag the fixture', 'todo', '[\"echo\"]', 1, ?)").run(Date.now());
  110 |   await openBoard(page);
  111 |   if (info.project.name.startsWith("390")) {
  112 |     await page.getByText("Manage Drag the fixture", { exact: true }).click();
  113 |     await page.getByLabel("Move Drag the fixture", { exact: true }).click();
  114 |     await page.getByRole("option", { name: "In progress", exact: true }).click();
  115 |     await page.getByRole("button", { name: "Move Drag the fixture to selected column", exact: true }).click();
  116 |     await expect.poll(() => (ws.prepare("SELECT state FROM cards WHERE id='card-drag-1'").get() as { state: string }).state).toBe("in-progress");
  117 |     expect(errors).toEqual([]);
  118 |     return;
  119 |   }
  120 |   const card = page.locator("[data-kanban-id='card-drag-1']");
  121 |   await expect(card).toBeVisible();
  122 |   const from = await card.boundingBox();
  123 |   expect(from, "card has a box").toBeTruthy();
  124 |   // Drop over the In progress column header area.
  125 |   const target = page.getByText("In progress", { exact: true }).first();
  126 |   const to = await target.boundingBox();
  127 |   expect(to, "target column has a box").toBeTruthy();
  128 |   await page.mouse.move(from!.x + from!.width / 2, from!.y + 12);
  129 |   await page.mouse.down();
  130 |   await page.mouse.move(to!.x + to!.width / 2, to!.y + 60, { steps: 24 });
  131 |   await page.mouse.up();
> 132 |   await expect.poll(() => (ws.prepare("SELECT state FROM cards WHERE id='card-drag-1'").get() as { state: string }).state, { timeout: 15_000 }).toBe("in-progress");
      |                                                                                                                                                 ^ Error: expect(received).toBe(expected) // Object.is equality
  133 |   expect(errors).toEqual([]);
  134 |   void info;
  135 | });
  136 |
```