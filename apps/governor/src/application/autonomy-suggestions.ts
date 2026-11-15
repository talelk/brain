import type { ActorContext, AutonomyPreset, AutonomySuggestion, AutonomySuggestions, Workflow } from "@brain/contracts";
import { handlersFor, type CommandHandlers } from "./command-funnel";
import { requireWorkspaceRead } from "./authz";
import type { Store } from "./store";
import { BrainDomainError } from "../domain/errors";
import { currentSuggestions, listDecisions, recordDecision, type SuggestionContext } from "../modules/missions/index";

interface Ports {
  readonly store: Store;
  readonly plays: (organizationId: string) => SuggestionContext["plays"];
  readonly workflows: (organizationId: string) => Readonly<Record<string, Workflow>>;
  readonly ceiling: (workspaceId: string) => AutonomyPreset;
  /** Accepting for one mission: the ordinary policy change (ceiling and version checks included). */
  readonly setMissionPreset: (actor: ActorContext, workspaceId: string, missionId: string, preset: AutonomyPreset) => void;
  /** Accepting for a repeated plan: the schedule's confirm-automatically switch goes on. */
  readonly allowAutoConfirm: (actor: ActorContext, workspaceId: string, automationId: string) => void;
}

const KINDS = new Set(["play", "mission", "repeat"]);

/**
 * Autonomy suggestions earned from a track record (#158, ADR 0066). A suggestion is worked out on every read from existing records, so a
 * record that turns bad withdraws it at once; only a person's accept or dismiss is stored. Nothing here can approve an effect, change a
 * budget, or cross the workspace's autonomy ceiling, and no model is involved. It is never an attention item and never notifies: it shows on
 * the Play page, the mission page and the Quality page.
 */
export class AutonomySuggestionService {
  constructor(private readonly ports: Ports) {}

  private context(actor: ActorContext, workspaceId: string): SuggestionContext {
    requireWorkspaceRead(this.ports.store, actor, workspaceId);
    return {
      store: this.ports.store, db: this.ports.store.workspaceDb(workspaceId, actor.organizationId), organizationId: actor.organizationId,
      plays: this.ports.plays(actor.organizationId), workflows: this.ports.workflows(actor.organizationId), ceiling: this.ports.ceiling(workspaceId),
    };
  }

  /**
   * `resourceId` narrows to one subject: `play:<id>`, `mission:<id>` or `repeat:<id>`; `about:<missionId>` is that mission's own suggestion and the
   * repeated plans that repeat it (what its page shows).
   */
  query(actor: ActorContext, workspaceId: string, resourceId?: string, limit = 50): AutonomySuggestions {
    const ctx = this.context(actor, workspaceId);
    if (resourceId?.startsWith("about:")) {
      const missionId = resourceId.slice("about:".length);
      const items = currentSuggestions(ctx).filter((item) => (item.kind === "mission" && item.subjectId === missionId) || (item.kind === "repeat" && item.sourceMissionId === missionId));
      return { items, decisions: listDecisions(ctx.db, { kind: "mission", subjectId: missionId }, limit) };
    }
    const filter = resourceId ? this.subject(resourceId) : undefined;
    return { items: currentSuggestions(ctx, filter), decisions: listDecisions(ctx.db, filter, limit) };
  }

  private subject(resourceId: string): { kind: string; subjectId: string } {
    const at = resourceId.indexOf(":");
    const kind = at < 0 ? "" : resourceId.slice(0, at);
    if (!KINDS.has(kind) || at === resourceId.length - 1) throw new BrainDomainError("INVALID_ARGUMENT", "a suggestion is named play:<id>, mission:<id> or repeat:<id>");
    return { kind, subjectId: resourceId.slice(at + 1) };
  }

  commands(): CommandHandlers {
    const { store } = this.ports;
    /** The suggestion as it holds right now, or the reason it no longer does: a stale button never acts on a withdrawn suggestion. */
    const pending = (actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>) => {
      if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person accepts or dismisses an autonomy suggestion");
      const kind = String(payload["kind"]);
      const subjectId = String(payload["subjectId"]);
      if (!KINDS.has(kind) || !subjectId) throw new BrainDomainError("INVALID_ARGUMENT", "a suggestion is named by its kind and subject");
      // Turning a schedule's switch on is a schedule edit: it takes the schedule's own scope, not only the right to change missions.
      if (kind === "repeat" && !actor.scopes.includes("workflow:dispatch")) throw new BrainDomainError("FORBIDDEN", "only a person who may edit schedules can change when a schedule confirms its plan");
      const ctx = this.context(actor, workspaceId);
      const suggestion = currentSuggestions(ctx, { kind, subjectId })[0];
      if (!suggestion) throw new BrainDomainError("CONFLICT", "this suggestion no longer holds: the record changed, a person already decided on it, or the workspace ceiling does not allow it");
      return { ctx, suggestion, kind: kind as AutonomySuggestion["kind"], subjectId };
    };
    return handlersFor(["autonomy.suggestion.accept", "autonomy.suggestion.dismiss"], {
      kind: "workspace",
      handle: ({ actor, cmd, workspaceId }) => {
        const { ctx, suggestion, kind, subjectId } = pending(actor, workspaceId, cmd.payload);
        const accepted = cmd.commandType === "autonomy.suggestion.accept";
        if (accepted) {
          // The change and the record commit together: a refused change (a lowered ceiling, a closed mission) leaves no acceptance behind.
          if (kind === "mission") this.ports.setMissionPreset(actor, workspaceId, subjectId, suggestion.to as AutonomyPreset);
          else if (kind === "repeat") this.ports.allowAutoConfirm(actor, workspaceId, subjectId);
        }
        const decisionId = recordDecision(store, ctx.db, { kind, subjectId, decision: accepted ? "accepted" : "dismissed", suggestion, actorId: actor.actorId });
        store.emit(ctx.db, {
          workspaceId, aggregateType: "autonomy", aggregateId: decisionId, eventType: accepted ? "autonomy.suggestionAccepted" : "autonomy.suggestionDismissed",
          payload: { kind, subjectId, from: suggestion.from, to: suggestion.to, actorId: actor.actorId, message: accepted ? `Accepted: ${suggestion.subjectTitle} ${suggestion.from} to ${suggestion.to}` : `Dismissed the suggestion for ${suggestion.subjectTitle}` },
        });
        return { resourceId: decisionId };
      },
    });
  }
}
