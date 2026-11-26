import { modelsOf } from "../workspace/platform";
import { MODEL_DEFAULTS, secretName, signStoreGrant, type BlobRef, type Digest, type JobOffer, type JsonValue, type OfferProject, type OfferTool, type OfferToolCall, type SnapshotManifest, type ToolOutcome, type ModelRoute, speaks, fieldSchema } from "@brain/contracts";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { repoPath } from "../integrations/github";
import { attemptOf, json, payloadOf, taskOf, type AttemptRow, type TaskRow, stepOf } from "../tasks/store";
import { microUsd } from "../trust/usage";
import { manifestOf } from "../workspace/store";

/** What a claimed attempt is handed (docs/architecture.md section 6): the JobOffer, built from the task, its snapshot and the record so far. */
/** The secret that fetches and pushes a project: its own `credential`, or the workspace's `[github]` one when it names none (docs/model.md). */
export const credentialOf = (manifest: SnapshotManifest, project: SnapshotManifest["projects"][number]): SnapshotManifest["projects"][number]["credential"] => project.credential ?? manifest.github?.credential;

export const OFFER_FOR_MS = 30_000;
/** How long a git store token lasts: an attempt never runs longer. */
const STORE_TOKEN_SECONDS = 6 * 3600;
const MAX_SHOWN = 8_000;
const clip = (text: string): string => (text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n[cut: ${text.length - MAX_SHOWN} more characters]` : text);

/**
 * What a runner lacks to take an attempt, or null when it can: it needs one of the agent's engines, everything the agent's tools need, and
 * `native-tools` when the agent uses the engine's own. An `act` attempt runs one tool and no engine.
 */
export function missing(gov: Gov, manifest: SnapshotManifest, attempt: AttemptRow, runner: { capabilities: ReadonlySet<string>; engines: ReadonlySet<string> }): { what: "agent" | "engine" | "capability"; name: string } | null {
  const agent = manifest.agents[attempt.agent];
  if (!agent) return { what: "agent", name: attempt.agent };
  const lacks = (needs: readonly string[] | undefined): string | undefined => (needs ?? []).find((capability) => !runner.capabilities.has(capability));
  const act = payloadOf(attempt).act;
  if (act) return capability(lacks(manifest.tools[act.tool]?.needs));
  const routes = routesOf(gov, attempt.workspace_id, manifest, agent.model);
  const speaking = agent.engine.filter((engine) => speaks(engine, routes));
  // An agent none of whose engines speaks the model's API waits as unready (preflight.ts), not for a runner.
  const usable = speaking.length > 0 ? speaking : agent.engine;
  if (!usable.some((engine) => runner.engines.has(engine))) return { what: "engine", name: usable.join(" or ") };
  return capability(agent.tools.map((tool) => lacks(manifest.tools[tool]?.needs)).find((name) => name !== undefined) ?? (agent.native !== "none" && !runner.capabilities.has("native-tools") ? "native-tools" : undefined));
}
/** The model routes an agent may call: the model it names, or else the workspace's first model of each API, in the order of `brain.toml`. */
export function routesOf(gov: Gov, workspaceId: string, manifest: SnapshotManifest, named: string | undefined): ModelRoute[] {
  const all = modelsOf(gov, workspaceId, manifest).models;
  const own = all.find((model) => model.name === named);
  const chosen = own ? [own] : all.filter((model, index) => all.findIndex((other) => other.provider === model.provider) === index);
  return chosen.map((model) => ({ provider: model.provider, route: model.name, contextTokens: model.context_tokens ?? MODEL_DEFAULTS.context_tokens, compactAt: model.compact_at ?? MODEL_DEFAULTS.compact_at }));
}

const capability = (name: string | undefined): { what: "capability"; name: string } | null => (name === undefined ? null : { what: "capability", name });

const blob = (db: Db, digest: Digest): BlobRef => ({ digest, bytes: (db.prepare("SELECT bytes FROM artifacts WHERE digest=?").get(digest) as { bytes: number }).bytes });

/** The tasks a task starts from: every task it waits for, directly or through another, oldest first. */
function inheritedTasks(db: Db, task: TaskRow): string[] {
  const seen = new Map<string, number>();
  const walk = (taskId: string): void => {
    const next = db.prepare(`SELECT t.id, t.rowid AS at FROM tasks t WHERE t.id IN (SELECT waits_for FROM task_deps WHERE task_id=?)
      OR (t.parent_id=? AND (SELECT agent FROM tasks WHERE id=?) IS NULL)`).all(taskId, taskId, taskId) as Array<{ id: string; at: number }>;
    for (const row of next) {
      if (seen.has(row.id)) continue;
      seen.set(row.id, row.at);
      walk(row.id);
    }
  };
  for (const { waits_for: id } of db.prepare("SELECT waits_for FROM task_deps WHERE task_id=?").all(task.id) as Array<{ waits_for: string }>) {
    if (!seen.has(id)) {
      seen.set(id, (db.prepare("SELECT rowid AS at FROM tasks WHERE id=?").get(id) as { at: number }).at);
      walk(id);
    }
  }
  return [...seen].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

const stateOf = (payload: string): Record<string, string> | undefined => (JSON.parse(payload) as { stateCommits?: Record<string, string> }).stateCommits;

/** The state commits a task starts from: those of the attempts whose changes were accepted, oldest first, each once (the store's side of `inheritedPatches`). */
function inheritedStates(db: Db, task: TaskRow): Array<{ attemptId: string; commits: Record<string, string> }> {
  const states: Array<{ attemptId: string; commits: Record<string, string> }> = [];
  for (const id of inheritedTasks(db, task)) {
    const attempt = db.prepare("SELECT a.id, a.working_copy AS patch, a.payload_json AS payload FROM checks c JOIN attempts a ON a.id = c.attempt_id WHERE c.task_id=? AND c.pass=1 ORDER BY c.id DESC LIMIT 1").get(id) as { id: string; patch: Digest | null; payload: string } | undefined;
    const commits = attempt?.patch ? stateOf(attempt.payload) : undefined;
    if (attempt && commits && !states.some((state) => state.attemptId === attempt.id)) states.push({ attemptId: attempt.id, commits });
  }
  return states;
}

/** The commit each project is worked on at: the head of the pull request that started the goal, else the commit the goal's first attempt found. */
function baseCommits(db: Db, root: TaskRow, manifest: SnapshotManifest): Record<string, string> {
  const commits: Record<string, string> = {};
  const delivery = json<{ delivery?: { repository?: { full_name?: unknown }; pull_request?: { head?: { sha?: unknown } } } }>(root.inputs_json)?.delivery;
  const head = delivery?.pull_request?.head?.sha;
  if (typeof head === "string" && typeof delivery?.repository?.full_name === "string") {
    for (const project of manifest.projects) if (repoPath(project.repo) === delivery.repository.full_name.toLowerCase()) commits[project.name] = head;
  }
  for (const row of db.prepare("SELECT a.base_commits_json AS commits FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE t.root_id=? AND a.base_commits_json IS NOT NULL ORDER BY a.rowid").all(root.id) as Array<{ commits: string }>) {
    for (const [project, commit] of Object.entries(JSON.parse(row.commits) as Record<string, string>)) commits[project] ??= commit;
  }
  return commits;
}
export const baseCommitOf = (gov: Gov, task: TaskRow, project: string): string | undefined => baseCommits(gov.db, taskOf(gov.db, task.root_id), manifestOf(gov, task.snapshot_digest))[project];

/** The calls an attempt made, in order: workspace and Brain-run tools from the record, the engine's own from its events. */
function callsOf(db: Db, attemptId: string): OfferToolCall[] {
  const calls: Array<OfferToolCall & { at: number }> = (db.prepare("SELECT tool, effect, input_json, output_json, outcome, created_at_ms AS at FROM tool_calls WHERE attempt_id=? AND outcome != 'pending' ORDER BY rowid").all(attemptId) as
    Array<{ tool: string; effect: OfferToolCall["effect"]; input_json: string; output_json: string | null; outcome: ToolOutcome; at: number }>)
    .map((row) => ({ tool: row.tool, effect: row.effect, input: JSON.parse(row.input_json) as JsonValue, output: json<JsonValue>(row.output_json), outcome: row.outcome, at: row.at }));
  const native = new Map<string, { name: string; input: JsonValue; at: number }>();
  for (const event of db.prepare("SELECT at_ms AS at, body_json AS body FROM attempt_events WHERE attempt_id=? AND kind IN ('native.call','native.result') ORDER BY seq").all(attemptId) as Array<{ at: number; body: string }>) {
    const body = JSON.parse(event.body) as { kind: string; callId: string; name?: string; input?: JsonValue; ok?: boolean; output?: string };
    if (body.kind === "native.call") native.set(body.callId, { name: body.name ?? "", input: body.input ?? null, at: event.at });
    const call = native.get(body.callId);
    if (body.kind === "native.result" && call) calls.push({ tool: call.name, effect: "read", input: call.input, output: clip(body.output ?? ""), outcome: body.ok ? "succeeded" : "failed", at: call.at });
  }
  return calls.sort((a, b) => a.at - b.at).slice(-200).map(({ at: _at, ...call }) => call);
}

/** What happened before on this task, for the agent that works on it next: the findings of failed checks, and what became of the calls an earlier attempt left for a person. */
function findingsOf(db: Db, task: TaskRow): string[] {
  const checks = (db.prepare(`SELECT c.round, c.by_kind, c.by_id, c.findings, u.name FROM checks c LEFT JOIN "user" u ON u.id = c.by_id AND c.by_kind='person' WHERE c.task_id=? AND c.pass=0 ORDER BY c.id`).all(task.id) as
    Array<{ round: number; by_kind: string; by_id: string; findings: string; name: string | null }>).map((row) => `Round ${row.round}, check by ${row.by_kind === "person" ? (row.name ?? "a person") : row.by_id}: ${row.findings || "not accepted"}`);
  const calls = (db.prepare(`SELECT c.tool, c.input_json, c.output_json, c.outcome, p.state FROM tool_calls c JOIN approvals p ON p.id = c.approval_id JOIN attempts a ON a.id = c.attempt_id
    WHERE c.task_id=? AND a.state='held' AND p.state != 'pending' ORDER BY c.rowid`).all(task.id) as Array<{ tool: string; input_json: string; output_json: string | null; outcome: string; state: string }>).map((row) => {
    const call = `Your earlier call to ${row.tool} with ${clip(row.input_json)}`;
    if (row.state === "approved") return row.outcome === "succeeded" ? `${call} was approved after you stopped, and it ran. Its answer: ${clip(row.output_json ?? "null")}` : `${call} was approved after you stopped, but it did not succeed: ${clip(row.output_json ?? "no answer")}${row.tool === "workspace.fix" && /workspace changed after/u.test(row.output_json ?? "") ? ". The files you read are now the current ones: read them again and call workspace.fix again with the change made on them, without asking anyone" : ""}`;
    return `${call} did not happen (${row.state === "rejected" ? "a person declined it" : "nobody decided in time"}): ${clip(row.output_json ?? "")}. Do not repeat it.`;
  });
  // A plan the Governor refused: the planner that makes the plan again is told why.
  const refused = (db.prepare("SELECT payload_json AS payload FROM attempts WHERE task_id=? AND kind='plan' ORDER BY rowid").all(task.id) as Array<{ payload: string }>)
    .flatMap((row) => { const problem = (JSON.parse(row.payload) as { refused?: string }).refused; return problem ? [`Your earlier plan was refused: ${problem}. Make a plan that deals with it.`] : []; });
  return [...refused, ...checks, ...calls];
}

/** Builds the offer of an attempt that was just given to a runner, and notes on the attempt which stored bytes it names. */
export function buildOffer(gov: Gov, attempt: AttemptRow): JobOffer {
  const { db } = gov;
  const task = taskOf(db, attempt.task_id);
  const manifest = manifestOf(gov, task.snapshot_digest);
  const agent = manifest.agents[attempt.agent] as SnapshotManifest["agents"][string];
  const payload = payloadOf(attempt);
  const declared = stepOf(gov, task)?.outputs;

  // A `for_each` step is given as its copies, not as the list that groups them.
  const results = (db.prepare(`SELECT t.id, t.title, t.result, t.output_json FROM tasks t WHERE t.for_each IS NULL AND (t.id IN (SELECT waits_for FROM task_deps WHERE task_id=?)
    OR t.parent_id IN (SELECT d.waits_for FROM task_deps d JOIN tasks g ON g.id = d.waits_for WHERE d.task_id=? AND g.for_each IS NOT NULL)) ORDER BY t.rowid`).all(task.id, task.id) as
    Array<{ id: string; title: string; result: string | null; output_json: string | null }>)
    .map((row) => ({ taskId: row.id, title: row.title, result: row.result ?? "", ...(row.output_json !== null ? { output: JSON.parse(row.output_json) as JsonValue } : {}) }));
  const notes = db.prepare("SELECT author, text, created_at_ms AS at FROM notes WHERE root_id=? ORDER BY id").all(task.root_id) as Array<{ author: string; text: string; at: number }>;
  const answers = (db.prepare("SELECT input_json, output_json FROM tool_calls WHERE task_id=? AND tool='task.ask' AND json_extract(output_json, '$.status')='answered' ORDER BY rowid").all(task.id) as Array<{ input_json: string; output_json: string }>)
    .map((row) => ({ question: (JSON.parse(row.input_json) as { question: string }).question, ...(JSON.parse(row.output_json) as { answer: string; by: string; at: number }) }))
    .map(({ question, answer, by, at }) => ({ question, answer, by, at }));
  const review = (payload.review ?? []).map((id) => {
    const reviewed = attemptOf(db, id);
    return {
      attemptId: id, agent: reviewed.agent, result: reviewed.result ?? "", ...(reviewed.output_json !== null ? { output: JSON.parse(reviewed.output_json) as JsonValue } : {}),
      toolCalls: callsOf(db, id), ...(reviewed.working_copy !== null ? { diff: blob(db, reviewed.working_copy) } : {}),
      files: (db.prepare("SELECT l.name, l.digest, a.bytes FROM artifact_links l JOIN artifacts a ON a.digest=l.digest WHERE l.attempt_id=? AND l.kind='output' ORDER BY l.id").all(id) as Array<{ name: string; digest: Digest; bytes: number }>),
    };
  });

  // A check works on the change it checks; the work itself continues from what an earlier attempt of the task left.
  const inherited = inheritedStates(db, task);
  const reviewed = attempt.kind === "check" && review[0] ? stateOf(attemptOf(db, review[0].attemptId).payload_json) : undefined;
  if (reviewed && review[0]) inherited.push({ attemptId: review[0].attemptId, commits: reviewed });
  // The work itself continues from what an earlier attempt of the same task left: its state is the last one merged.
  const earlier = attempt.kind === "work" || attempt.kind === "act"
    ? (db.prepare("SELECT id, payload_json AS payload FROM attempts WHERE task_id=? AND kind='work' AND working_copy IS NOT NULL AND candidate IS ? AND id != ? ORDER BY rowid DESC LIMIT 1").get(task.id, attempt.candidate, attempt.id) as { id: string; payload: string } | undefined)
    : undefined;
  const own = earlier ? stateOf(earlier.payload) : undefined;
  if (earlier && own) inherited.push({ attemptId: earlier.id, commits: own });
  const commits = baseCommits(db, taskOf(db, task.root_id), manifest);
  const tools: OfferTool[] = agent.tools.map((name) => {
    const tool = manifest.tools[name] as SnapshotManifest["tools"][string];
    return {
      name, description: tool.description, effect: tool.effect, inputSchema: tool.input_schema, ...(tool.output_schema ? { outputSchema: tool.output_schema } : {}), files: tool.files.map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes })),
      network: tool.network, secrets: tool.secrets, needs: tool.needs, timeoutSeconds: tool.timeout_seconds, ...(tool.runs ? { runs: tool.runs } : {}), ...(tool.host_command ? { hostCommand: tool.host_command } : {}), ...(tool.mcp ? { mcp: tool.mcp } : {}),
    };
  });
  const projects: OfferProject[] = manifest.projects.map((project) => {
    const credential = credentialOf(manifest, project);
    return {
      name: project.name, repo: project.repo, branch: project.branch, access: project.access, network: project.network, ...(project.setup ? { setup: project.setup } : {}),
      ...(credential ? { credential: secretName(credential) } : {}), ...(commits[project.name] ? { baseCommit: commits[project.name] as string } : {}),
    };
  });
  const describe = (entries: Record<string, { description?: string; title?: string; tools?: readonly string[]; native?: string }>) => Object.entries(entries).map(([name, entry]) => ({ name, description: entry.description || entry.title || "", ...(entry.tools ? { tools: [...entry.tools] } : {}), ...(entry.native === "all" ? { writes: true } : {}) }));

  const offered = [...review.flatMap((entry) => [...(entry.diff ? [entry.diff.digest] : []), ...entry.files.map((file) => file.digest)])];
  db.prepare("UPDATE attempts SET payload_json=? WHERE id=?").run(JSON.stringify({ ...payload, offered }), attempt.id);
  return {
    attemptId: attempt.id, fence: attempt.fence, kind: attempt.kind, workspaceId: attempt.workspace_id, offerExpiresAt: attempt.offer_expires_at_ms ?? 0,
    task: { id: task.id, title: task.title, goal: task.goal, round: task.round, findings: findingsOf(db, task), ...(attempt.kind === "work" && declared ? { outputSchema: fieldSchema(declared, "outputs") } : {}) },
    context: { results, notes, answers, catalog: { agents: describe(manifest.agents), tools: describe(manifest.tools), plays: describe(manifest.plays) }, ...(review.length > 0 ? { review } : {}) },
    snapshotDigest: task.snapshot_digest,
    agent: {
      name: attempt.agent, promptDigest: agent.prompt.digest, engines: agent.engine, native: agent.native, modelInCommands: agent.model_in_commands,
      limits: { turns: agent.limits.turns, tokens: agent.limits.tokens, spendMicroUsd: microUsd(agent.limits.spend_usd) }, tools: agent.tools,
    },
    skills: (agent.skills ?? []).flatMap((name) => { const skill = manifest.skills?.[name]; return skill ? [{ name, description: skill.description, files: skill.files.map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes })) }] : []; }),
    tools, projects, inheritedStates: inherited,
    ...(gov.store && manifest.projects.length > 0 ? { store: { url: gov.store.url, goalId: task.root_id, token: signStoreGrant({ workspaceId: attempt.workspace_id, goalId: task.root_id, attemptId: attempt.id, expiresAt: Math.floor(gov.clock.nowMs() / 1000) + STORE_TOKEN_SECONDS }, gov.store.privateKeyPem) } } : {}),
    model: { gatewayUrl: `${gov.gatewayUrl}/model/v1`, routes: routesOf(gov, attempt.workspace_id, manifest, agent.model) },
    ...(payload.act ? { act: payload.act } : {}),
  };
}
