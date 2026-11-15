import { createHash } from "node:crypto";
import type { ActorContext, CommandReceipt } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import { activeReleaseRecord } from "../modules/configuration/index";
import { principalForChat } from "../modules/identity/index";
import type { ChatStartInput, ChatStartPort } from "../modules/operations/index";
import { absoluteLink, missionLink } from "../modules/operations/index";
import { scopesForPrincipal } from "./authz";
import type { Store } from "./store";

interface Ports {
  readonly store: Store;
  /** The command funnel, with the same after-command reactions a person's command gets. */
  run(actor: ActorContext, command: unknown): Promise<{ receipt: CommandReceipt }>;
}

interface PlayEntry { readonly id: string; readonly title: string }

/** The plays of the organization's active release, by id. */
function playsOf(store: Store, organizationId: string): PlayEntry[] {
  const plays = activeReleaseRecord(store, organizationId)?.release.plays ?? {};
  return Object.entries(plays).map(([id, play]) => ({ id, title: play.spec.title })).sort((a, b) => a.id.localeCompare(b.id));
}

/** A workspace of the person's where they may start missions, active, by slug or id. */
function workspacesFor(store: Store, organizationId: string, principalId: string): Array<{ id: string; slug: string }> {
  const rows = store.control.prepare(
    `SELECT DISTINCT w.id, w.slug FROM workspace_memberships m JOIN workspaces w ON w.id=m.workspace_id AND w.organization_id=m.organization_id
      WHERE m.organization_id=? AND m.principal_id=? AND m.revoked_at_ms IS NULL AND w.status='active' ORDER BY w.slug`).all(organizationId, principalId) as Array<{ id: string; slug: string }>;
  return rows.filter((row) => scopesForPrincipal(store, principalId, organizationId, row.id).includes("mission:write"));
}

/**
 * `start <play> [in <workspace>] [title]` from chat (ADR 0011 amendment, spec #90 ticket #123). The chat identity must be linked to an
 * active member; the mission is then created through the ordinary `mission.create` command as THAT member, so the member's role, the
 * workspace queue limit and the mission budget admission all apply and nothing is bypassed. Chat never confirms the plan or approves
 * anything: the starting plan waits for the person in Needs you under the Play's own rules. The command id comes from the chat message,
 * so a retried message returns the first mission instead of starting a second.
 */
export async function startFromChat(ports: Ports, input: ChatStartInput): Promise<string> {
  const { store } = ports;
  const principalId = principalForChat(store, input.organizationId, input.provider, input.chatUserId);
  if (!principalId) {
    return `Nothing was started: this ${input.provider} user is not linked to a Brain member. Ask a Brain administrator to link "${input.chatUserId}" under Administration, People, Chat identities.`;
  }
  const plays = playsOf(store, input.organizationId);
  const known = plays.map((play) => play.id).slice(0, 12).join(", ");
  const [named = "", ...rest] = input.args;
  if (!named) return `Say which Play to start: "start <play> [in <workspace>] [title]".${known ? ` Plays: ${known}.` : " This organization has no Plays yet."}`;
  const play = plays.find((candidate) => candidate.id === named) ?? plays.find((candidate) => candidate.title.toLowerCase() === named.toLowerCase());
  if (!play) return `No Play is named "${named}".${known ? ` Plays: ${known}.` : " This organization has no Plays yet."}`;

  const workspaces = workspacesFor(store, input.organizationId, principalId);
  let words = rest;
  let chosen = workspaces.length === 1 ? workspaces[0] : undefined;
  if (words[0]?.toLowerCase() === "in" && words[1]) {
    chosen = workspaces.find((candidate) => candidate.slug === words[1] || candidate.id === words[1]);
    if (!chosen) return `You cannot start missions in "${words[1]}". Your workspaces: ${workspaces.map((candidate) => candidate.slug).join(", ") || "none"}.`;
    words = words.slice(2);
  }
  if (!chosen) return workspaces.length === 0
    ? "Nothing was started: you cannot start missions in any workspace."
    : `Name the workspace: "start ${play.id} in <workspace>". Yours: ${workspaces.map((candidate) => candidate.slug).join(", ")}.`;

  const organization = store.control.prepare("SELECT revocation_generation FROM organizations WHERE id=?").get(input.organizationId) as { revocation_generation: number } | undefined;
  const actor: ActorContext = {
    kind: "human", actorId: principalId, organizationId: input.organizationId, workspaceId: chosen.id,
    scopes: scopesForPrincipal(store, principalId, input.organizationId, chosen.id), authMethod: "session", authGeneration: organization?.revocation_generation ?? 1,
  };
  const title = (words.join(" ").trim() || play.title).slice(0, 120);
  const commandId = `chat-start-${createHash("sha256").update(`${input.provider}\n${input.messageKey}`).digest("hex").slice(0, 40)}`;
  try {
    const { receipt } = await ports.run(actor, {
      contractVersion: "brain.command/v1", commandId, idempotencyKey: commandId, commandType: "mission.create", workspaceId: chosen.id,
      payload: { title, playId: play.id },
    });
    if (!receipt.accepted || !receipt.resourceId) return `Nothing was started: ${receipt.accepted ? "the mission was not created" : receipt.error.detail}`;
    const link = absoluteLink(missionLink(chosen.id, receipt.resourceId, "plan"));
    const waiting = (store.workspaceDb(chosen.id, input.organizationId).prepare("SELECT state FROM plan_versions WHERE mission_id=? ORDER BY revision DESC LIMIT 1").get(receipt.resourceId) as { state: string } | undefined)?.state === "proposed";
    return `Started "${title}" from ${play.id}. ${waiting ? "Its plan waits for you in Needs you; confirm it in Brain, not here" : "It is under way within the Play's rules"}: ${link}`;
  } catch (error) {
    if (error instanceof BrainDomainError) return `Nothing was started: ${error.message}`;
    throw error;
  }
}

export type { ChatStartPort };
