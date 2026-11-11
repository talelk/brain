import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { unifiedHunks } from "../evidence/index";
import { readVerified } from "../artifacts/index";

type Db = ReturnType<Store["workspaceDb"]>;
type OccurrenceRef = { id: string; automation_id: string; planned_at_ms: number; state: string; dispatch_ref: string | null };

/** One output (or the whole result) compared with the previous occurrence's. */
export interface OutputChange {
  name: string;
  status: "unchanged" | "changed";
  added: number;
  removed: number;
  hunks: Array<{ header: string; lines: Array<{ type: "context" | "add" | "del"; text: string }> }>;
}

const COLUMNS = "id,automation_id,planned_at_ms,state,dispatch_ref";

/**
 * What a scheduled result changed since the previous occurrence's (#57),
 * computed on read from the stored output versions: no model, no new state.
 * `ref` is an occurrence id, or the mission / run an occurrence started.
 * Kinds: not-scheduled (the ref was not started by a schedule), first-run,
 * previous-pending (an occurrence has no result yet), unchanged, changed.
 */
export function occurrenceDiff(store: Store, db: Db, ref: string): JsonValue {
  const current = (db.prepare(`SELECT ${COLUMNS} FROM automation_occurrences WHERE id=?`).get(ref)
    ?? db.prepare(`SELECT ${COLUMNS} FROM automation_occurrences WHERE dispatch_ref=? ORDER BY planned_at_ms DESC LIMIT 1`).get(ref)) as OccurrenceRef | undefined;
  if (!current) {
    if (!db.prepare("SELECT 1 FROM missions WHERE id=?").get(ref) && !db.prepare("SELECT 1 FROM workflow_runs WHERE id=?").get(ref)) throw new BrainDomainError("NOT_FOUND", "occurrence not found");
    return { kind: "not-scheduled", outputs: [] } as unknown as JsonValue;
  }
  const previous = db.prepare(`SELECT ${COLUMNS} FROM automation_occurrences WHERE automation_id=? AND state='dispatched' AND dispatch_ref IS NOT NULL AND (planned_at_ms<? OR (planned_at_ms=? AND id<?)) ORDER BY planned_at_ms DESC, id DESC LIMIT 1`)
    .get(current.automation_id, current.planned_at_ms, current.planned_at_ms, current.id) as OccurrenceRef | undefined;
  const base = { occurrenceId: current.id, plannedAt: iso(current.planned_at_ms) };
  if (!previous) return { kind: "first-run", ...base, outputs: [] } as unknown as JsonValue;
  const prior = { occurrenceId: previous.id, plannedAt: iso(previous.planned_at_ms), ...(previous.dispatch_ref ? { ref: previous.dispatch_ref } : {}) };
  const now = current.dispatch_ref ? resultsOf(store, db, current.dispatch_ref) : undefined;
  const before = previous.dispatch_ref ? resultsOf(store, db, previous.dispatch_ref) : undefined;
  if (!now || !before) return { kind: "previous-pending", ...base, previous: prior, waitingFor: now ? "previous" : "current", outputs: [] } as unknown as JsonValue;

  const pairs = pairOutputs(before, now);
  const outputs: OutputChange[] = pairs.map(([name, was, is]) => {
    if (was === is) return { name, status: "unchanged", added: 0, removed: 0, hunks: [] };
    const hunks = unifiedHunks(was.split("\n"), is.split("\n"));
    const lines = hunks.flatMap((hunk) => hunk.lines);
    return {
      name, status: "changed", added: lines.filter((line) => line.type === "add").length, removed: lines.filter((line) => line.type === "del").length,
      hunks: hunks.slice(0, 20).map((hunk) => ({ header: hunk.header, lines: hunk.lines.slice(0, 200).map((line) => ({ type: line.type, text: line.text.slice(0, 2000) })) })),
    };
  });
  const changed = outputs.some((output) => output.status === "changed");
  return { kind: changed ? "changed" : "unchanged", ...base, previous: prior, outputs } as unknown as JsonValue;
}

/**
 * Pairs the outputs of two results so like is compared with like. Outputs are named by the producing task's id (or the name its plan
 * declared), so a repeated plan pairs by name. When the planner named them differently, equal counts pair by position in plan order;
 * unequal counts compare the whole result as one document. Returns [name, was, is].
 */
export function pairOutputs(before: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): Array<[string, string, string]> {
  const was = [...before.keys()];
  const is = [...now.keys()];
  if (was.length === is.length && [...was].sort().join("\n") === [...is].sort().join("\n")) return [...is].sort().map((name) => [name, before.get(name)!, now.get(name)!]);
  if (was.length === is.length) return is.map((name, index) => [name, before.get(was[index]!)!, now.get(name)!]);
  return [["Result", was.map((key) => before.get(key)!).join("\n\n"), is.map((key) => now.get(key)!).join("\n\n")]];
}

/**
 * The comparable text of each output of a mission (keyed by output name, in the order its task first produced it) or of a workflow
 * run (one "Result"). Undefined: no result yet.
 */
function resultsOf(store: Store, db: Db, ref: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  if (db.prepare("SELECT 1 FROM missions WHERE id=?").get(ref)) {
    const rows = db.prepare(`SELECT o.name AS name,
        COALESCE((SELECT artifact_digest FROM output_versions v WHERE v.output_id=o.id AND v.verified=1 ORDER BY v.created_at_ms DESC, v.id DESC LIMIT 1),
                 (SELECT artifact_digest FROM output_versions v WHERE v.output_id=o.id ORDER BY v.created_at_ms DESC, v.id DESC LIMIT 1)) AS digest
      FROM mission_outputs o WHERE o.mission_id=? ORDER BY o.created_at_ms, o.rowid`).all(ref) as Array<{ name: string; digest: string | null }>;
    // Plan order, not completion order: parallel tasks finish in any order, positions must still agree between two missions.
    const plan = db.prepare("SELECT p.tasks_json AS tasks FROM missions m JOIN plan_versions p ON p.id=m.active_plan_version_id WHERE m.id=?").get(ref) as { tasks: string } | undefined;
    const order = plan ? (JSON.parse(plan.tasks) as Array<{ id: string }>).map((task) => task.id) : [];
    const position = (name: string) => { const at = order.indexOf(name); return at < 0 ? order.length : at; };
    rows.sort((a, b) => position(a.name) - position(b.name));
    for (const row of rows) if (row.digest) out.set(row.name, textOf(store, row.digest));
  } else {
    const run = db.prepare("SELECT output_digest FROM workflow_runs WHERE id=?").get(ref) as { output_digest: string | null } | undefined;
    if (run?.output_digest) out.set("Result", textOf(store, run.output_digest));
    else {
      for (const step of db.prepare("SELECT output_json FROM step_outputs WHERE run_id=? ORDER BY rowid").all(ref) as Array<{ output_json: string }>) {
        try {
          const parsed = JSON.parse(step.output_json) as { deliverable?: unknown };
          if (typeof parsed.deliverable === "string" && parsed.deliverable.trim()) { out.set("Result", parsed.deliverable.trim()); break; }
        } catch { /* not a written result */ }
      }
    }
  }
  return out.size ? out : undefined;
}

/** The comparable text of a stored output: the written deliverable of a task result, else JSON with sorted keys, else the text itself. */
function textOf(store: Store, digest: string): string {
  let raw: string;
  try { raw = new TextDecoder().decode(readVerified(store, digest)); } catch { return ""; }
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)["deliverable"] === "string") return String((value as Record<string, unknown>)["deliverable"]).trim();
    return JSON.stringify(sortKeys(value), null, 2);
  } catch { return raw.trim(); }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortKeys(entry)]));
  return value;
}
