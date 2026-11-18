import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { join } from "node:path";
import { en } from "../../apps/web/src/i18n/en";
import { fr } from "../../apps/web/src/i18n/fr";
import { ar } from "../../apps/web/src/i18n/ar";
import { joinPerson } from "./people";
import { EMAIL, expect, onPhone, PASSWORD, signIn, starter, test, type Api, type Stack } from "./stack";

/**
 * Every screen in every language, theme and width: nothing runs off the page, no text fails contrast, and French and Arabic show no English
 * that the UI owns. `MATRIX_SHOTS=<dir>` also saves a 1:1 screenshot of each cell, to look at.
 */
const editor = 'description = "Polishes what the others wrote."\nengine = ["pi"]\nnative = "none"\ntools = []\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const operator = 'description = "Restarts containers."\nengine = ["pi"]\nnative = "none"\ntools = ["deploy.restart"]\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const step = (id: string, agent: string, after: string[], review = false): string =>
  `[[step]]\nid = "${id}"\nagent = "${agent}"\nafter = ${JSON.stringify(after)}\n${review ? 'review_by = "checker"\n' : ""}goal = """Do ${id}.\nFIXTURE @work reply Done ${id}."""\n`;
const chain = (title: string, ids: string[]): string => `title = "${title}"\ndescription = "A long relay."\n${ids.map((id, at) => step(id, at % 2 ? "editor" : "worker", at === 0 ? [] : [ids[at - 1] ?? ""], at % 2 === 1)).join("")}`;
const scheduled = 'title = "Weekly report"\n[trigger]\nschedule = "0 8 * * 1"\n[[step]]\nid = "write"\nagent = "worker"\ngoal = "Write the report."\n';
const restartPlay = 'title = "Restart a container"\ndescription = "Restarts one container."\n[[step]]\nid = "restart"\nagent = "operator"\ngoal = """Restart it.\nFIXTURE @work tool deploy.restart {"container": "web-1"}"""\n';

interface Seeded { readonly slug: string; readonly wide: string }
async function seed(stack: Stack, api: Api): Promise<Seeded> {
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({
    "agents/editor/agent.toml": editor, "agents/editor/prompt.md": "You are the editor.\n", "agents/operator/agent.toml": operator, "agents/operator/prompt.md": "You are the operator.\n",
    "tools/deploy.restart/tool.toml": restart, "tools/deploy.restart/run.sh": "#!/bin/sh\ncat\n", "memory/style.md": "# House style\n\nShort sentences.\n",
    "plays/wide.toml": chain("Wide relay", ["research", "draft", "review", "revise", "publish", "announce"]), "plays/restart.toml": restartPlay, "plays/report.toml": scheduled,
  });
  const run = async (play: string): Promise<string> => (await api.command("task.create", { workspaceId: workspace.id, play, inputs: {} })).taskId;
  await run("hello");
  const wide = await run("wide");
  await expect.poll(async () => (await api.query("task.get", { workspaceId: workspace.id, taskId: wide })).state, { timeout: 60_000 }).toBe("done");
  await run("restart");
  // People to look at on the Users screen: two members (one in a group), one deactivated, one invitation not yet used.
  const lena = await joinPerson(stack, api, "lena@example.com", "Lena Moreau", { workspaces: [{ workspaceId: workspace.id, role: "member" }] });
  const omar = await joinPerson(stack, api, "omar@example.com", "Omar Reyes");
  await api.command("group.set", { name: "Support", memberIds: [lena], grants: [{ workspaceId: workspace.id, role: "admin" }] });
  await api.command("user.invite", { email: "pending@example.com", workspaces: [{ workspaceId: workspace.id, role: "viewer" }] });
  await api.command("user.set", { userId: omar, active: false });
  const me = await api.query("me", {});
  return { slug: me.workspaces[0]?.slug ?? "starter", wide };
}

/** The English messages a language has not translated (missing, or the same words as English), and the design system's English-only phrases. */
const untranslated = (catalog: Readonly<Record<string, string>>): string[] =>
  Object.entries(en).filter(([key, text]) => !text.includes("{") && text.split(/\s+/u).length > 2 && (catalog[key] === undefined || catalog[key] === text)).map(([, text]) => text);
/** The English a shipped pack wrote for people (descriptions, titles, memory lines), which a French or Arabic page must show translated. */
const PACKS = join(import.meta.dirname, "../../packs");
const packEnglish = (): { titles: string[]; texts: string[] } => {
  const out = new Set<string>();
  const titles = new Set<string>();
  for (const entry of readdirSync(PACKS, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (entry.name.endsWith(".toml")) {
      const file = parseToml(readFileSync(path, "utf8")) as { title?: string; description?: string; inputs?: Record<string, { description?: string }> };
      for (const text of [file.description, ...Object.values(file.inputs ?? {}).map((input) => input.description)]) if (text) out.add(text.trim());
      if (file.title) titles.add(file.title.trim());
    } else if (/\.md$/u.test(entry.name) && path.includes("/memory/") && !/\.(fr|ar)\.md$/u.test(entry.name)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const plain = line.replace(/^\s*(?:[-*]|\d+\.|#+)\s+/u, "").trim();
        if (plain.split(/\s+/u).length > 3 && !/[`*<>_]/u.test(plain)) out.add(plain);
      }
    }
  }
  return { titles: [...titles], texts: [...out] };
};
const LIBRARY = ["Skip to workspace", "values from", "No values."];
/** Visible text and aria-labels that are one of `phrases`, or hold one of the library's. */
const strayEnglish = (page: Page, phrases: string[]): Promise<string[]> =>
  page.evaluate(([list, library]) => {
    const exact = new Set(list);
    const found = new Set<string>();
    const check = (text: string | null, at: Element | null): void => {
      if (!at || at.getClientRects().length === 0) return;
      const clean = (text ?? "").trim();
      if (clean && (exact.has(clean) || library.some((phrase) => clean.includes(phrase)))) found.add(clean.slice(0, 80));
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) check(node.textContent, node.parentElement);
    for (const element of Array.from(document.querySelectorAll("[aria-label],[title]"))) { check(element.getAttribute("aria-label"), element); check(element.getAttribute("title"), element); }
    return [...found];
  }, [phrases, LIBRARY] as const);

const axe = async (page: Page): Promise<string[]> =>
  (await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()).violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(" ")} ${node.any[0]?.message ?? ""}`.slice(0, 200)));

const LANGS = ["en", "fr", "ar"] as const;
const SIZES = [{ name: "wide", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }] as const;

test("every screen reads right in every language, theme and width", async ({ page, stack }) => {
  const shots = process.env["MATRIX_SHOTS"];
  test.setTimeout(shots ? 900_000 : 600_000);
  const api = await stack.setUp();
  const { slug, wide } = await seed(stack, api);
  if (shots) mkdirSync(shots, { recursive: true });
  const w = `/w/${slug}`;
  const screens: [string, string][] = [
    ["overview", "/"], ["schedules", "/schedules"], ["today", w], ["tasks", `${w}/tasks`], ["task", `${w}/tasks/${wide}`],
    ["agents", `${w}/workspace/agents`], ["team", `${w}/workspace/team`], ["tools", `${w}/workspace/tools`], ["plays", `${w}/workspace/plays`], ["memory", `${w}/workspace/memory`],
    ["projects", `${w}/workspace/projects`], ["settings", `${w}/workspace/settings`], ["files", `${w}/workspace/files`], ["wschedules", `${w}/schedules`], ["queue", `${w}/queue`], ["live", `${w}/live`], ["liveall", "/live"], ["insights", `${w}/insights`],
    ["new", "/new"], ["people", `${w}/people`], ["health", `${w}/health`], ["users", "/users"], ["profile", "/profile"],
  ];
  // Without MATRIX_SHOTS (a normal run) a few screens that between them carry every kind of component; with it, every screen.
  const kinds = new Set(["overview", "today", "task", "team", "files", "new", "health", "agents", "tools", "plays", "memory", "schedules", "queue", "live", "insights", "users", "profile"]);
  const only = process.env["MATRIX_ONLY"]?.split(",");
  const problems: string[] = [];
  const authored = packEnglish();
  /** A task's title is a record of the goal as it was started, so the screens that list tasks may show a Play's title in the language it was started in. */
  const recordsTitles = new Set(["overview", "today", "tasks", "task", "graph", "insights"]);
  for (const lang of LANGS) for (const scheme of ["light", "dark"] as const) for (const size of SIZES) {
    if (only && !only.includes(`${lang}-${scheme}-${size.name}`)) continue;
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(([theme]) => { try { localStorage.setItem("brain.theme", theme ?? "light"); } catch { /* none */ } }, [scheme]);
    const cell = `${lang}-${scheme}-${size.name}`;
    await page.context().clearCookies();
    await page.goto(`${stack.url}/?lang=${lang}`);
    await page.locator('input[type="email"], input[autocomplete="username"]').first().waitFor();
    const look = async (name: string): Promise<void> => {
      if (process.env["MATRIX_LOG"]) console.log(cell, name, page.url());
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) problems.push(`${cell} ${name}: overflows by ${overflow}px`);
      for (const line of await axe(page)) problems.push(`${cell} ${name}: ${line}`);
      if (lang !== "en") for (const text of await strayEnglish(page, [...untranslated(lang === "fr" ? fr : ar), ...authored.texts, ...(recordsTitles.has(name) ? [] : authored.titles)])) problems.push(`${cell} ${name}: English "${text}"`);
      if (shots) await page.screenshot({ path: join(shots, `${cell}-${name}.png`), fullPage: false });
    };
    await look("signin");
    await page.locator('input[type="email"], input[autocomplete="username"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.locator('a[href^="/w/"]').first().waitFor({ state: "attached" });
    for (const [name, path] of screens) {
      if (!shots && !kinds.has(name)) continue;
      await page.goto(`${stack.url}${path}`);
      await look(name);
      if (name === "task") {
        // On a phone the goal opens on its record; its graph is behind a button.
        const open = page.getByRole("button", { name: { en, fr, ar }[lang]["graph.label"], exact: true });
        if (onPhone(page)) { await open.click(); await look("graph"); }
      }
      if (name === "users") {
        const words = { en, fr, ar }[lang];
        await page.getByRole("button", { name: /Lena Moreau/u }).first().click();
        await look("userdrawer");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: words["users.invite"], exact: true }).click();
        await look("invite");
        await page.keyboard.press("Escape");
        await page.getByRole("tab", { name: new RegExp(words["users.tab.groups"], "u") }).click();
        await look("groups");
        await page.getByRole("button", { name: words["groups.edit.action"], exact: true }).first().click();
        await look("group");
        await page.keyboard.press("Escape");
      }
      if (name === "new") {
        await page.getByRole("textbox").first().fill("Customer care");
        for (const name of ["new2", "new3"]) {
          await page.locator("button:has(.lucide-chevron-right)").first().click();
          await look(name);
        }
      }
    }
  }
  if (shots) writeFileSync(join(shots, "problems.txt"), problems.join("\n"));
  expect(problems).toEqual([]);
  void signIn;
});
