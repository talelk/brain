import { test, expect } from "./fixtures";

test("offline PWA: cached shell loads, API actions fail visibly, no offline approval (E096)", async ({ page, governor, context }) => {
  await page.goto(governor.url);
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return Boolean(navigator.serviceWorker.controller);
  });
  expect(controlled).toBe(true);
  // Warm the shell cache, then go fully offline.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  // Cached shell renders, but setup state cannot be fetched: the visible
  // fallback is the sign-in shell with a fetch failure alert, not stale setup.
  await expect(page.getByRole("heading", { name: "Sign in to Keyrus Brain" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Failed to fetch");
  // The API is never served from cache: setup/approval actions cannot proceed offline.
  const apiOutcome = await page.evaluate(async () => {
    try {
      const res = await fetch("/v1/setup/status", { signal: AbortSignal.timeout(3000) });
      return `responded:${res.status}`;
    } catch {
      return "failed";
    }
  });
  expect(apiOutcome).toBe("failed");
  const mutationOutcome = await page.evaluate(async () => {
    try {
      await fetch("/v1/approvals/none/decision", { method: "POST", body: "{}", signal: AbortSignal.timeout(3000) });
      return "responded";
    } catch {
      return "failed";
    }
  });
  expect(mutationOutcome).toBe("failed");
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
});
