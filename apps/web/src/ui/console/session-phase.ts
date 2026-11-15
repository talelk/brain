import type { BrainSession } from "@brain/contracts";

/**
 * What a person is told a session is doing. A session a person holds at a turn boundary is still `running` for the system (it keeps its
 * attempt, lease and slot, ADR 0058), so its lifecycle state is never replaced: this is the word shown, "paused" or "pausing" while it is held
 * or about to be, otherwise the lifecycle state itself.
 */
export function sessionPhase(session: (Pick<BrainSession, "state"> & { pause?: BrainSession["pause"] }) | undefined): string {
  if (!session) return "unknown";
  if (session.state === "running" && session.pause) {
    if (session.pause.state === "paused" || session.pause.state === "resuming") return "paused";
    if (session.pause.state === "pausing") return "pausing";
  }
  return session.state;
}

/** The kind to hand StatusBadge: held sessions have their own words and tone; every other state keeps the shared maps. */
export const phaseKind = (phase: string): "session" | undefined => (phase === "paused" || phase === "pausing" ? "session" : undefined);
