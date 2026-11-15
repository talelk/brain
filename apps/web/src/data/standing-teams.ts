import type { StandingTeam } from "@brain/contracts";
import { query } from "./client";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** The workspace's standing teams, active first (ADR 0056). */
export async function standingTeamsRead(workspaceId: string, signal?: AbortSignal): Promise<Envelope<StandingTeam[]>> {
  const response = await query<Envelope<{ items: StandingTeam[] }>>({ queryType: "standingTeams.list", workspaceId }, signal);
  return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}
