import { localModelConfigured, localModelTestedAt, localRunnerSettingsCurrent } from "./local-runtime";
import type { ActorContext, Agent, OperationalReadiness, Workflow } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { runnerView } from "../jobs/index";
import { evaluateRunner } from "../../domain/placement";

export function operationalReadiness(s: Store, actor: ActorContext, workspaceId: string): OperationalReadiness {
  requireWorkspaceRead(s, actor, workspaceId);
  const checks: OperationalReadiness["checks"][number][] = [];
  const modelConfigured = localModelConfigured(s, actor.organizationId);
  if (modelConfigured !== null) checks.push({ id: "model", action: "model", status: modelConfigured ? "ready" : "missing", detail: modelConfigured ? "Local model connection configured" : "Connect a model to run the starter tasks", nextAction: "Open Administration → Setup" });
  const row = s.control.prepare("SELECT r.digest,r.manifest_json FROM active_config a JOIN config_releases r ON r.digest=a.release_digest WHERE a.organization_id=?").get(actor.organizationId) as { digest: string; manifest_json: string } | undefined;
  checks.push({ id: "release", action: "release", status: row ? "ready" : "missing", detail: row?.digest ?? "No active configuration release", nextAction: row ? "Inspect Agents and Workflows" : "Compile, inspect, and activate examples/v1/starter-release" });
  const release = row ? JSON.parse(row.manifest_json) as { agents: Record<string, Agent>; workflows: Record<string, Workflow> } : { agents: {}, workflows: {} };
  const runners = (s.control.prepare("SELECT id FROM runners WHERE organization_id=?").all(actor.organizationId) as { id: string }[]).map(({ id }) => runnerView(s,id)).filter((view) => view !== undefined).filter((view) => localRunnerSettingsCurrent(s, actor.organizationId, view.id));
  for (const [id, workflow] of Object.entries(release.workflows)) {
    const missing: string[] = [];
    for (const step of Object.values(workflow.spec.jobs)) {
      if (step.kind !== "dispatch" && step.kind !== "eval") continue;
      const agent = step.kind === "dispatch" && step.uses.type === "agent" ? release.agents[step.uses.release.id] : undefined;
      const placement = { ...step.runsOn, ...(agent ? { engine: agent.spec.engine } : {}) };
      if (!runners.some((runner) => evaluateRunner(placement,placement.resources,runner,s.now()).eligible)) missing.push(`${placement.group}${agent ? ` with ${agent.spec.engine.anyOf.join(" or ")}` : ""}`);
    }
    checks.push({ id: `workflow:${id}`, workflowId: id, action: missing.length ? "runners" : "task", status: missing.length ? "missing" : "ready", detail: missing.length ? `No online capable runner: ${[...new Set(missing)].join(", ")}` : "Agent/model requirements and runner placement are available", nextAction: missing.length ? "Start the required runner group and check engine/model connectivity" : `Dispatch ${id}` });
  }
  if (!Object.keys(release.workflows).length) checks.push({ id: "workflows", action: "release", status: "missing", detail: "No workflows are available", nextAction: "Activate the starter release" });
  const ws = s.workspaceDb(workspaceId,actor.organizationId);
  const hasRuns = ws.prepare("SELECT 1 FROM sqlite_master WHERE name='run_inputs'").get();
  const smoke = hasRuns ? ws.prepare("SELECT r.id,r.state,r.created_at_ms FROM workflow_runs r JOIN run_inputs i ON i.run_id=r.id WHERE json_extract(i.workflow_json,'$.metadata.id')='agent-smoke' AND r.config_digest=? ORDER BY r.created_at_ms DESC LIMIT 1").get(row?.digest ?? "") as { id: string; state: string; created_at_ms: number } | undefined : undefined;
  const smokeVerified = smoke?.state === "succeeded" && smoke.created_at_ms >= (localModelTestedAt(s, actor.organizationId) ?? 0);
  checks.push({ id: "smoke", action: "smoke", workflowId: "agent-smoke", status: smokeVerified ? "ready" : "unverified", detail: smoke ? smokeVerified ? `${smoke.id}: verified for the current connection` : `${smoke.id}: ${smoke.state}; a verified test for the current connection is still required` : "No accepted smoke run for this release", nextAction: "Run agent-smoke with message BRAIN_OK and inspect independent evidence" });
  return { workspaceId, configDigest: row?.digest ?? null, ready: checks.every((check) => check.status === "ready"), smokeVerified, checks, memoryMode: process.env["BRAIN_TENCENTDB_URL"] ? "remote" : "local", asOf: s.nowIso() };
}
