import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify, TomlDate } from "smol-toml";

/**
 * `pnpm demos`: creates (or brings up to date) the demo workspaces on a running Brain. Safe to repeat: a workspace that exists keeps its
 * history and gets this manifest's settings applied as one more commit.
 *
 * Environment: BRAIN_URL (default http://localhost:3100), BRAIN_ADMIN_EMAIL, BRAIN_ADMIN_PASSWORD, BRAIN_GITHUB_TOKEN (read from the
 * private credentials file by the caller), BRAIN_MODEL_URL, BRAIN_MODEL_NAME, optional BRAIN_MODEL_KEY, BRAIN_MODEL_INPUT_USD_PER_MTOK,
 * BRAIN_MODEL_OUTPUT_USD_PER_MTOK, BRAIN_TIMEZONE (default Africa/Tunis).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`set ${name}`);
  return value;
};
const URL_ = env("BRAIN_URL", "http://localhost:3100").replace(/\/$/u, "");

interface Demo {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly packs: readonly string[];
  readonly repo?: string;
  readonly branch?: string;
  readonly setup?: string;
  readonly network?: readonly string[];
  readonly memory?: readonly string[];
}

/** The containers the platform workspace may restart without waiting for a person: the demos' own web containers, never Brain, the model or memory. */
const RESTARTABLE = ["cvinsights-web-1", "health360-web-1", "kios-rh-new-1", "of-vue360-ai-app-1", "omniflow-docus-docus-1", "zain-docus-docus-1", "teknova-nao", "ps-insights-rill-1", "synthetic-api", "newqlik-query-1", "newqlik-build-1"];
const GH = (repo: string): string => `https://github.com/${repo}.git`;
const DEMOS: readonly Demo[] = [
  { slug: "kios-newrh", name: "Kios RH", description: "Workforce cost platform (Nuxt, Prisma).", packs: ["base", "software-factory"], repo: GH("keyrustunisie/kios-newrh"), branch: "master", setup: "pnpm install --frozen-lockfile", network: ["registry.npmjs.org"] },
  { slug: "ai-teknova-demo", name: "Teknova analytics", description: "Analytics agent demo on a synthetic retailer (dbt, DuckDB).", packs: ["base", "software-factory"], repo: GH("keyrustunisie/ai-teknova-demo"), branch: "main", network: ["pypi.org", "files.pythonhosted.org"] },
  { slug: "of-synthetic", name: "Synthetic monitoring", description: "Mobile synthetic-monitoring service (Bun, Hono).", packs: ["base", "software-factory"], repo: GH("keyrustunisie/of-synthetic"), branch: "main", setup: "bun install", network: ["registry.npmjs.org"] },
  { slug: "of-vue360-ai", name: "Omniflow 360", description: "Telco customer 360 with a deterministic diagnosis (Bun, Hono).", packs: ["base", "software-factory"], repo: GH("keyrustunisie/of-vue360-ai"), branch: "main", setup: "bun install", network: ["registry.npmjs.org"] },
  { slug: "omniflow-docus", name: "Omniflow docs", description: "Documentation site (Docus).", packs: ["base", "software-factory"], repo: GH("keyrustunisie/omniflow-docus"), branch: "main", setup: "npm ci", network: ["registry.npmjs.org"] },
  { slug: "zain-docus", name: "Zain docs", description: "Documentation site for Zain (Docus).", packs: ["base", "software-factory"], repo: GH("keyrustunisie/zain-docus"), branch: "main", setup: "npm ci", network: ["registry.npmjs.org"] },
  { slug: "brain", name: "Brain", description: "Brain's own code.", packs: ["base", "software-factory"], repo: GH("talelk/brain"), branch: "main", setup: "pnpm install --frozen-lockfile", network: ["registry.npmjs.org"] },
  { slug: "demos-platform", name: "Demos platform", description: "The demos server: health, incidents, restarts.", packs: ["base", "sre"], memory: ["inventory", "monitoring", "runbook"] },
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

// The Starter workspace made at setup gets the same model as the demos, so its sample goal runs.
const DEMOS_AND_STARTER: readonly Demo[] = [{ slug: "starter", name: "Starter", description: "", packs: ["base"] }, ...DEMOS];
for (const demo of DEMOS_AND_STARTER) {
  const known = ((await query("me")) as { workspaces: Array<{ id: string; slug: string }> }).workspaces.find((entry) => entry.slug === demo.slug);
  if (!known && demo.slug === "starter") continue;
  const id = known?.id ?? ((await command("workspace.create", {
    name: demo.name, slug: demo.slug, description: demo.description, packs: demo.packs, model,
    ...(demo.repo ? { project: { repo: demo.repo, branch: demo.branch ?? "main", access: "write", credential: token } } : {}),
  })) as { workspaceId: string }).workspaceId;
  if (known && demo.repo) await command("secret.set", { workspaceId: id, name: "github", value: token });
  if (known && process.env["BRAIN_MODEL_KEY"]) await command("secret.set", { workspaceId: id, name: "model-main", value: process.env["BRAIN_MODEL_KEY"] });

  const file = (await query("file.read", { workspaceId: id, path: "brain.toml" })) as { content: string };
  const config = parse(file.content) as Record<string, unknown> & { model?: Array<Record<string, unknown>>; project?: Array<Record<string, unknown>> };
  if (demo.slug === "starter" && !(config.model ?? []).length) config.model = [{ name: model.name, provider: model.provider, url: model.url, model: model.model }];
  config["limits"] = { ...(config["limits"] as object | undefined), daily_spend_usd: 0, running_tasks: 0 };
  config["timezone"] = env("BRAIN_TIMEZONE", "Africa/Tunis");
  if (prices.in && prices.out) for (const entry of config.model ?? []) { entry["input_usd_per_mtok"] = Number(prices.in); entry["output_usd_per_mtok"] = Number(prices.out); }
  for (const project of config.project ?? []) {
    if (demo.setup) project["setup"] = demo.setup;
    if (demo.network) project["network"] = [...demo.network];
  }
  if (demo.packs.includes("sre")) {
    // Self-healing: a restart of a named demo container needs no person, within a daily limit and until a date. A redeploy always waits for one.
    config["approvals"] = { "host.restart": { targets: RESTARTABLE, per_day: 3, until: new TomlDate("2027-02-28") } };
  }
  const files = [{ path: "brain.toml", content: stringify(config) }, ...(demo.memory ?? []).map((name) => ({ path: `memory/${name}.md`, content: readFileSync(join(HERE, "demos", `${name}.md`), "utf8") }))];
  await command("file.write", { workspaceId: id, files, message: known ? "Apply the demo manifest" : "Set up the demo workspace" });
  console.log(`${known ? "updated" : "created"}  ${demo.slug}  ${id}`);
}
