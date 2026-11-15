import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";

/**
 * Choice reasons (ADR 0062): what the Governor judged when it chose a way of working, a team member or a model route, written at that
 * moment as a code and the facts it judged by. A row is never rewritten (a trigger refuses it) and is never rebuilt from later state: a later
 * decision adds a row. A choice that was never made leaves no row. No model writes any of this.
 */
export type ChoiceKind = "way-of-working" | "team-member" | "model-route";
export type ChoiceSubject = "command" | "work-item" | "job" | "attempt";

export interface ChoiceReason { readonly kind: ChoiceKind; readonly code: string; readonly facts: Record<string, JsonValue>; readonly recordedAt: string }

/** Records one reason for one subject; the same choice recorded again (a replay) keeps the first row. */
export function recordChoice(s: Store, scope: { organizationId: string; workspaceId: string }, subject: { kind: ChoiceSubject; id: string }, choice: { kind: ChoiceKind; code: string; facts: Record<string, JsonValue> }): void {
  s.control.prepare("INSERT OR IGNORE INTO choice_reasons(organization_id,workspace_id,kind,subject_kind,subject_id,code,facts_json,recorded_at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(scope.organizationId, scope.workspaceId, choice.kind, subject.kind, subject.id, choice.code, JSON.stringify(choice.facts), s.now());
}

/** The reasons recorded for the given subjects, oldest first. */
export function choicesFor(s: Store, subjects: ReadonlyArray<{ kind: ChoiceSubject; id: string }>): ChoiceReason[] {
  if (subjects.length === 0) return [];
  const clause = subjects.map(() => "(subject_kind=? AND subject_id=?)").join(" OR ");
  return (s.control.prepare(`SELECT kind, code, facts_json, recorded_at_ms FROM choice_reasons WHERE ${clause} ORDER BY id`).all(...subjects.flatMap((subject) => [subject.kind, subject.id])) as Array<{ kind: ChoiceKind; code: string; facts_json: string; recorded_at_ms: number }>)
    .map((row) => ({ kind: row.kind, code: row.code, facts: JSON.parse(row.facts_json) as Record<string, JsonValue>, recordedAt: new Date(row.recorded_at_ms).toISOString() }));
}
