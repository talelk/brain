import { canTransition } from "@brain/contracts/machines";
import type { WorkItem } from "@brain/contracts";

/**
 * The mission work model shared by the List, Board and Timeline views: which
 * column an item sits in, which moves a person may make by dragging, the one
 * next action per item, and the dependency graph (stages and critical path).
 * Pure functions only, so the views agree and the rules are unit-tested.
 */

export type BoardColumnId = "ready" | "in-progress" | "review" | "blocked" | "done";

export const BOARD_COLUMNS: readonly { id: BoardColumnId; name: string; hint: string }[] = [
  { id: "ready", name: "Ready", hint: "Ready to start, or waiting for earlier tasks" },
  { id: "in-progress", name: "In progress", hint: "An agent is working on it" },
  { id: "review", name: "Review", hint: "Finished; check the evidence" },
  { id: "blocked", name: "Blocked", hint: "Needs a person to unblock it" },
  { id: "done", name: "Done", hint: "Verified by independent evidence" },
];

/** The board column of a live item; abandoned items are not on the board. Backlog waits in Ready. */
export function boardColumnOf(item: WorkItem): BoardColumnId | undefined {
  if (item.state === "abandoned") return undefined;
  return item.state === "backlog" ? "ready" : item.state;
}

/** True when every dependency of the item is verified done. */
export function dependenciesDone(item: WorkItem, items: readonly WorkItem[]): boolean {
  return item.dependsOn.every((id) => items.find((other) => other.workItemId === id)?.state === "done");
}

/**
 * The columns an item may be dragged to. Only plain Governor transitions that
 * need nothing else are offered: Start goes through the dispatch flow, Done
 * needs verified evidence (and a handoff), Blocked needs a reason, and a parked
 * item waits for a person's explicit decision — those stay buttons.
 */
export function dragTargets(item: WorkItem, items: readonly WorkItem[], canMove: boolean): BoardColumnId[] {
  if (!canMove || item.parked) return [];
  const from = item.state;
  const here = boardColumnOf(item);
  return BOARD_COLUMNS.map((column) => column.id).filter((to) => {
    if (to === here || to === "done" || to === "blocked") return false;
    if (from === "ready" && to === "in-progress") return false;
    if (!canTransition("workItem", from, to)) return false;
    if (to === "ready" && !dependenciesDone(item, items)) return false;
    return true;
  });
}

/** Why an item is not moving, in plain words; undefined while it is simply progressing. */
/** A task stopped because its agent was interrupted over and over; it needs one click, not a diagnosis. */
export function isStoppedForRetry(item: Pick<WorkItem, "parked" | "blockedReason">): boolean {
  return item.parked && (item.blockedReason ?? "").startsWith("Stopped:");
}

export function waitReason(item: WorkItem): string | undefined {
  if (isStoppedForRetry(item)) return "Stopped: waiting for you to try again. The agent was interrupted too often to carry on by itself. Next: press Try again.";
  if (item.parked) return "Parked after repeated failures. It waits for a person; independent work carries on. Next: press Decide to retry, change or take over the task.";
  if (item.state === "blocked") return `Blocked: ${item.blockedReason ?? "it is waiting on something outside the task"}. Next: sort that out, then press Unblock.`;
  if (item.state === "backlog" && item.dependsOn.length) return "Waiting for earlier tasks to be verified done.";
  if (item.state === "review") return "Finished; waiting for you to check the evidence.";
  if (item.failedAttempts > 0 && item.state !== "done") return `The last ${item.failedAttempts === 1 ? "attempt" : `${item.failedAttempts} attempts`} did not work. Next: Brain tries again; if it keeps failing, open this task's logs to see why.`;
  return undefined;
}

export type NextAction =
  | { kind: "start"; label: "Start"; icon: string }
  | { kind: "handoff"; label: "Hand off"; icon: string }
  | { kind: "review"; label: "Review"; icon: string }
  | { kind: "unblock"; label: "Unblock" | "Decide" | "Try again"; icon: string }
  | { kind: "follow"; label: "Follow"; icon: string };

/** The one action that moves an item forward, reusing the existing flows (dispatch, handoff, manage). */
export function nextActionOf(item: WorkItem, handoffRequired: boolean, canDispatch: boolean): NextAction | undefined {
  switch (item.state) {
    case "ready": return canDispatch ? { kind: "start", label: "Start", icon: "lucide-play" } : undefined;
    case "review": return handoffRequired ? { kind: "handoff", label: "Hand off", icon: "lucide-send" } : { kind: "review", label: "Review", icon: "lucide-badge-check" };
    case "blocked": return { kind: "unblock", label: item.parked ? (isStoppedForRetry(item) ? "Try again" : "Decide") : "Unblock", icon: "lucide-wrench" };
    case "in-progress": return { kind: "follow", label: "Follow", icon: "lucide-radio" };
    default: return undefined;
  }
}

export interface GraphNode { id: string; deps: readonly string[]; weight: number; done: boolean }

export interface WorkGraph {
  /** Stage (0-based) per node: the longest dependency chain before it. */
  stage: Map<string, number>;
  stages: string[][];
  /** Every dependency edge whose both ends are in the graph. */
  edges: { from: string; to: string }[];
  /** The ids on the longest remaining (not yet done) weighted chain, in order. */
  critical: string[];
  /** The summed weight of the critical chain. */
  criticalWeight: number;
}

/**
 * Stages by longest path and the critical path over the remaining work.
 * Unknown dependencies are ignored; a cycle (never produced by a validated
 * plan) is broken by visiting order so the views still render.
 */
export function workGraph(nodes: readonly GraphNode[]): WorkGraph {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stage = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = stage.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = byId.get(id);
    const value = node ? Math.max(-1, ...node.deps.filter((dep) => byId.has(dep)).map(depth)) + 1 : 0;
    visiting.delete(id);
    stage.set(id, value);
    return value;
  };
  for (const node of nodes) depth(node.id);
  const stages: string[][] = [];
  for (const node of nodes) (stages[stage.get(node.id) ?? 0] ??= []).push(node.id);

  // Longest remaining chain: done nodes weigh nothing and cannot sit on it.
  const best = new Map<string, { weight: number; prev?: string }>();
  const order = [...nodes].sort((a, b) => (stage.get(a.id) ?? 0) - (stage.get(b.id) ?? 0));
  for (const node of order) {
    if (node.done) continue;
    let prev: string | undefined;
    let base = 0;
    for (const dep of node.deps) {
      const entry = best.get(dep);
      if (entry && entry.weight > base) { base = entry.weight; prev = dep; }
    }
    best.set(node.id, { weight: base + node.weight, ...(prev ? { prev } : {}) });
  }
  let tail: string | undefined;
  let criticalWeight = 0;
  for (const [id, entry] of best) if (entry.weight > criticalWeight) { criticalWeight = entry.weight; tail = id; }
  const critical: string[] = [];
  for (let cursor = tail; cursor; cursor = best.get(cursor)?.prev) critical.unshift(cursor);
  const edges = nodes.flatMap((node) => node.deps.filter((dep) => byId.has(dep)).map((dep) => ({ from: dep, to: node.id })));
  return { stage, stages, edges, critical, criticalWeight };
}

/** Minutes as plain words: "45 min", "2 h 10 min". */
export function minutesText(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  return rounded % 60 ? `${hours} h ${rounded % 60} min` : `${hours} h`;
}
