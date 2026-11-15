import { COST_TIERS, MAX_MODEL_ROUTES, ROUTE_NAME, isKeyReference, type ActorContext, type CostTier, type JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import { ceilingPreset } from "../domain/mission-policy";
import { activeReleaseRecord } from "../modules/configuration/index";
import { drainStatus, modelRoutesOf, modelRoutesUsable, queueLimitOf, routeCooldownUntil, routeProbeId, routeUsable, setDraining, setQueueLimit } from "../modules/jobs/index";
import { wayOfWorking, workflowAgentTools } from "../modules/missions/index";
import { readProbes } from "../modules/operations/index";
import { effectAllowList, normalizeEgressHost } from "../modules/governance/index";
import { requireWorkspaceRead } from "./authz";
import type { CommandHandlers } from "./command-funnel";
import type { Store } from "./store";

/** Tools that read or run things on a host: a workspace that uses them stays self-hosted (ADR 0021, ADR 0023). */
const HOST_TOOL = /^host\./u;

function requireAdmin(actor: ActorContext, what: string): void {
  if (actor.kind !== "human" || !actor.scopes.includes("config:activate")) throw new BrainDomainError("FORBIDDEN", `${what} is set by organization administration`);
}

/** The hosted model credentials rule: an address names a place, never a person or a secret. */
function hostedUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BrainDomainError("INVALID_ARGUMENT", "Enter the hosted model's address as an absolute https URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new BrainDomainError("INVALID_ARGUMENT", "The hosted model address must be an https URL without credentials or a query; the API key is set on the runner host, never here");
  return url.href.replace(/\/$/u, "");
}

/** Whether the workspace's way of working reads production hosts: such a workspace may not send anything to a hosted model. */
function usesHostTools(store: Store, organizationId: string, workspaceId: string): boolean {
  const defaults = wayOfWorking(store, workspaceId);
  if (!defaults) return false;
  return defaults.requiredTools.some((tool) => HOST_TOOL.test(tool)) || (workflowAgentTools(store, organizationId, defaults.workflowId) ?? []).some((tool) => HOST_TOOL.test(tool));
}

/**
 * Engine settings an owner makes: the workspace's default way of working (ADR 0022), its model routes (ADR 0023, ADR 0055), its queue limit (ADR 0040) and the platform's
 * drain mode (deploys that do not interrupt work). All of them are control.db authority and commit with their receipt.
 */
export function engineSettingsCommands(store: Store): CommandHandlers {
  const s = store;
  return {
    "workspace.wayOfWorking.set": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        requireAdmin(actor, "the default way of working");
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const workflowId = String(cmd.payload["workflowId"]);
        const tools = [...new Set((cmd.payload["requiredTools"] as string[] | undefined) ?? [])].sort();
        const have = workflowAgentTools(s, actor.organizationId, workflowId);
        if (have === undefined) throw new BrainDomainError("NOT_FOUND", `workflow ${workflowId} is not in the active release`);
        const missing = tools.filter((tool) => !have.includes(tool));
        if (missing.length > 0) throw new BrainDomainError("INVALID_ARGUMENT", `${workflowId} lacks ${missing.join(", ")}: its agent has ${have.join(", ") || "no tools"}`);
        if (modelRoutesUsable(s, workspaceId) && (tools.some((tool) => HOST_TOOL.test(tool)) || have.some((tool) => HOST_TOOL.test(tool)))) {
          throw new BrainDomainError("CONFLICT", "this workspace uses model routes; a way of working that reads hosts must stay self-hosted. Switch its routes off first");
        }
        s.control.prepare(`INSERT INTO workspace_way_of_working(workspace_id,organization_id,workflow_id,required_tools_json,updated_by,updated_at_ms) VALUES (?,?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET workflow_id=excluded.workflow_id,required_tools_json=excluded.required_tools_json,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
          .run(workspaceId, actor.organizationId, workflowId, JSON.stringify(tools), actor.actorId, s.now());
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.wayOfWorkingSet", payload: { workspaceId, workflowId, requiredTools: tools } });
        return { resourceId: workspaceId };
      },
    },
    "workspace.modelRoutes.set": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        requireAdmin(actor, "the model routes");
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const given = cmd.payload["routes"] as Array<Record<string, unknown>>;
        if (given.length > MAX_MODEL_ROUTES) throw new BrainDomainError("INVALID_ARGUMENT", `A workspace holds at most ${MAX_MODEL_ROUTES} model routes`);
        const seen = new Set<string>();
        const routes = given.map((entry) => {
          const routeId = String(entry["routeId"] ?? "").trim();
          if (!ROUTE_NAME.test(routeId)) throw new BrainDomainError("INVALID_ARGUMENT", "A route's name is lowercase letters, digits and dashes, starting with a letter");
          if (seen.has(routeId)) throw new BrainDomainError("INVALID_ARGUMENT", `Two routes are named ${routeId}`);
          seen.add(routeId);
          const keyRef = String(entry["keyRef"] ?? "").trim();
          if (!isKeyReference(keyRef)) throw new BrainDomainError("INVALID_ARGUMENT", `Route ${routeId}: name the API key by a short reference such as acme-main, never the key itself; the key is set on the runner host as BRAIN_MODEL_KEY_<REFERENCE>, or on the Governor host for a route through the gateway`);
          const costTier = String(entry["costTier"] ?? "") as CostTier;
          if (!COST_TIERS.includes(costTier)) throw new BrainDomainError("INVALID_ARGUMENT", `Route ${routeId}: choose a cost tier (${COST_TIERS.join(", ")})`);
          const route = {
            routeId, enabled: entry["enabled"] === true, vendor: String(entry["vendor"] ?? "").trim(), keyRef, model: String(entry["model"] ?? "").trim(), baseUrl: hostedUrl(String(entry["baseUrl"] ?? "")), costTier,
            inputMicroUsdPerMTok: Number(entry["inputMicroUsdPerMTok"]), outputMicroUsdPerMTok: Number(entry["outputMicroUsdPerMTok"]),
            viaGateway: entry["viaGateway"] === true,
          };
          if (!route.vendor || !route.model) throw new BrainDomainError("INVALID_ARGUMENT", `Route ${routeId}: choose the vendor and the model`);
          // A route is always priced: its spend must reach the mission and workspace dollar caps (ADR 0023).
          if (!(route.inputMicroUsdPerMTok >= 1) || !(route.outputMicroUsdPerMTok >= 1)) throw new BrainDomainError("INVALID_ARGUMENT", `Route ${routeId}: set the input and output token prices (micro-USD per million tokens) so its spend counts against the dollar caps`);
          return route;
        });
        // ADR 0023 limit: redaction of host output is pattern based, so a workspace that reads production hosts stays self-hosted.
        if (routes.some((route) => route.enabled) && usesHostTools(s, actor.organizationId, workspaceId)) throw new BrainDomainError("CONFLICT", "this workspace reads production hosts; it stays self-hosted");
        {
          s.control.prepare("DELETE FROM workspace_model_routes WHERE workspace_id=?").run(workspaceId);
          const insert = s.control.prepare(`INSERT INTO workspace_model_routes(workspace_id,route_id,organization_id,position,enabled,vendor,key_ref,model,base_url,cost_tier,input_micro_usd_per_mtok,output_micro_usd_per_mtok,via_gateway,updated_by,updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          routes.forEach((route, position) => { insert.run(workspaceId, route.routeId, actor.organizationId, position, route.enabled ? 1 : 0, route.vendor, route.keyRef, route.model, route.baseUrl, route.costTier, route.inputMicroUsdPerMTok, route.outputMicroUsdPerMTok, route.viaGateway ? 1 : 0, actor.actorId, s.now()); });
          // A route that is gone loses its cooldown; one that stays keeps it (a reorder never forgives an account that is out of quota).
          for (const row of s.control.prepare("SELECT route_id FROM model_route_cooldowns WHERE workspace_id=?").all(workspaceId) as Array<{ route_id: string }>) {
            if (!seen.has(row.route_id)) s.control.prepare("DELETE FROM model_route_cooldowns WHERE workspace_id=? AND route_id=?").run(workspaceId, row.route_id);
          }
        }
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.modelRoutesSet", payload: { workspaceId, routes: routes.map((route) => ({ routeId: route.routeId, enabled: route.enabled, vendor: route.vendor, keyRef: route.keyRef, model: route.model, costTier: route.costTier, inputMicroUsdPerMTok: route.inputMicroUsdPerMTok, outputMicroUsdPerMTok: route.outputMicroUsdPerMTok, viaGateway: route.viaGateway })) } });
        return { resourceId: workspaceId };
      },
    },
    "workspace.effects.set": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        requireAdmin(actor, "the effect allow-list");
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const prior = effectAllowList(s, workspaceId);
        const list = (key: string, fallback: readonly string[]): string[] => [...new Set(((cmd.payload[key] as string[] | undefined) ?? fallback).map((entry) => entry.trim()).filter(Boolean))].sort();
        const containers = list("containers", prior.containers);
        const services = list("services", prior.services);
        const minutes = typeof cmd.payload["approvalMinutes"] === "number" ? cmd.payload["approvalMinutes"] : prior.approvalMinutes;
        // The hosts a sandboxed tool of this workspace may reach (ADR 0037): the whole list is replaced; an empty list means no network.
        const egressHosts = [...new Set(((cmd.payload["egressHosts"] as string[] | undefined) ?? prior.egressHosts).map(normalizeEgressHost))].sort();
        s.control.prepare(`INSERT INTO workspace_effect_policy(workspace_id,organization_id,containers_json,services_json,approval_minutes,egress_hosts_json,updated_by,updated_at_ms) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET containers_json=excluded.containers_json,services_json=excluded.services_json,approval_minutes=excluded.approval_minutes,egress_hosts_json=excluded.egress_hosts_json,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
          .run(workspaceId, actor.organizationId, JSON.stringify(containers), JSON.stringify(services), minutes, JSON.stringify(egressHosts), actor.actorId, s.now());
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.effectsSet", payload: { workspaceId, containers, services, approvalMinutes: minutes, egressHosts } });
        return { resourceId: workspaceId };
      },
    },
    "workspace.queueLimit.set": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        requireAdmin(actor, "the queue limit");
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const maxQueued = cmd.payload["maxQueued"] as number;
        setQueueLimit(s, { organizationId: actor.organizationId, workspaceId, maxQueued, actorId: actor.actorId });
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.queueLimitSet", payload: { workspaceId, maxQueued } });
        return { resourceId: workspaceId };
      },
    },
    "runnerGroup.set": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        requireAdmin(actor, "a runner group's access");
        const groupId = String(cmd.payload["groupId"]);
        const workspaceIds = [...new Set(cmd.payload["workspaceIds"] as string[])].sort();
        const hostTools = cmd.payload["hostTools"] === true;
        for (const id of workspaceIds) if (!s.control.prepare("SELECT 1 FROM workspaces WHERE id=? AND organization_id=?").get(id, actor.organizationId)) throw new BrainDomainError("NOT_FOUND", `workspace ${id} not found`);
        if (hostTools && workspaceIds.length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "a group with host tools must name the workspaces that may use it");
        if (workspaceIds.length === 0 && !hostTools) s.control.prepare("DELETE FROM runner_groups WHERE organization_id=? AND group_id=?").run(actor.organizationId, groupId);
        else s.control.prepare(`INSERT INTO runner_groups(group_id,organization_id,host_tools,workspaces_json,updated_by,updated_at_ms) VALUES (?,?,?,?,?,?)
          ON CONFLICT(organization_id,group_id) DO UPDATE SET host_tools=excluded.host_tools,workspaces_json=excluded.workspaces_json,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
          .run(groupId, actor.organizationId, hostTools ? 1 : 0, JSON.stringify(workspaceIds), actor.actorId, s.now());
        s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "platform", aggregateId: groupId, eventType: "runnerGroup.set", payload: { groupId, hostTools, workspaceIds } });
        return { resourceId: groupId };
      },
    },
    "platform.drain.set": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        requireAdmin(actor, "drain mode");
        const draining = cmd.payload["draining"] === true;
        setDraining(s, actor.actorId, draining);
        s.emit(s.control, { organizationId: actor.organizationId, ...(workspaceId ? { workspaceId } : {}), aggregateType: "platform", aggregateId: "platform", eventType: draining ? "platform.draining" : "platform.resumed", payload: { draining } });
        return { resourceId: "platform" };
      },
    },
  };
}

/** engineSettings.get: what an owner set for this workspace plus the platform drain state. */
export function engineSettings(store: Store, actor: ActorContext, workspaceId: string): JsonValue {
  requireWorkspaceRead(store, actor, workspaceId);
  const defaults = wayOfWorking(store, workspaceId);
  const release = activeReleaseRecord(store, actor.organizationId)?.release;
  return {
    workspaceId,
    ...(defaults ? { wayOfWorking: { workflowId: defaults.workflowId, requiredTools: defaults.requiredTools } } : {}),
    // Workflows an owner may choose as the default way of working, each with the tools its agents have.
    workflows: Object.keys(release?.workflows ?? {}).sort().map((id) => ({ workflowId: id, tools: workflowAgentTools(store, actor.organizationId, id) ?? [] })),
    // The ordered routes, each with its place in line, its health and whether its account is out of quota right now; a key is only ever named by reference.
    modelRoutes: modelRoutesOf(store, workspaceId).map((route, index) => {
      const probe = readProbes(store).find((entry) => entry.id === routeProbeId(workspaceId, route.routeId));
      const cooldown = routeCooldownUntil(store, workspaceId, route.routeId);
      return { ...route, position: index + 1, usable: routeUsable(route), status: !route.enabled ? "off" : cooldown !== undefined ? "quota" : probe ? (probe.status === "unavailable" ? "down" : "up") : "unknown", ...(cooldown !== undefined ? { quotaUntil: new Date(cooldown).toISOString() } : {}) };
    }),
    modelRouteRoles: ["evaluator", "second-attempt", "judge"],
    drain: drainStatus(store),
    queueLimit: queueLimitOf(store, workspaceId),
    autonomyCeiling: autonomyCeilingOf(store, workspaceId),
    liveWork: liveWorkOf(store, actor.organizationId, workspaceId),
  } as unknown as JsonValue;
}

/** The workspace's autonomy ceiling as a preset; no ceiling set means every plan operation is allowed. */
function autonomyCeilingOf(store: Store, workspaceId: string): { preset: "supervised" | "standard" | "autonomous"; isDefault: boolean } {
  const row = store.control.prepare("SELECT autonomy_ceiling_json FROM workspaces WHERE id=?").get(workspaceId) as { autonomy_ceiling_json: string | null } | undefined;
  return { preset: ceilingPreset(row?.autonomy_ceiling_json ? JSON.parse(row.autonomy_ceiling_json) as string[] : null), isDefault: !row?.autonomy_ceiling_json };
}

const MAX_NAMED_MISSIONS = 20;

/** What "stop all sessions" would stop right now, so the confirmation can name it: running sessions by mission, the missions that would pause, and waiting work. */
function liveWorkOf(store: Store, organizationId: string, workspaceId: string): { sessions: number; standalone: number; waiting: number; missions: Array<{ missionId: string; title: string; sessions: number }>; moreMissions: number } {
  const db = store.workspaceDb(workspaceId, organizationId);
  const attempts = store.control.prepare(`SELECT j.workflow_run_id AS run_id FROM job_attempts a JOIN jobs j ON j.id=a.job_id
    WHERE j.organization_id=? AND j.workspace_id=? AND a.state IN ('offered','running','uploading','cancelling')`).all(organizationId, workspaceId) as Array<{ run_id: string }>;
  const waiting = (store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id=? AND workspace_id=? AND state IN ('queued','blocked')").get(organizationId, workspaceId) as { n: number }).n;
  const sessionsOf = new Map<string, number>();
  let standalone = 0;
  for (const attempt of attempts) {
    const mission = db.prepare("SELECT w.mission_id AS id FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.run_id=? LIMIT 1").get(attempt.run_id) as { id: string } | undefined
      ?? db.prepare("SELECT mission_id AS id FROM delegation_runs WHERE run_id=?").get(attempt.run_id) as { id: string } | undefined;
    if (mission) sessionsOf.set(mission.id, (sessionsOf.get(mission.id) ?? 0) + 1); else standalone++;
  }
  const active = db.prepare("SELECT id, title FROM missions WHERE state='active' ORDER BY created_at_ms, id").all() as Array<{ id: string; title: string }>;
  const missions = active.map((mission) => ({ missionId: mission.id, title: mission.title, sessions: sessionsOf.get(mission.id) ?? 0 })).sort((a, b) => b.sessions - a.sessions);
  return { sessions: attempts.length, standalone, waiting, missions: missions.slice(0, MAX_NAMED_MISSIONS), moreMissions: Math.max(0, missions.length - MAX_NAMED_MISSIONS) };
}

/** effects.get: what this workspace's effect tools may touch, how long an approval waits and which hosts its sandboxed tools may reach. */
export function effectSettings(store: Store, actor: ActorContext, workspaceId: string): JsonValue {
  requireWorkspaceRead(store, actor, workspaceId);
  const allow = effectAllowList(store, workspaceId);
  const groups = (store.control.prepare("SELECT group_id, host_tools, workspaces_json FROM runner_groups WHERE organization_id=? ORDER BY group_id").all(actor.organizationId) as Array<{ group_id: string; host_tools: number; workspaces_json: string }>)
    .filter((row) => (JSON.parse(row.workspaces_json) as string[]).includes(workspaceId));
  return { workspaceId, containers: allow.containers, services: allow.services, approvalMinutes: allow.approvalMinutes, egressHosts: allow.egressHosts, runnerGroups: groups.map((row) => ({ groupId: row.group_id, hostTools: row.host_tools === 1 })) } as unknown as JsonValue;
}

/** runnerGroups.list: the groups the owner set aside, with their workspaces and whether they carry host tools. */
export function runnerGroups(store: Store, actor: ActorContext): JsonValue {
  const rows = store.control.prepare("SELECT group_id, host_tools, workspaces_json FROM runner_groups WHERE organization_id=? ORDER BY group_id").all(actor.organizationId) as Array<{ group_id: string; host_tools: number; workspaces_json: string }>;
  return { items: rows.map((row) => ({ groupId: row.group_id, hostTools: row.host_tools === 1, workspaceIds: JSON.parse(row.workspaces_json) as string[] })) } as unknown as JsonValue;
}
