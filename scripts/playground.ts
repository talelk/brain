import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify, TomlDate } from "smol-toml";

/**
 * `pnpm playground`: creates (or brings up to date) the playground workspaces on a running Brain. Safe to repeat: a workspace that exists keeps its
 * history and gets this manifest's settings applied as one more commit.
 *
 * Environment: BRAIN_URL (default http://localhost:3100), BRAIN_ADMIN_EMAIL, BRAIN_ADMIN_PASSWORD, BRAIN_GITHUB_TOKEN (read from the
 * private credentials file by the caller), BRAIN_MODEL_URL, BRAIN_MODEL_NAME, optional BRAIN_MODEL_KEY, BRAIN_MODEL_INPUT_USD_PER_MTOK,
 * BRAIN_MODEL_OUTPUT_USD_PER_MTOK, BRAIN_MODEL_CONTEXT_TOKENS (the model's window, to compact before it), BRAIN_MODEL_COMPACT_AT, BRAIN_TIMEZONE (default Africa/Tunis).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`set ${name}`);
  return value;
};
const URL_ = env("BRAIN_URL", "http://localhost:3100").replace(/\/$/u, "");

interface Repo {
  readonly repo: string;
  readonly branch?: string;
  readonly setup?: string;
  readonly network?: readonly string[];
  readonly access?: "read" | "write";
}
interface Workspace {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly packs: readonly string[];
  /** The first project is made with the workspace; the others are added to brain.toml. */
  readonly projects?: readonly Repo[];
  readonly memory?: readonly string[];
  readonly limits?: { readonly daily_spend_usd: number; readonly running_tasks: number };
  readonly healing?: "off";
  /** The platform workspace: reads every other and proposes changes to them, which their admins approve (docs/model.md). */
  readonly platform?: "admin" | "read";
}

/** The containers the platform workspace may restart without waiting for a person: the web containers of the host, never Brain, the model or memory. The host's commands are open (any container), so this list is only what a standing approval covers. */
const RESTARTABLE = ["cvinsights-web-1", "health360-web-1", "kios-rh-new-1", "of-vue360-ai-app-1", "omniflow-docus-docus-1", "zain-docus-docus-1", "teknova-nao", "ps-insights-rill-1", "synthetic-api", "newqlik-query-1", "newqlik-build-1"];
const GH = (repo: string): string => `https://github.com/${repo}.git`;
const PLAYGROUND: readonly Workspace[] = [
  { slug: "sandbox", name: "Sandbox", description: "Where to try agents, tools and Plays safely: a throwaway repository, low spend caps, no healing.", packs: ["base", "software-factory", "frontend-qa"], projects: [{ repo: GH("talelk/playground-scratch") }], limits: { daily_spend_usd: 2, running_tasks: 1 }, healing: "off" },
  { slug: "brain-dev", name: "Brain development", description: "Brain on itself: issues triaged, ready-for-agent work built, changes reviewed.", packs: ["base", "software-factory"], projects: [{ repo: GH("talelk/brain"), setup: "pnpm install --frozen-lockfile" }] },
  { slug: "telco-orange", name: "Telco Orange", description: "The Orange customer 360 and selfcare work.", packs: ["base", "software-factory", "customer-operations"], projects: [{ repo: GH("keyrustunisie/of-vue360-ai"), setup: "bun install" }, { repo: GH("keyrustunisie/selfcare-obf") }] },
  { slug: "presales-rfp", name: "Presales and RFP", description: "Tenders, terms of reference, responses and leads. Documents only: its memory holds what it has learned, and the tender sources to watch.", packs: ["base", "presales"], memory: ["tender-sources"] },
  { slug: "data-bi", name: "Data and BI", description: "Associative BI, analytics and ETL lineage.", packs: ["base", "software-factory", "data-engineering"], projects: [{ repo: GH("talelk/newmoon") }, { repo: GH("talelk/kamaris") }, { repo: GH("keyrustunisie/mg-etl-intelligence") }] },
  { slug: "bff-platform", name: "BFF platform", description: "The configuration-aware customer BFF: Studio and runtime.", packs: ["base", "software-factory"], projects: [{ repo: GH("keyrustunisie/360v3"), setup: "bun install" }] },
  { slug: "kios-newrh", name: "Kios RH", description: "Workforce cost platform (Nuxt, Prisma).", packs: ["base", "software-factory"], projects: [{ repo: GH("keyrustunisie/kios-newrh"), branch: "master", setup: "pnpm install --frozen-lockfile" }] },
  { slug: "ops", name: "Ops", description: "The demos host: health, incidents, restarts.", packs: ["base", "sre"], memory: ["inventory", "monitoring", "runbook"] },
  { slug: "brain-admin", name: "Brain admin", description: "Optimizing the platform: its configuration, its workspaces and what they keep repeating. Reads every workspace; each change it proposes waits for an admin.", packs: ["base", "platform"], platform: "admin" },
];

let cookie = "";
async function call(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(URL_ + path, { method: "POST", headers: { "content-type": "application/json", origin: URL_, cookie }, body: JSON.stringify(body) });
  const set = response.headers.getSetCookie();
  if (set.length > 0) cookie = set.map((entry) => entry.split(";")[0]).join("; ");
  const text = await response.text();
  try { return JSON.parse(text) as unknown; } catch { return text; }
}
type Answer = { output?: unknown; error?: { code: string; message: string; problems?: unknown } };
const command = async (type: string, input: unknown): Promise<unknown> => {
  const answer = (await call("/v1/command", { type, input, idempotencyKey: crypto.randomUUID() })) as Answer;
  if (answer.error) throw new Error(`${type}: ${answer.error.message} ${JSON.stringify(answer.error.problems ?? "")}`);
  return answer.output;
};
const query = async (type: string, input: unknown = {}): Promise<unknown> => {
  const answer = (await call("/v1/query", { type, input })) as Answer;
  if (answer.error) throw new Error(`${type}: ${answer.error.message}`);
  return answer.output;
};

await call("/api/auth/sign-in/email", { email: env("BRAIN_ADMIN_EMAIL"), password: env("BRAIN_ADMIN_PASSWORD") });
const token = env("BRAIN_GITHUB_TOKEN");
const model = { name: "main", provider: "openai-compatible" as const, url: env("BRAIN_MODEL_URL"), model: env("BRAIN_MODEL_NAME"), ...(process.env["BRAIN_MODEL_KEY"] ? { key: process.env["BRAIN_MODEL_KEY"] } : {}) };
const prices = { in: process.env["BRAIN_MODEL_INPUT_USD_PER_MTOK"], out: process.env["BRAIN_MODEL_OUTPUT_USD_PER_MTOK"] };

// The Starter workspace made at setup gets the same model as the rest, so its sample goal runs.
const WITH_STARTER: readonly Workspace[] = [{ slug: "starter", name: "Starter", description: "", packs: ["base"] }, ...PLAYGROUND];
for (const entry of WITH_STARTER) {
  const known = ((await query("me")) as { workspaces: Array<{ id: string; slug: string }> }).workspaces.find((one) => one.slug === entry.slug);
  if (!known && entry.slug === "starter") continue;
  const [first, ...more] = entry.projects ?? [];
  // A read workspace of the platform pack is made without it and given the pack and the flag in brain.toml below.
  const created = entry.platform === "read" ? entry.packs.filter((name) => name !== "platform") : entry.packs;
  const id = known?.id ?? ((await command("workspace.create", {
    name: entry.name, slug: entry.slug, description: entry.description, packs: created, model, ...(entry.platform === "admin" ? { platform: "admin" } : {}),
    ...(first ? { project: { repo: first.repo, branch: first.branch ?? "main", access: first.access ?? "write", credential: token } } : {}),
  })) as { workspaceId: string }).workspaceId;
  if (known && first) await command("secret.set", { workspaceId: id, name: "github", value: token });
  if (known && process.env["BRAIN_MODEL_KEY"]) await command("secret.set", { workspaceId: id, name: "model-main", value: process.env["BRAIN_MODEL_KEY"] });

  const file = (await query("file.read", { workspaceId: id, path: "brain.toml" })) as { content: string };
  const config = parse(file.content) as Record<string, unknown> & { model?: Array<Record<string, unknown>>; project?: Array<Record<string, unknown>> };
  if (entry.slug === "starter" && !(config.model ?? []).length) config.model = [{ name: model.name, provider: model.provider, url: model.url, model: model.model }];
  config["packs"] = [...entry.packs];
  config["limits"] = { ...(config["limits"] as object | undefined), ...(entry.limits ?? { daily_spend_usd: 0, running_tasks: 0 }) };
  if (entry.healing) config["healing"] = { ...(config["healing"] as object | undefined), mode: entry.healing };
  if (entry.platform) config["platform"] = entry.platform;
  config["timezone"] = env("BRAIN_TIMEZONE", "Africa/Tunis");
  for (const one of config.model ?? []) {
    if (process.env["BRAIN_MODEL_CONTEXT_TOKENS"]) one["context_tokens"] = Number(process.env["BRAIN_MODEL_CONTEXT_TOKENS"]);
    if (process.env["BRAIN_MODEL_COMPACT_AT"]) one["compact_at"] = Number(process.env["BRAIN_MODEL_COMPACT_AT"]);
  }
  if (prices.in && prices.out) for (const one of config.model ?? []) { one["input_usd_per_mtok"] = Number(prices.in); one["output_usd_per_mtok"] = Number(prices.out); }
  const projects = config.project ?? [];
  for (const one of [first, ...more]) {
    if (!one) continue;
    const name = one.repo.replace(/\.git$/u, "").split("/").pop() ?? one.repo;
    let project = projects.find((existing) => existing["repo"] === one.repo);
    if (!project) {
      project = { name, repo: one.repo, branch: one.branch ?? "main", credential: "secret:github" };
      projects.push(project);
    }
    if (one.setup) project["setup"] = one.setup;
    // Open by default (docs/model.md): the network and write access are written only to limit them.
    if (one.network) project["network"] = [...one.network]; else delete project["network"];
    if (one.access === "read") project["access"] = "read"; else delete project["access"];
  }
  if (projects.length > 0) config.project = projects;
  if (entry.packs.includes("sre")) {
    // Self-healing: a restart of a named container needs no person, within a daily limit and until a date. A redeploy always waits for one.
    config["approvals"] = { "host.restart": { targets: RESTARTABLE, per_day: 3, until: new TomlDate("2027-02-28") } };
  }
  const files = [{ path: "brain.toml", content: stringify(config) }, ...(entry.memory ?? []).map((name) => ({ path: `memory/${name}.md`, content: readFileSync(join(HERE, "playground", `${name}.md`), "utf8") }))];
  await command("file.write", { workspaceId: id, files, message: known ? "Apply the playground manifest" : "Set up the playground workspace" });
  console.log(`${known ? "updated" : "created"}  ${entry.slug}  ${id}`);
}

// Deliver the packs shipped with this Brain: the admin workspace keeps an editable copy of each under packs/<name>/ and releases come from
// it, so a change to a shipped pack reaches the workspaces only through the copy. Each shipped pack is written into the copy (a file the pack
// no longer has is removed, and the copy's `version` line stays), a pack whose copy changed is released, and every workspace is moved to the
// latest release. Skipped when there is no admin workspace.
const admin = PLAYGROUND.find((entry) => entry.platform === "admin");
const adminId = admin ? ((await query("me")) as { workspaces: Array<{ id: string; slug: string }> }).workspaces.find((one) => one.slug === admin.slug)?.id : undefined;
if (adminId) {
  const root = join(HERE, "..", "packs");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
  const existing = ((await query("workspace.files", { workspaceId: adminId })) as { files: Array<{ path: string }> }).files.map((file) => file.path);
  const changed: string[] = [];
  for (const pack of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    const shipped = new Map<string, string>(walk(join(root, pack)).map((path) => [`packs/${pack}/${relative(join(root, pack), path).split(sep).join("/")}`, readFileSync(path, "utf8")]));
    const before = ((await query("pack.files", { workspaceId: adminId, name: pack, version: "working" }).catch(() => ({ files: [] }))) as { files: Array<{ path: string; content: string }> }).files;
    const version = /^version\s*=.*$/mu.exec(before.find((file) => file.path === "pack.toml")?.content ?? "")?.[0];
    const manifest = `packs/${pack}/pack.toml`;
    if (version && shipped.has(manifest)) shipped.set(manifest, shipped.get(manifest)!.replace(/^(name\s*=.*)$/mu, `$1\n${version}`));
    const writes = [...shipped].filter(([path, content]) => before.find((file) => `packs/${pack}/${file.path}` === path)?.content !== content);
    const removes = existing.filter((path) => path.startsWith(`packs/${pack}/`) && !shipped.has(path));
    if (writes.length === 0 && removes.length === 0) continue;
    await command("file.write", { workspaceId: adminId, files: writes.map(([path, content]) => ({ path, content })), remove: removes, message: `Deliver the shipped ${pack} pack` });
    changed.push(pack);
  }
  for (const pack of changed) console.log(`released  ${pack}  v${((await command("pack.release", { workspaceId: adminId, name: pack })) as { version: number }).version}`);
  const moved = (await command("packs.updateAll", { workspaceId: adminId })) as { updated: unknown[]; failed: Array<{ slug: string; message: string }> };
  console.log(`updated   ${moved.updated.length} workspaces${moved.failed.length > 0 ? `, failed: ${moved.failed.map((one) => one.slug).join(", ")}` : ""}`);
}
