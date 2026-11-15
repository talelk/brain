import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import { activeReleaseRecord } from "../modules/configuration/index";
import { drainStatus, hostedConfig, queueLimitOf, setDraining, setQueueLimit } from "../modules/jobs/index";
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
 * Engine settings an owner makes: the workspace's default way of working (ADR 0022), its hosted model (ADR 0023), its queue limit (ADR 0040) and the platform's
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
        if (hostedConfig(s, workspaceId).enabled && (tools.some((tool) => HOST_TOOL.test(tool)) || have.some((tool) => HOST_TOOL.test(tool)))) {
          throw new BrainDomainError("CONFLICT", "this workspace uses a hosted model; a way of working that reads hosts must stay self-hosted. Switch the hosted model off first");
        }
        s.control.prepare(`INSERT INTO workspace_way_of_working(workspace_id,organization_id,workflow_id,required_tools_json,updated_by,updated_at_ms) VALUES (?,?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET workflow_id=excluded.workflow_id,required_tools_json=excluded.required_tools_json,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
          .run(workspaceId, actor.organizationId, workflowId, JSON.stringify(tools), actor.actorId, s.now());
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.wayOfWorkingSet", payload: { workspaceId, workflowId, requiredTools: tools } });
        return { resourceId: workspaceId };
      },
    },
    "workspace.hostedModel.set": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        requireAdmin(actor, "the hosted model");
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const p = cmd.payload;
        const prior = hostedConfig(s, workspaceId);
        const enabled = p["enabled"] === true;
        const vendor = String(p["vendor"] ?? prior.vendor).trim();
        const model = String(p["model"] ?? prior.model).trim();
        const baseUrl = p["baseUrl"] !== undefined ? hostedUrl(String(p["baseUrl"])) : prior.baseUrl;
        const inputPrice = typeof p["inputMicroUsdPerMTok"] === "number" ? p["inputMicroUsdPerMTok"] : prior.inputMicroUsdPerMTok;
        const outputPrice = typeof p["outputMicroUsdPerMTok"] === "number" ? p["outputMicroUsdPerMTok"] : prior.outputMicroUsdPerMTok;
        if (enabled) {
          if (!vendor || !model || !baseUrl) throw new BrainDomainError("INVALID_ARGUMENT", "Choose the vendor, the model and its address before switching the hosted model on");
          // ADR 0023 limit: redaction of host output is pattern based, so a workspace that reads production hosts stays self-hosted.
          if (usesHostTools(s, actor.organizationId, workspaceId)) throw new BrainDomainError("CONFLICT", "this workspace reads production hosts; it stays self-hosted");
        }
        // A hosted model that is switched on or described is always priced: its spend must reach the mission and workspace dollar caps (ADR 0023).
        // Switching one off by itself saves nothing new, so it never needs them.
        const described = ["vendor", "model", "baseUrl"].some((key) => p[key] !== undefined);
        if ((enabled || described) && (inputPrice < 1 || outputPrice < 1)) throw new BrainDomainError("INVALID_ARGUMENT", "Set the hosted model's input and output token prices (micro-USD per million tokens) so its spend counts against the dollar caps");
        s.control.prepare(`INSERT INTO workspace_hosted_model(workspace_id,organization_id,enabled,vendor,model,base_url,input_micro_usd_per_mtok,output_micro_usd_per_mtok,updated_by,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled,vendor=excluded.vendor,model=excluded.model,base_url=excluded.base_url,input_micro_usd_per_mtok=excluded.input_micro_usd_per_mtok,output_micro_usd_per_mtok=excluded.output_micro_usd_per_mtok,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
          .run(workspaceId, actor.organizationId, enabled ? 1 : 0, vendor, model, baseUrl, inputPrice, outputPrice, actor.actorId, s.now());
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.hostedModelSet", payload: { workspaceId, enabled, vendor, model, inputMicroUsdPerMTok: inputPrice, outputMicroUsdPerMTok: outputPrice } });
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
  const hosted = hostedConfig(store, workspaceId);
  const probe = readProbes(store).find((entry) => entry.id === `hosted:${workspaceId}`);
  const release = activeReleaseRecord(store, actor.organizationId)?.release;
  return {
    workspaceId,
    ...(defaults ? { wayOfWorking: { workflowId: defaults.workflowId, requiredTools: defaults.requiredTools } } : {}),
    // Workflows an owner may choose as the default way of working, each with the tools its agents have.
    workflows: Object.keys(release?.workflows ?? {}).sort().map((id) => ({ workflowId: id, tools: workflowAgentTools(store, actor.organizationId, id) ?? [] })),
    hostedModel: { enabled: hosted.enabled, vendor: hosted.vendor, model: hosted.model, baseUrl: hosted.baseUrl, inputMicroUsdPerMTok: hosted.inputMicroUsdPerMTok, outputMicroUsdPerMTok: hosted.outputMicroUsdPerMTok, status: !hosted.enabled ? "off" : probe ? (probe.status === "unavailable" ? "down" : "up") : "unknown", roles: ["evaluator", "second-attempt"] },
    drain: drainStatus(store),
    queueLimit: queueLimitOf(store, workspaceId),
  } as unknown as JsonValue;
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
