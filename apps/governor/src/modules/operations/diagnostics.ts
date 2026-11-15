import { createRequire } from "node:module";
import type { ActorContext, RedactedDiagnostics } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { failureCode, redactSecrets } from "../../domain/failure-reason";
import { engineHealth, loadSchemaSql, schemaDigest } from "../../infrastructure/persistence/open";
import { listRunners } from "../jobs/index";
import { backupStatus, restoreTestStatus } from "./backup-status";
import { readProbes } from "./probes";
import { operationalReadiness } from "./readiness";
import { replicaConfig, replicaLag } from "./replica";

/**
 * The redacted diagnostics bundle (spec #90, story 96): what support needs to diagnose a problem and nothing that could hurt if the file
 * is forwarded. It is built by listing what may leave, field by field, from the Governor's own records: never by copying a record and
 * removing secrets from it, and never from the environment or a configuration object. Text an agent, a runner or a person wrote (a task's
 * failure diagnostic, an attempt's error text, titles, messages) is not in it at all: failures appear as codes and ids. The few sentences
 * the Governor itself wrote (health checks, readiness) still pass through the credential redactor, as a second line of defence.
 */
const BUNDLE_FORMAT = "brain.redacted-diagnostics/v2";
const RECENT_LIMIT = 25;
const RECENT_TOTAL = 100;
const SENTENCE = 400;

const packageVersion = (): string => {
  try { return String((createRequire(import.meta.url)("../../../package.json") as { version?: unknown }).version ?? "unknown"); } catch { return "unknown"; }
};
/** A sentence the Governor wrote, safe to forward: credentials hidden, cut short. */
const sentence = (text: string): string => redactSecrets(text).slice(0, SENTENCE);
const iso = (ms: number): string => new Date(ms).toISOString();

type RecentError = RedactedDiagnostics["recentErrors"][number];

/** What went wrong lately in the requested workspace and on the platform: failed health checks, failed tasks (by class) and ended-badly attempts (by code). */
function recentErrors(s: Store, organizationId: string, workspaceId: string): RecentError[] {
  const out: RecentError[] = [];
  for (const probe of readProbes(s)) {
    if (probe.status !== "degraded" && probe.status !== "unavailable") continue;
    if (probe.id.startsWith("hosted:") && probe.id !== `hosted:${workspaceId}`) continue;
    out.push({ at: probe.checkedAt, source: "health-check", code: probe.id, status: probe.status, detail: sentence(probe.detail) });
  }
  const tasks = s.workspaceDb(workspaceId, organizationId)
    .prepare("SELECT run_id, work_item_id, mission_id, failure_class, remedy, created_at_ms FROM task_failures ORDER BY created_at_ms DESC LIMIT ?").all(RECENT_LIMIT) as Array<{ run_id: string; work_item_id: string; mission_id: string; failure_class: string; remedy: string; created_at_ms: number }>;
  for (const row of tasks) out.push({ at: iso(row.created_at_ms), source: "task", code: row.failure_class, remedy: row.remedy, workspaceId, missionId: row.mission_id, workItemId: row.work_item_id, runId: row.run_id });
  // An attempt carries no creation time: its last lease expiry is when it last ran.
  const attempts = s.control.prepare(`SELECT a.id AS attempt_id, a.job_id, a.state, a.failure_reason, a.lease_expires_at_ms, j.workflow_run_id
      FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.organization_id=? AND j.workspace_id=? AND a.state IN ('failed','expired','outcome_unknown')
      ORDER BY a.lease_expires_at_ms DESC LIMIT ?`).all(organizationId, workspaceId, RECENT_LIMIT) as Array<{ attempt_id: string; job_id: string; state: string; failure_reason: string | null; lease_expires_at_ms: number; workflow_run_id: string }>;
  for (const row of attempts) out.push({ at: iso(row.lease_expires_at_ms), source: "attempt", code: row.failure_reason ? failureCode(row.failure_reason) : row.state, status: row.state, workspaceId, runId: row.workflow_run_id, jobId: row.job_id, attemptId: row.attempt_id });
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_TOTAL);
}

interface ReportedRunner {
  runnerId: string; group: string; adminState: string; connectivity: string; health: string; lastSeenAt: string;
  capacity: { cpuMillicores: number; memoryMb: number; diskMb: number; slots: number };
  engines: Array<{ id: string; version?: string; adapterDigest: string; features: string[] }>;
  capabilities: Array<{ capability: string; source: string; observedAt: string; verified: boolean }>;
}

/** The runner inventory: each runner as it reported itself (engines exactly as reported, no version when none was) and as the Governor observed it. */
function runnerInventory(s: Store, actor: ActorContext): RedactedDiagnostics["runners"] {
  const items = (listRunners(s, actor, 200) as unknown as { items: ReportedRunner[] }).items;
  return items.map((runner) => ({
    runnerId: runner.runnerId, group: runner.group, adminState: runner.adminState, connectivity: runner.connectivity, health: runner.health, lastSeenAt: runner.lastSeenAt,
    capacity: { cpuMillicores: runner.capacity.cpuMillicores, memoryMb: runner.capacity.memoryMb, diskMb: runner.capacity.diskMb, slots: runner.capacity.slots },
    engines: runner.engines.map((engine) => ({ id: engine.id, ...(typeof engine.version === "string" ? { version: engine.version } : {}), adapterDigest: engine.adapterDigest, features: [...engine.features] })),
    capabilities: runner.capabilities.map((capability) => ({ capability: capability.capability, source: capability.source, observedAt: capability.observedAt, verified: capability.verified === true })),
  }));
}

export function diagnosticsBundle(s: Store, actor: ActorContext, workspaceId: string, correlationId: string, env: NodeJS.ProcessEnv = process.env): RedactedDiagnostics {
  if (actor.kind !== "human" || !actor.scopes.includes("config:activate") || !actor.scopes.includes("runner:admin")) throw new BrainDomainError("FORBIDDEN", "Diagnostics export requires organization administration");
  const readiness = operationalReadiness(s, actor, workspaceId);
  const now = s.now();
  const lag = replicaLag(replicaConfig(env), now);
  return {
    format: BUNDLE_FORMAT, exportedAt: s.nowIso(), correlationId, workspaceId,
    versions: {
      governor: packageVersion(), node: process.version, sqlite: engineHealth(s.control).version,
      controlSchema: schemaDigest(loadSchemaSql("control.sql")), workspaceSchema: schemaDigest(loadSchemaSql("workspace.sql")),
      commandContract: "brain.command/v1", runnerContract: "brain.runner/v1",
    },
    configDigest: readiness.configDigest, ready: readiness.ready, smokeVerified: readiness.smokeVerified, memoryMode: readiness.memoryMode,
    checks: readiness.checks.map((check) => ({ id: check.id, status: check.status, ...(check.action ? { action: check.action } : {}), detail: sentence(check.detail) })),
    services: readProbes(s).filter((probe) => !probe.id.startsWith("hosted:") || probe.id === `hosted:${workspaceId}`).map((probe) => ({ id: probe.id, status: probe.status, checkedAt: probe.checkedAt, detail: sentence(probe.detail) })),
    runners: runnerInventory(s, actor),
    backups: { backup: backupStatus(now, env), restoreTest: restoreTestStatus(now, env), replica: { status: lag.status, detail: sentence(lag.detail), lagSeconds: lag.lagSeconds } },
    recentErrors: recentErrors(s, actor.organizationId, workspaceId),
  };
}
