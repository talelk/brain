import type { FleetOverview } from "@brain/contracts";
import { query } from "./client";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * The fleet overview every workspace member may read: open missions by condition, team members at work, the runners' slot sum and spend
 * today. The Governor adds the runner list only for a holder of runner administration.
 */
export async function fleetOverview(workspaceId: string, signal?: AbortSignal): Promise<Envelope<FleetOverview>> {
  const response = await query<Envelope<FleetOverview>>({ queryType: "fleet.overview", workspaceId }, signal);
  return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}
