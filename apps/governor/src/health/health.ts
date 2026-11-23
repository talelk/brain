import { modelsOf } from "../workspace/platform";
import { secretName, type Health } from "@brain/contracts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Governor } from "../app";
import { listRunners } from "../attempts/runners";
import type { Gov } from "../dispatch";
import { verify } from "../trust/audit";
import { readSecret } from "../trust/secrets";
import { lastPush } from "../workspace/push";
import { activeManifest } from "../workspace/store";

/** What the Health screen shows (docs/architecture.md section 10): runners, whether each model answers, the state of the audit log, and the last backup. */
const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const FRESH_FOR_MS = 60_000;
type ModelHealth = Omit<Health["models"][number], "priced">;
const probes = new WeakMap<Gov, Map<string, { at: number; answer: ModelHealth }>>();
const audits = new WeakMap<Gov, { at: number; problem: string | null }>();

/** Asks a model server for its list of models: any answer but a refusal of the key or a server error means it is reachable. */
async function probe(gov: Gov, workspaceId: string, model: ReturnType<typeof activeManifest>["models"][number]): Promise<ModelHealth> {
  const key = model.key ? readSecret(gov, workspaceId, secretName(model.key)) : undefined;
  if (model.key && key === undefined) return { name: model.name, reachable: false, detail: `The secret ${secretName(model.key)} is not set` };
  const base = model.url.replace(/\/+$/u, "");
  try {
    const response = model.provider === "anthropic"
      ? await gov.fetch(`${base.replace(/\/v1$/u, "")}/v1/models`, { headers: { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }, signal: AbortSignal.timeout(4_000) })
      : await gov.fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4_000) });
    const refused = response.status === 401 || response.status === 403;
    return { name: model.name, reachable: !refused && response.status < 500, detail: refused ? "The model server refused the key" : response.status >= 500 ? `The model server answered ${response.status}` : "" };
  } catch {
    return { name: model.name, reachable: false, detail: "The model server did not answer" };
  }
}

/** Whether a model answers, asked at most once a minute. */
export function modelHealth(gov: Gov, workspaceId: string, model: ReturnType<typeof activeManifest>["models"][number], now: number): Promise<ModelHealth> {
  const known = probes.get(gov) ?? new Map<string, { at: number; answer: ModelHealth }>();
  probes.set(gov, known);
  const id = `${workspaceId}\n${model.name}\n${model.url}`;
  const recent = known.get(id);
  if (recent && now - recent.at < FRESH_FOR_MS) return Promise.resolve(recent.answer);
  return probe(gov, workspaceId, model).then((answer) => { known.set(id, { at: now, answer }); return answer; });
}

/** The first problem the audit log's verification found, or null; verifying reads the whole log, so one verification serves a minute of readers. */
export function auditProblem(gov: Gov, now: number): string | null {
  let audit = audits.get(gov);
  if (!audit || now - audit.at >= FRESH_FOR_MS) {
    const result = verify(gov.db);
    audits.set(gov, (audit = { at: now, problem: result.ok ? null : (result.break?.detail ?? "The audit log does not verify") }));
  }
  return audit.problem;
}

export function registerHealth({ gov, app }: Governor): void {
  // The container's health check: the process answers and its database reads.
  app.get("/health/ready", (c) => {
    gov.db.prepare("SELECT 1").get();
    return c.json({ ready: true });
  });

  gov.registry.query("health", async (ctx, input) => {
    const now = ctx.now();
    const manifest = activeManifest(gov, input.workspaceId);
    const own = modelsOf(gov, input.workspaceId, manifest);
    const models = await Promise.all(own.models.map(async (model) => ({ ...(await modelHealth(gov, own.from?.id ?? input.workspaceId, model, now)), priced: model.input_usd_per_mtok !== undefined || model.output_usd_per_mtok !== undefined })));
    const marker = join(gov.dataDir, "backup.marker");
    return {
      version: VERSION, runners: listRunners(gov).map((runner) => (ctx.user?.instanceAdmin ? runner : { ...runner, engines: [], capabilities: [] })), models,
      audit: {
        events: (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get() as { n: number }).n,
        lastCheckpointAt: (ctx.db.prepare("SELECT MAX(created_at_ms) AS at FROM audit_checkpoints").get() as { at: number | null }).at, problem: auditProblem(gov, now),
      },
      // The backup command leaves this file; its time is when the last backup finished.
      backup: { lastAt: existsSync(marker) ? Math.round(statSync(marker).mtimeMs) : null },
      ...(manifest.git ? { folderPush: lastPush(gov, input.workspaceId) } : {}),
    };
  });
}
