import { createSignal } from "solid-js";
import { clampPaneSize } from "../components/primitives";

/**
 * The Live console's persisted view state (plan §3): pane sizes and
 * per-session transcript scroll offsets. Selection and filters
 * live in the URL; everything here survives navigating away and back (returning
 * from approvals, evidence or a work item restores the console exactly).
 *
 * State is module-scoped (Solid signals) and mirrored into sessionStorage keyed
 * by workspace, so a reload in the same tab restores the same arrangement
 * without ever leaking one workspace's layout into another.
 */

export interface ConsoleLayoutState {
  railWidth: number;
  rightWidth: number;
}

/* Bounds mirror the plan: rail 16–20rem, right pane 18–22rem (16px = 1rem). */
const RAIL_BOUNDS = [256, 320] as const;
const RIGHT_BOUNDS = [288, 352] as const;
const DEFAULTS: ConsoleLayoutState = { railWidth: 288, rightWidth: 320 };

interface ConsoleWorkspaceState extends ConsoleLayoutState {
  /** Feed scrollTop per selected session; restored when the session reopens. */
  scroll: Record<string, number>;
}

const STORAGE_KEY = "brain.exec-console.v2";

function readStored(): Record<string, ConsoleWorkspaceState> {
  if (typeof sessionStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "") as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, ConsoleWorkspaceState> : {};
  } catch { return {}; }
}

const states = new Map<string, ConsoleWorkspaceState>(Object.entries(readStored()));
const [version, setVersion] = createSignal(0);

function persist(): void {
  setVersion((v) => v + 1);
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(states)));
  } catch { /* quota/private mode: the in-memory layout still works this tab. */ }
}

function stateFor(workspaceId: string): ConsoleWorkspaceState {
  let state = states.get(workspaceId);
  if (!state) {
    state = { ...DEFAULTS, scroll: {} };
    states.set(workspaceId, state);
  }
  return state;
}

/** The reactive pane sizes for one workspace. */
export function consoleLayout(workspaceId: string): ConsoleLayoutState {
  version();
  const state = stateFor(workspaceId);
  return {
    railWidth: clampPaneSize(state.railWidth, RAIL_BOUNDS[0], RAIL_BOUNDS[1]),
    rightWidth: clampPaneSize(state.rightWidth, RIGHT_BOUNDS[0], RIGHT_BOUNDS[1]),
  };
}

export function setRailWidth(workspaceId: string, width: number): void {
  stateFor(workspaceId).railWidth = clampPaneSize(width, RAIL_BOUNDS[0], RAIL_BOUNDS[1]);
  persist();
}

export function setRightWidth(workspaceId: string, width: number): void {
  stateFor(workspaceId).rightWidth = clampPaneSize(width, RIGHT_BOUNDS[0], RIGHT_BOUNDS[1]);
  persist();
}

/** The persisted feed scroll offset for one session (0 when never scrolled). */
export function feedScroll(workspaceId: string, sessionId: string): number {
  version();
  return stateFor(workspaceId).scroll[sessionId] ?? 0;
}

export function setFeedScroll(workspaceId: string, sessionId: string, offset: number): void {
  const state = stateFor(workspaceId);
  if (Math.abs((state.scroll[sessionId] ?? 0) - offset) < 8) return; // skip scroll noise
  state.scroll[sessionId] = Math.max(0, Math.floor(offset));
  persist();
}

/**
 * The selected session as persisted fallback: the URL is authoritative
 * (`?session=…`), but returning to `/w/:id/live` without params reopens the
 * session the operator last had selected in this workspace.
 */
const [lastSelection, setLastSelection] = createSignal<Record<string, string>>({});

export function lastSelectedSession(workspaceId: string): string | undefined {
  return lastSelection()[workspaceId];
}

export function rememberSelectedSession(workspaceId: string, sessionId: string): void {
  setLastSelection((previous) => (previous[workspaceId] === sessionId ? previous : { ...previous, [workspaceId]: sessionId }));
}
