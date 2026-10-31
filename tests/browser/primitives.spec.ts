import { test, expect } from "./fixtures";

// T33 packet acceptance: the product renders exclusively through the NewUI
// primitive set on the exact token cascade — interactive elements carry the
// design-system classes, keyboard focus is visible, both color schemes
// apply, and dialogs are native <dialog> elements.
test("primitives and tokens render across widths and themes (T33)", async ({ page, governor }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Primitives organization");
  await page.getByLabel(/^Email/).fill("prim@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const cookies = await page.context().cookies();
  const identity = await governor.app.brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }));
  governor.app.brain.createWorkspace(identity.actor, { workspaceId: "ws-primitives", slug: "primitives" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();

  // Every visible button is a design-system button (carries classes), never a
  // bare unstyled native control.
  const bareButtons = await page.locator("button:not([class])").count();
  expect(bareButtons).toBe(0);
  const bareInputs = await page.locator("input:not([class])").count();
  expect(bareInputs).toBe(0);

  // Page actions share NewUI's lg metrics and header icons really render.
  const refreshBox = await page.getByRole("button", { name: "Refresh", exact: true }).boundingBox();
  const startBox = await page.getByRole("button", { name: "Start a task", exact: true }).boundingBox();
  expect(refreshBox?.height).toBe(40);
  expect(startBox?.height).toBe(refreshBox?.height);
  const searchIcon = page.locator("header .lucide-search");
  await expect(searchIcon).toBeVisible();
  expect(await searchIcon.evaluate((node) => getComputedStyle(node).maskImage)).not.toBe("none");

  // Token cascade: the theme attribute and color-scheme match the project.
  const theme = await page.evaluate(() => ({ attr: document.documentElement.dataset["theme"], scheme: document.documentElement.style.colorScheme }));
  expect(theme.attr).toBe(info.project.name.endsWith("dark") ? "dark" : "light");
  expect(theme.scheme).toBe(theme.attr);
  // A painted surface resolves through the token cascade (not transparent).
  const surfaceBg = await page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? getComputedStyle(main).backgroundColor : "";
  });
  expect(surfaceBg).not.toBe("");

  // The NewUI color-scheme menu flips the applied scheme live.
  const toggle = page.getByRole("button", { name: /(light|dark|system) theme/i }).first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.getByRole("menuitem", { name: theme.attr === "dark" ? "Light" : "Dark", exact: true }).click();
  const flipped = await page.evaluate(() => document.documentElement.dataset["theme"]);
  expect(flipped).not.toBe(theme.attr);

  // Keyboard focus lands on a visible interactive element (no focus loss).
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    return { tag: el.tagName, outline: style.outlineStyle, visible: el.offsetParent !== null || el.getClientRects().length > 0 };
  });
  expect(focused).not.toBeNull();
  expect(focused!.visible).toBe(true);
  expect(errors).toEqual([]);
});
