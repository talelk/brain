import { localModelConfigured, localModelTestedAt, localRunnerSettingsCurrent } from "./local-runtime";
import type { ActorContext, Agent, OperationalReadiness, Resources, Workflow } from "@brain/contracts";
import type { Store } from "../../application/store";
import { activeReleaseRecord } from "../configuration/index";
import { requireWorkspaceRead } from "../../application/authz";
import { runnerView } from "../jobs/index";
import { evaluateRunner } from "../../domain/placement";

export function operationalReadiness(s: Store, actor: ActorContext, workspaceId: string): OperationalReadiness {
  requireWorkspaceRead(s, actor, workspaceId);
  const checks: OperationalReadiness["checks"][number][] = [];
  const modelConfigured = localModelConfigured(s, actor.organizationId);
  if (modelConfigured !== null) checks.push({ id: "model", action: "model", status: modelConfigured ? "ready" : "missing", detail: modelConfigured ? "Local model connection configured" : "Connect a model to run the starter tasks", nextAction: "Open Administration → Setup" });
  const row = activeReleaseRecord(s, actor.organizationId);
  checks.push({ id: "release", action: "release", status: row ? "ready" : "missing", detail: row?.digest ?? "No active configuration release", nextAction: row ? "Inspect Agents and Workflows" : "Compile, inspect, and activate examples/v1/starter-release" });
  const release = { agents: row?.release.agents ?? {} as Record<string, Agent>, workflows: row?.release.workflows ?? {} as Record<string, Workflow> };
  const runners = (s.control.prepare("SELECT id FROM runners WHERE organization_id=?").all(actor.organizationId) as { id: string }[]).map(({ id }) => runnerView(s,id)).filter((view) => view !== undefined).filter((view) => localRunnerSettingsCurrent(s, actor.organizationId, view.id));
  const idle: Resources = { cpuMillicores: 0, memoryMb: 0, diskMb: 0, slots: 0 };
  for (const [id, workflow] of Object.entries(release.workflows)) {
    const missing: string[] = [];
    let busy: { slotsInUse: number; slotsTotal: number } | undefined;
    for (const step of Object.values(workflow.spec.jobs)) {
      if (step.kind !== "dispatch" && step.kind !== "eval") continue;
      const agent = step.kind === "dispatch" && step.uses.type === "agent" ? release.agents[step.uses.release.id] : undefined;
      const placement = { ...step.runsOn, ...(agent ? { engine: agent.spec.engine } : {}) };
      // Capability is judged against an idle runner: a runner that is merely busy still exists and will take the work next.
      const capable = runners.filter((runner) => evaluateRunner(placement, placement.resources, { ...runner, reserved: idle }, s.now()).eligible);
      if (!capable.length) { missing.push(`${placement.group}${agent ? ` with ${agent.spec.engine.anyOf.join(" or ")}` : ""}`); continue; }
      if (capable.some((runner) => evaluateRunner(placement, placement.resources, runner, s.now()).eligible)) continue;
      const inUse = capable.reduce((sum, runner) => sum + runner.reserved.slots, 0), total = capable.reduce((sum, runner) => sum + runner.capacity.slots, 0);
      if (!busy || inUse >= busy.slotsInUse) busy = { slotsInUse: inUse, slotsTotal: total };
    }
    const detail = missing.length ? `No online capable runner: ${[...new Set(missing)].join(", ")}` : busy ? `busy: ${busy.slotsInUse} of ${busy.slotsTotal} slots in use; new work queues and starts next` : "Agent/model requirements and runner placement are available";
    checks.push({ id: `workflow:${id}`, workflowId: id, action: missing.length ? "runners" : "task", status: missing.length ? "missing" : "ready", detail, nextAction: missing.length ? "Start the required runner group and check engine/model connectivity" : `Dispatch ${id}`, ...(!missing.length && busy ? { busy } : {}) });
  }
  if (!Object.keys(release.workflows).length) checks.push({ id: "workflows", action: "release", status: "missing", detail: "No workflows are available", nextAction: "Activate the starter release" });
  const ws = s.workspaceDb(workspaceId,actor.organizationId);
  const smoke = ws.prepare("SELECT r.id,r.state,r.created_at_ms FROM workflow_runs r JOIN run_inputs i ON i.run_id=r.id WHERE json_extract(i.workflow_json,'$.metadata.id')='agent-smoke' AND r.config_digest=? ORDER BY r.created_at_ms DESC LIMIT 1").get(row?.digest ?? "") as { id: string; state: string; created_at_ms: number } | undefined;
  const testedAt = localModelTestedAt(s, actor.organizationId) ?? 0;
  const smokeRan = smoke?.state === "succeeded" && smoke.created_at_ms >= testedAt;
  // Any task that finished verified (a work item reaches done only with accepted evidence) proves the model, a runner and the validator work together as well as the smoke run does.
  const provenByWork = !smokeRan && ws.prepare("SELECT 1 AS ok FROM work_items WHERE state='done' AND updated_at_ms>=? LIMIT 1").get(testedAt) !== undefined;
  const smokeVerified = smokeRan || provenByWork;
  checks.push({ id: "smoke", action: "smoke", workflowId: "agent-smoke", status: smokeVerified ? "ready" : "unverified", detail: provenByWork ? "A finished, verified task proves this connection" : smoke ? smokeVerified ? `${smoke.id}: verified for the current connection` : `${smoke.id}: ${smoke.state}; a verified test for the current connection is still required` : "No accepted smoke run for this release", nextAction: "Run agent-smoke with message BRAIN_OK and inspect independent evidence" });
  return { workspaceId, configDigest: row?.digest ?? null, ready: checks.every((check) => check.status === "ready"), smokeVerified, checks, memoryMode: process.env["BRAIN_TENCENTDB_URL"] ? "remote" : "local", asOf: s.nowIso() };
}
