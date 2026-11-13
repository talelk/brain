import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import { activeReleaseRecord } from "../modules/configuration/index";
import { drainStatus, hostedConfig, setDraining } from "../modules/jobs/index";
import { wayOfWorking, workflowAgentTools } from "../modules/missions/index";
import { readProbes } from "../modules/operations/index";
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
 * Engine settings an owner makes: the workspace's default way of working (ADR 0022), its hosted model (ADR 0023) and the platform's
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
        if (enabled) {
          if (!vendor || !model || !baseUrl) throw new BrainDomainError("INVALID_ARGUMENT", "Choose the vendor, the model and its address before switching the hosted model on");
          // ADR 0023 limit: redaction of host output is pattern based, so a workspace that reads production hosts stays self-hosted.
          if (usesHostTools(s, actor.organizationId, workspaceId)) throw new BrainDomainError("CONFLICT", "this workspace reads production hosts; it stays self-hosted");
        }
        s.control.prepare(`INSERT INTO workspace_hosted_model(workspace_id,organization_id,enabled,vendor,model,base_url,updated_by,updated_at_ms) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled,vendor=excluded.vendor,model=excluded.model,base_url=excluded.base_url,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
          .run(workspaceId, actor.organizationId, enabled ? 1 : 0, vendor, model, baseUrl, actor.actorId, s.now());
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.hostedModelSet", payload: { workspaceId, enabled, vendor, model } });
        return { resourceId: workspaceId };
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
    hostedModel: { enabled: hosted.enabled, vendor: hosted.vendor, model: hosted.model, baseUrl: hosted.baseUrl, status: !hosted.enabled ? "off" : probe ? (probe.status === "unavailable" ? "down" : "up") : "unknown", roles: ["evaluator", "second-attempt"] },
    drain: drainStatus(store),
  } as unknown as JsonValue;
}
