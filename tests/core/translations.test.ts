import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Harness } from "./harness";
import { makeWorkspace, pass } from "./work";

/** Translations (docs/model.md): people read the text a file carries in their language; agents, offers and search see the English. */
let harness: Harness;
let driver: Driver;
const play = 'title = "Learn"\ndescription = "Study the workspace."\n[[step]]\nid = "learn"\nagent = "scholar"\ngoal = "Learn."\n';
const translatedPlay = `${play}\n[translations.fr]\ntitle = "Apprendre"\ndescription = "Étudier l'espace de travail."\n`;
const agent = (extra: string): string => `description = "The scholar."\nengine = ["fixture"]\ntools = ["memory.search"]\n[limits]\nspend_usd = 0\n${extra}`;

beforeAll(async () => {
  harness = await createHarness();
  driver = await enrolRunner(harness, { scholar: () => "Learned.", checker: () => pass() });
});
afterAll(() => harness.close());

/** What the runner is offered for the scholar's attempt in a workspace. */
async function offered(name: string, translated: boolean): Promise<{ workspaceId: string; offer: unknown }> {
  const memory = { entry: "# The entry\n\nStaging is reset every night.\n" };
  const { workspaceId } = await makeWorkspace(harness, name, { agents: { scholar: { tools: ["memory.search"] } }, plays: { learn: translated ? translatedPlay : play }, memory });
  if (translated) {
    await harness.admin.command("file.write", { workspaceId, files: [
      { path: "agents/scholar/agent.toml", content: agent('[translations.fr]\ndescription = "Le savant."\n') },
      { path: "memory/entry.fr.md", content: "# L'entrée\n\nLe serveur de préproduction est réinitialisé chaque nuit.\n" },
    ] });
  }
  await harness.admin.command("task.create", { workspaceId, play: "learn" });
  const offers = await driver.drain();
  const work = offers.find((offer) => offer.kind === "work" && offer.workspaceId === workspaceId);
  const { tools, context } = work ?? {};
  return { workspaceId, offer: { tools, catalog: context?.catalog } };
}

describe("translations", () => {
  it("are kept in the manifest for people, while the offer to an agent stays English and the same", async () => {
    const plain = await offered("Plain", false);
    const french = await offered("French", true);
    expect(french.offer).toEqual(plain.offer);
    const { snapshot } = await harness.admin.query("workspace.get", { workspaceId: french.workspaceId });
    expect(snapshot.plays["learn"]?.translations?.fr).toEqual({ title: "Apprendre", description: "Étudier l'espace de travail." });
    expect(snapshot.agents["scholar"]?.translations?.fr?.description).toBe("Le savant.");
    expect(snapshot.memory.find((entry) => entry.name === "entry")?.titles).toEqual({ fr: "L'entrée" });
    const { entries } = await harness.admin.query("memory.list", { workspaceId: french.workspaceId });
    expect(entries.map((entry) => entry.name)).not.toContain("entry.fr");
    expect(snapshot.memory.map((entry) => entry.name)).not.toContain("entry.fr");
  });

  it("of a memory entry are never found by memory.search, and an unknown language or key is refused", async () => {
    const { workspaceId } = await offered("Searching", true);
    const answers: unknown[] = [];
    driver.script({ scholar: async ({ brain }) => { answers.push(await brain("memory.search", { query: "préproduction réinitialisé nuit" })); answers.push(await brain("memory.search", { query: "staging reset" })); return "Searched."; } });
    await harness.admin.command("task.create", { workspaceId, play: "learn" });
    await driver.drain();
    const names = (answer: unknown): string[] => (answer as { output: { results: Array<{ name: string; text: string }> } }).output.results.map((entry) => entry.name);
    expect(names(answers[0])).toEqual([]);
    expect(names(answers[1])).toEqual(["entry"]);
    for (const [content, why] of [
      [agent('[translations.de]\ndescription = "Der Gelehrte."\n'), "translations"],
      [agent('[translations.fr]\ngoal = "Apprendre."\n'), "translations.fr"],
    ] as const) {
      const refused = await harness.admin.command("file.write", { workspaceId, files: [{ path: "agents/scholar/agent.toml", content }] }).then(() => undefined, (e: { problems?: Array<{ message: string }> }) => e.problems?.map((problem) => problem.message).join(" "));
      expect(refused).toContain(why);
    }
    const stray = await harness.admin.command("file.write", { workspaceId, files: [{ path: "memory/nothing.fr.md", content: "# Rien\n" }] }).then(() => undefined, (e: { problems?: Array<{ message: string }> }) => e.problems?.map((problem) => problem.message).join(" "));
    expect(stray).toContain("which does not exist");
    const unsupported = await harness.admin.command("file.write", { workspaceId, files: [{ path: "memory/entry.de.md", content: "# Eintrag\n" }] }).then(() => undefined, (e: { message: string }) => e.message);
    expect(unsupported).toContain("cannot be written");
  });
});
