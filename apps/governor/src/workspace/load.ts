import {
  AgentFile, BRAIN_TOOLS, BrainFile, isIndexedDocument, MAX_INDEXED_BYTES, MemoryEntry, PackFile, parseRef, parseWhen, PLATFORM_PACK, PlayFile, splitPackRef, secretName, sha256Digest, splitMemoryEntry, templateRefs, ToolFile,
  type Digest, type InputSpec, type JsonSchema, type JsonValue, type Language, type Problem, type Ref, type SnapshotManifest, type StepSpec,
} from "@brain/contracts";
import { parse as parseToml } from "smol-toml";
import type { z } from "zod";
import { classifyPath, readPack, type Files } from "./files";

/**
 * A workspace folder and its packs, read into a snapshot (docs/architecture.md section 2). Pure apart from reading the packs directory:
 * the same files give the same manifest, and every problem is reported with the file it is in.
 */
export interface LoadedFile {
  readonly bytes: Uint8Array;
  /** `workspace`, or the pack that supplies the file. */
  readonly source: string;
  /** For a workspace file: the pack whose file of the same path it replaces. */
  readonly replaces?: string;
}
export interface Loaded {
  /** Present exactly when there are no problems. */
  readonly manifest: SnapshotManifest | undefined;
  readonly problems: readonly Problem[];
  /** The folder as agents see it: every pack file, then every workspace file over them. */
  readonly files: ReadonlyMap<string, LoadedFile>;
  /** The bytes the manifest names by digest: prompts, tool files and memory entries. */
  readonly blobs: ReadonlyMap<Digest, Uint8Array>;
}

/** The JSON Schema a call's input must satisfy, from the `[inputs.<name>]` tables of a tool or a Play. */
export function inputSchema(inputs: Readonly<Record<string, InputSpec>>): JsonSchema {
  const properties: Record<string, JsonValue> = {};
  const names = Object.keys(inputs).sort();
  for (const name of names) {
    const spec = inputs[name] as InputSpec;
    properties[name] = {
      type: spec.type,
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.enum ? { enum: spec.enum } : {}),
      ...(spec.items ? { items: { type: spec.items.type, ...(spec.items.enum ? { enum: spec.items.enum } : {}) } } : {}),
    };
  }
  return { type: "object", properties, required: names.filter((name) => inputs[name]?.required), additionalProperties: false };
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
/** TOML dates become the text they were written as, so a schema sees `2027-01-31`. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
  return value;
}
function readToml<S extends z.ZodType>(schema: S, bytes: Uint8Array, path: string, problems: Problem[]): z.output<S> | undefined {
  let raw: unknown;
  try {
    raw = plain(parseToml(text(bytes)));
  } catch (e) {
    const line = (e as { line?: unknown }).line;
    problems.push({ path, message: `not valid TOML${typeof line === "number" ? ` at line ${line}` : ""}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` });
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) problems.push({ path, message: issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message });
  return undefined;
}

/** The packs in use, required packs first, each once. */
function resolvePacks(refs: readonly string[], packsDir: string, releasedDir: string | undefined, problems: Problem[]): { order: Array<{ name: string; files: Files }>; pins: Record<string, number> } {
  const pins: Record<string, number> = {};
  const names: string[] = [];
  for (const ref of refs) {
    const { name, pin } = splitPackRef(ref);
    if (names.includes(name)) problems.push({ path: "brain.toml", message: `pack "${name}" is listed twice` });
    else names.push(name);
    if (pin > 0) pins[name] = pin;
  }
  const order: Array<{ name: string; files: Files }> = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, namedIn: string): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      problems.push({ path: namedIn, message: `pack "${name}" requires itself through the packs it requires` });
      return;
    }
    const files = readPack(packsDir, name, pins[name] ?? 0, releasedDir);
    const packFile = files?.get("pack.toml");
    if (!files || !packFile) {
      problems.push({ path: namedIn, message: pins[name] ? `pack "${name}@${pins[name]}" is not a release of this Brain` : `pack "${name}" does not exist` });
      return;
    }
    state.set(name, "visiting");
    const path = `packs/${name}/pack.toml`;
    const pack = readToml(PackFile, packFile, path, problems);
    if (pack && pack.name !== name) problems.push({ path, message: `name is "${pack.name}" but the pack folder is "${name}"` });
    for (const required of pack?.requires ?? []) visit(required, path);
    state.set(name, "done");
    order.push({ name, files });
  };
  for (const name of names) visit(name, "brain.toml");
  return { order, pins };
}

/** What is wrong with one Play: its steps, the agents they name and the values their templates refer to. */
function playProblems(play: PlayFile, agents: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const inputNames = new Set(Object.keys(play.inputs));
  // A webhook delivery arrives as the input `delivery`.
  if (play.trigger?.webhook) inputNames.add("delivery");
  for (const reserved of ["steps", "item"]) if (inputNames.has(reserved)) found.push(`an input cannot be named "${reserved}"`);
  const earlier = new Map<string, StepSpec>();
  /** Every step a step waits for, directly or through another. */
  const waitsFor = (step: StepSpec): Set<string> => {
    const all = new Set<string>();
    const walk = (ids: readonly string[]): void => {
      for (const id of ids) {
        if (all.has(id)) continue;
        all.add(id);
        walk(earlier.get(id)?.after ?? []);
      }
    };
    walk(step.after);
    return all;
  };
  for (const step of play.step) {
    const at = `step "${step.id}"`;
    const say = (message: string): void => void found.push(`${at}: ${message}`);
    if (earlier.has(step.id)) say("another step has the same id");
    const candidates = Array.isArray(step.candidates) ? step.candidates : [];
    const doers = [...(step.agent ? [step.agent] : []), ...candidates];
    if (doers.length === 0) say("needs an agent, or candidates as a list of agents");
    for (const agent of new Set([...doers, ...(step.review_by ? [step.review_by] : []), ...(step.judge && step.judge !== "person" ? [step.judge] : [])])) {
      if (!agents.has(agent)) say(`agent "${agent}" does not exist`);
    }
    for (const id of step.after) if (!earlier.has(id)) say(`after names "${id}", which is not an earlier step`);
    if (step.review_by && doers.includes(step.review_by)) say(`review_by must differ from the agent that does the step ("${step.review_by}")`);
    if (step.judge && doers.includes(step.judge)) say(`judge must differ from the agents that attempt the step ("${step.judge}")`);
    if (step.candidates !== undefined && !step.judge) say("candidates needs a judge: an agent, or \"person\"");
    if (step.judge && step.candidates === undefined) say("judge is only for a step with candidates");

    const reachable = waitsFor(step);
    const checkRef = (ref: Ref | undefined, shown: string): void => {
      if (!ref) say(`${shown} is not a value: use an input name, steps.<id>.result or item`);
      else if (ref.kind === "item" && !step.for_each) say(`${shown} is only available in a step with for_each`);
      else if (ref.kind === "step" && !reachable.has(ref.step)) say(`${shown} reads step "${ref.step}", which this step does not wait for (list it in after)`);
      else if (ref.kind === "input" && !inputNames.has(ref.name)) say(`${shown} is not an input of this Play`);
      else if (ref.kind === "input" && ref.path.length > 0 && ref.name !== "delivery" && play.inputs[ref.name]?.type !== "object") say(`${shown} reads a field of input "${ref.name}", which is not of type object`);
    };
    for (const { raw, ref } of templateRefs(step.goal ?? "")) checkRef(ref, raw);
    if (step.when !== undefined) {
      const when = parseWhen(step.when);
      if (!when) say("when must be one comparison, such as steps.<id>.result.<field> == \"value\"");
      else checkRef(when.ref, `when (${step.when})`);
    }
    if (step.for_each !== undefined) {
      const ref = parseRef(step.for_each);
      if (ref?.kind !== "step") say("for_each must name a list in an earlier result, written steps.<id>.result.<field>");
      else checkRef(ref, `for_each (${step.for_each})`);
    }
    earlier.set(step.id, step);
  }
  return found;
}

export function loadWorkspace(workspace: Files, packsDir: string, releasedDir?: string): Loaded {
  const problems: Problem[] = [];
  const files = new Map<string, LoadedFile>();
  const blobs = new Map<Digest, Uint8Array>();
  const done = (manifest?: SnapshotManifest): Loaded => ({ manifest: problems.length === 0 ? manifest : undefined, problems, files, blobs });
  const blob = (bytes: Uint8Array): { digest: Digest; bytes: number } => {
    const digest = sha256Digest(bytes);
    blobs.set(digest, bytes);
    return { digest, bytes: bytes.length };
  };

  const brainBytes = workspace.get("brain.toml");
  if (!brainBytes) problems.push({ path: "brain.toml", message: "the workspace has no brain.toml" });
  const brain = brainBytes ? readToml(BrainFile, brainBytes, "brain.toml", problems) : undefined;

  const { order: packs, pins } = resolvePacks(brain?.packs ?? [], packsDir, releasedDir, problems);
  for (const pack of packs) for (const [path, bytes] of pack.files) if (path !== "pack.toml") files.set(path, { bytes, source: pack.name });
  for (const [path, bytes] of workspace) {
    const replaced = files.get(path)?.source;
    files.set(path, { bytes, source: "workspace", ...(replaced ? { replaces: replaced } : {}) });
  }
  if (!brain) return done();
  /** The path a person finds the file at. */
  const shown = (path: string): string => {
    const source = files.get(path)?.source ?? "workspace";
    return source === "workspace" ? path : `packs/${source}/${path}`;
  };

  const agentNames = new Set<string>();
  const toolFiles = new Map<string, string[]>();
  const playNames: string[] = [];
  const memoryNames: string[] = [];
  const memoryTranslations: Array<{ name: string; lang: Language; path: string }> = [];
  for (const path of [...files.keys()].sort()) {
    const kind = classifyPath(path);
    if (kind?.kind === "agent") agentNames.add(kind.name);
    else if (kind?.kind === "tool") toolFiles.set(kind.name, [...(toolFiles.get(kind.name) ?? []), kind.file]);
    else if (kind?.kind === "play") playNames.push(kind.name);
    else if (kind?.kind === "memory" && !kind.lang) memoryNames.push(kind.name);
    else if (kind?.kind === "memory" && kind.lang) memoryTranslations.push({ name: kind.name, lang: kind.lang, path });
  }

  const duplicate = (names: readonly string[]): string | undefined => names.find((name, index) => names.indexOf(name) !== index);
  const twiceModel = duplicate(brain.model.map((model) => model.name));
  if (twiceModel) problems.push({ path: "brain.toml", message: `two models are named "${twiceModel}"` });
  const twiceProject = duplicate(brain.project.map((project) => project.name));
  if (twiceProject) problems.push({ path: "brain.toml", message: `two projects are named "${twiceProject}"` });

  const tools: Record<string, SnapshotManifest["tools"][string]> = {};
  for (const [name, beside] of toolFiles) {
    const path = `tools/${name}/tool.toml`;
    const file = files.get(path);
    if (!file) {
      problems.push({ path: shown(`tools/${name}/${beside[0]}`), message: `tool "${name}" has no tool.toml` });
      continue;
    }
    const tool = readToml(ToolFile, file.bytes, shown(path), problems);
    if (!tool) continue;
    const others = beside.filter((entry) => entry !== "tool.toml");
    const hasScript = others.includes("run.sh");
    if (tool.runs === "brain") {
      if (!(BRAIN_TOOLS as readonly string[]).includes(name)) problems.push({ path: shown(path), message: `runs = "brain" is only for the tools Brain implements: ${BRAIN_TOOLS.join(", ")}` });
      if (hasScript) problems.push({ path: shown(path), message: "a tool Brain runs has no run.sh" });
    } else if (tool.host_command === undefined && !hasScript) problems.push({ path: shown(path), message: "the tool needs a run.sh beside it (or runs = \"brain\", or host_command)" });
    else if (tool.host_command !== undefined && hasScript) problems.push({ path: shown(path), message: "a host command tool has no run.sh" });
    tools[name] = {
      ...tool, source: file.source, input_schema: inputSchema(tool.inputs),
      files: others.map((entry) => ({ path: entry, ...blob((files.get(`tools/${name}/${entry}`) as LoadedFile).bytes) })),
    };
  }

  const modelNames = new Set(brain.model.map((model) => model.name));
  const agents: Record<string, SnapshotManifest["agents"][string]> = {};
  for (const name of agentNames) {
    const path = `agents/${name}/agent.toml`;
    const file = files.get(path);
    const prompt = files.get(`agents/${name}/prompt.md`);
    if (!file) problems.push({ path: shown(`agents/${name}/prompt.md`), message: `agent "${name}" has no agent.toml` });
    if (!prompt) problems.push({ path: shown(path), message: `agent "${name}" has no prompt.md` });
    else if (text(prompt.bytes).trim() === "") problems.push({ path: shown(`agents/${name}/prompt.md`), message: "the prompt is empty" });
    const agent = file ? readToml(AgentFile, file.bytes, shown(path), problems) : undefined;
    if (!agent || !file || !prompt) continue;
    for (const tool of agent.tools) if (!toolFiles.has(tool)) problems.push({ path: shown(path), message: `tool "${tool}" does not exist` });
    if (agent.model !== undefined && !modelNames.has(agent.model)) problems.push({ path: shown(path), message: `model "${agent.model}" is not a [[model]] of brain.toml` });
    agents[name] = { ...agent, source: file.source, prompt: blob(prompt.bytes) };
  }

  const plays: Record<string, SnapshotManifest["plays"][string]> = {};
  for (const name of playNames) {
    const path = `plays/${name}.toml`;
    const file = files.get(path) as LoadedFile;
    const play = readToml(PlayFile, file.bytes, shown(path), problems);
    if (!play) continue;
    for (const message of playProblems(play, agentNames)) problems.push({ path: shown(path), message });
    plays[name] = { ...play, source: file.source };
  }

  const memory: Array<SnapshotManifest["memory"][number]> = [];
  for (const name of memoryNames) {
    const path = `memory/${name}.md`;
    const file = files.get(path) as LoadedFile;
    const entry = MemoryEntry.safeParse(splitMemoryEntry(text(file.bytes)));
    if (!entry.success) problems.push({ path: shown(path), message: "a memory entry starts with its title, written as a line `# Title`" });
    else memory.push({ name, title: entry.data.title, titles: {}, source: file.source, ...blob(file.bytes) });
  }
  // A translation of an entry is read by people only: it is not indexed, and agents are not offered it.
  for (const { name, lang, path } of memoryTranslations) {
    const entry = memory.find((candidate) => candidate.name === name);
    const parsed = MemoryEntry.safeParse(splitMemoryEntry(text((files.get(path) as LoadedFile).bytes)));
    if (!parsed.success) problems.push({ path: shown(path), message: "a memory entry starts with its title, written as a line `# Title`" });
    else if (!entry) problems.push({ path: shown(path), message: `translates the memory entry ${name}, which does not exist` });
    else (entry.titles as Partial<Record<Language, string>>)[lang] = parsed.data.title;
  }

  // The text documents agents can search; a file that is not valid text, or is too long, is a document that is only stored.
  const documents: Array<SnapshotManifest["documents"][number]> = [];
  for (const [path, file] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (file.source !== "workspace" || !isIndexedDocument(path) || file.bytes.length > MAX_INDEXED_BYTES) continue;
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { continue; }
    documents.push({ path, title: splitMemoryEntry(content).title || (path.split("/").at(-1) ?? path), ...blob(file.bytes) });
  }

  if (brain.platform && brain.visibility === "public") problems.push({ path: "brain.toml", message: "a platform workspace is private: it holds what every workspace did, so it cannot also be public" });
  if (brain.platform === undefined && packs.some((pack) => pack.name === PLATFORM_PACK)) problems.push({ path: "brain.toml", message: `only a platform workspace (platform = "admin" or "read") may use the pack ${PLATFORM_PACK}` });
  if (brain.approvals["workspace.fix"]) problems.push({ path: "brain.toml", message: "a change of the workspace's own files is always decided by an admin: approvals cannot cover workspace.fix" });
  for (const tool of Object.keys(brain.approvals)) if (!toolFiles.has(tool)) problems.push({ path: "brain.toml", message: `approvals names tool "${tool}", which does not exist` });

  return done(JSON.parse(JSON.stringify({
    name: brain.name, description: brain.description, timezone: brain.timezone, visibility: brain.visibility, ...(brain.platform ? { platform: brain.platform } : {}), packs: packs.map((pack) => pack.name), ...(Object.keys(pins).length > 0 ? { pins } : {}), limits: brain.limits, healing: brain.healing, cleanup: brain.cleanup, models: brain.model, projects: brain.project,
    github: brain.github ?? null, ...(brain.git ? { git: brain.git } : {}), teams: brain.teams ?? null, approvals: brain.approvals, agents, tools, plays, memory, documents,
  } satisfies SnapshotManifest)) as SnapshotManifest);
}

/** Every secret name the snapshot refers to. */
export function referencedSecrets(manifest: SnapshotManifest): string[] {
  const refs = [
    ...manifest.models.map((model) => model.key), ...manifest.projects.map((project) => project.credential),
    manifest.github?.credential, manifest.github?.webhook_secret, manifest.git?.credential, manifest.teams?.webhook,
  ].filter((ref): ref is string => ref !== undefined).map(secretName);
  return [...new Set([...refs, ...Object.values(manifest.tools).flatMap((tool) => tool.secrets)])].sort();
}
