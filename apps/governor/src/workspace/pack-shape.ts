import type { Problem, SnapshotManifest } from "@brain/contracts";

/**
 * The shape of a pack (packs/README.md, "The shape of a pack"), checked wherever a pack is accepted: by the repository's tests, when it is
 * released and by `pnpm brain check`. It reads a manifest that holds the pack and what it requires; `source` names the pack's own files in
 * it. What a pack says to people in other languages is asked of the shipped packs alone, by their test.
 */
const MOST_FOR_A_CRITIC = 0.75;
const MOST_WITH_ALL_NATIVE = 2;
const MOST_OTHERWISE = 1;
const TOOL_NAME = /^[a-z0-9-]+\.[a-z0-9-]+$/u;
const MODEL_TO_COPY = /(?:template|example)/u;

export function packShapeProblems(manifest: SnapshotManifest, source: string): Problem[] {
  const problems: Problem[] = [];
  const own = <T extends { readonly source: string }>(entries: Readonly<Record<string, T>>): Array<[string, T]> => Object.entries(entries).filter(([, entry]) => entry.source === source);
  const say = (path: string, message: string): void => void problems.push({ path, message });
  // A critic is any agent a Play names in `review_by`, and the checker.
  const critics = new Set(["checker", ...Object.values(manifest.plays).flatMap((play) => play.step.map((step) => step.review_by ?? ""))]);

  for (const [name, agent] of own(manifest.agents)) {
    const path = `agents/${name}/agent.toml`;
    const spend = agent.limits.spend_usd;
    const most = agent.native === "all" ? MOST_WITH_ALL_NATIVE : MOST_OTHERWISE;
    if (agent.model !== undefined) say(path, "an agent of a pack sets no model: the workspace that uses it chooses");
    if (spend <= 0 || spend > most) say(path, `an agent of a pack has a spend limit of at most ${most.toFixed(2)} with native = "${agent.native}"`);
    const changing = agent.tools.filter((tool) => manifest.tools[tool] !== undefined && manifest.tools[tool].effect !== "read");
    if (critics.has(name)) {
      if (agent.native === "all") say(path, 'a critic changes nothing: it has no native = "all"');
      for (const tool of changing) say(path, `a critic changes nothing: it has the tool ${tool}, which does`);
      if (spend > MOST_FOR_A_CRITIC) say(path, `a critic costs at most ${MOST_FOR_A_CRITIC} a round`);
    }
    if (agent.tools.some((tool) => manifest.tools[tool]?.effect === "privileged") && (agent.native !== "none" || spend > MOST_FOR_A_CRITIC)) {
      say(path, `an agent with a privileged tool is an operator: native = "none" and at most ${MOST_FOR_A_CRITIC}`);
    }
  }
  for (const [name, tool] of own(manifest.tools)) {
    const path = `tools/${name}/tool.toml`;
    if (!TOOL_NAME.test(name)) say(path, "a tool of a pack is named <system>.<verb>");
    const files = new Set(tool.files.map((file) => file.path));
    if (files.has("run.sh") !== files.has("test.sh")) say(path, "a script tool has run.sh and test.sh together");
  }
  const entries = manifest.memory.filter((entry) => entry.source === source).map((entry) => entry.name);
  for (const name of entries) if (MODEL_TO_COPY.test(name) && !name.startsWith("template-")) say(`memory/${name}.md`, "an entry a workspace copies and fills in is named template-<what>");
  const schedules = new Map<string, string>();
  for (const [name, play] of own(manifest.plays)) {
    const path = `plays/${name}.toml`;
    for (const pattern of play.step.flatMap((step) => step.requires)) {
      const matches = new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`, "u");
      if (entries.some((entry) => matches.test(entry))) say(path, `requires "${pattern}", which the pack's own memory satisfies: only an entry of the workspace can`);
    }
    const schedule = play.trigger?.schedule;
    if (schedule === undefined) continue;
    const first = schedules.get(schedule);
    if (first !== undefined) say(path, `starts at the same time as ${first}`);
    schedules.set(schedule, name);
  }
  return problems;
}
