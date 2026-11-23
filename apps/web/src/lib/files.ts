import { LIMIT_DEFAULTS } from "@brain/contracts/limits";
import type { AgentFile, PlatformKind, PlayFile, SnapshotManifest, StepSpec, ToolFile } from "@brain/contracts";
import { compact, toToml, type TomlTable, type TomlValue } from "./toml";

/**
 * The workspace's files as the forms write them. A form starts from the active snapshot (every file already parsed, defaults filled in),
 * changes some fields and writes the whole file back; what equals a default is left out so the file stays short.
 */

export type Model = SnapshotManifest["models"][number] & { input_usd_per_mtok?: number; output_usd_per_mtok?: number };
export type Project = SnapshotManifest["projects"][number];
type Approvals = SnapshotManifest["approvals"];
/** What `brain.toml` holds; `timezone` is optional and newer than the manifest type. */
export interface Brain {
  name: string;
  description: string;
  timezone?: string;
  visibility?: "private" | "public";
  /** A platform workspace: kept as it is read, set only by a platform administrator. */
  platform?: PlatformKind;
  packs: readonly string[];
  limits: SnapshotManifest["limits"];
  healing: SnapshotManifest["healing"];
  cleanup: SnapshotManifest["cleanup"];
  models: readonly Model[];
  projects: readonly Project[];
  github: SnapshotManifest["github"];
  /** The remote the workspace folder is pushed to. */
  git: SnapshotManifest["git"];
  teams: SnapshotManifest["teams"];
  approvals: Approvals;
}

export function brainOf(snapshot: SnapshotManifest): Brain {
  const { name, description, packs, limits, healing, cleanup, models, projects, github, git, teams, approvals } = snapshot;
  const pins = snapshot.pins ?? {};
  return { name, description, timezone: snapshot.timezone, visibility: snapshot.visibility, ...(snapshot.platform ? { platform: snapshot.platform } : {}), packs: packs.map((pack) => (pins[pack] ? `${pack}@${pins[pack]}` : pack)), limits, healing, cleanup, models, projects, github, git, teams, approvals };
}

const differs = <T>(value: T, standard: T): T | undefined => (value === standard ? undefined : value);

export function brainToml(brain: Brain): string {
  return toToml(compact({
    name: brain.name,
    description: brain.description,
    timezone: brain.timezone,
    visibility: brain.visibility === "public" ? "public" : undefined,
    platform: brain.platform,
    packs: brain.packs,
    // A value that is the default is not written: the file says only what was chosen.
    limits: { daily_spend_usd: differs(brain.limits.daily_spend_usd, LIMIT_DEFAULTS.daily_spend_usd), running_tasks: differs(brain.limits.running_tasks, LIMIT_DEFAULTS.running_tasks), confirm_plans: differs(brain.limits.confirm_plans, "person"), paused: differs(brain.limits.paused, false) },
    healing: { mode: differs(brain.healing.mode, "auto"), per_day: differs(brain.healing.per_day, LIMIT_DEFAULTS.healing_per_day) },
    cleanup: { superseded_after_hours: differs(brain.cleanup.superseded_after_hours, 24) },
    model: brain.models.map((model) => ({ ...model })),
    project: brain.projects.map((project) => ({ ...project, branch: differs(project.branch, "main"), access: differs(project.access, "read"), network: project.network.length > 0 ? project.network : undefined })),
    github: brain.github ? { ...brain.github } : undefined,
    git: brain.git ? { ...brain.git } : undefined,
    teams: brain.teams ? { ...brain.teams } : undefined,
    approvals: Object.fromEntries(Object.entries(brain.approvals).map(([tool, rule]) => [tool, { ...rule }])),
  }));
}

export function agentToml(agent: AgentFile): string {
  const { description, engine, native, tools, model, limits, translations } = agent;
  return toToml(compact({ description, engine, native: differs(native, "none"), tools, model, limits: { turns: differs(limits.turns, LIMIT_DEFAULTS.turns), tokens: differs(limits.tokens, LIMIT_DEFAULTS.tokens), spend_usd: differs(limits.spend_usd, LIMIT_DEFAULTS.spend_usd) }, translations: translations as TomlTable | undefined }));
}

const inputsTable = (inputs: ToolFile["inputs"]): TomlTable => Object.fromEntries(Object.entries(inputs).map(([name, spec]) => [name, { type: spec.type, description: spec.description || undefined, required: spec.required, enum: spec.enum, items: spec.items ? { ...spec.items } : undefined }]));

/** The translations of a file, written back as they are; a translated input the form removed or renamed is dropped with it. */
function keepInputs(translations: ToolFile["translations"] | PlayFile["translations"], inputs: ToolFile["inputs"]): TomlTable | undefined {
  if (!translations) return undefined;
  const out: Record<string, TomlTable> = {};
  for (const [lang, entry] of Object.entries(translations)) {
    const { inputs: translated, ...rest } = entry as { inputs?: Record<string, TomlTable> } & TomlTable;
    out[lang] = { ...rest, ...(translated ? { inputs: Object.fromEntries(Object.entries(translated).filter(([name]) => name in inputs)) } : {}) };
  }
  return out;
}

export function toolToml(tool: ToolFile): string {
  const { description, effect, timeout_seconds, needs, network, secrets, runs, host_command, inputs, translations } = tool;
  // `inputs` is filled after `compact`, which would drop a `required = false` it must keep.
  return toToml({ ...compact({ description, runs, host_command, effect, timeout_seconds: differs(timeout_seconds, 60), needs, network, secrets }), inputs: inputsTable(inputs), ...compact({ translations: keepInputs(translations, inputs) }) });
}

function stepTable(step: StepSpec): TomlTable {
  const { id, agent, goal, after, for_each, review_by, max_rounds, target_score, candidates, judge, when, approve } = step;
  return compact({ id, agent, goal, after, for_each, when, review_by, max_rounds: review_by && max_rounds !== 2 ? max_rounds : undefined, target_score, candidates: candidates as TomlValue, judge, approve: approve || undefined });
}

export function playToml(play: PlayFile): string {
  const { title, description, inputs, trigger, step, translations } = play;
  return toToml({ ...compact({ title, description }), inputs: inputsTable(inputs), ...compact({ trigger: trigger ? { ...trigger } : undefined }), step: step.map(stepTable), ...compact({ translations: keepInputs(translations, inputs) }) });
}

/** Where each kind of thing lives in the workspace folder. */
export const paths = {
  brain: "brain.toml",
  agent: (name: string): string => `agents/${name}/agent.toml`,
  prompt: (name: string): string => `agents/${name}/prompt.md`,
  tool: (name: string): string => `tools/${name}/tool.toml`,
  script: (name: string): string => `tools/${name}/run.sh`,
  play: (name: string): string => `plays/${name}.toml`,
  memory: (name: string): string => `memory/${name}.md`,
  memoryIn: (name: string, lang: "fr" | "ar"): string => `memory/${name}.${lang}.md`,
};
