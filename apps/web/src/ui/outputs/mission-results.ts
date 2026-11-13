import type { ExecutionLink, Mission, WorkItem } from "@brain/contracts";
import { query } from "../../data/client";
import { artifactsListQuery } from "../../data/exec-outputs";
import type { OutputGrouping, OutputItem } from "./output-files";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

export interface MissionFiles {
  artifacts: OutputItem[];
  grouping: OutputGrouping;
  /** True number of attempt records per task (the list under "Attempts" shows the newest of them). */
  attemptTotals: Readonly<Record<string, number>>;
}

/**
 * Every file one mission's tasks produced, with the grouping the Outputs page
 * uses (the producing task is named by the server on each artifact), so the mission's Outputs tab shows the same
 * Result cards as the workspace page. Attempt records are listed apart from results and counted truthfully.
 */
export async function loadMissionFiles(workspaceId: string, mission: Mission, signal: AbortSignal): Promise<Envelope<MissionFiles>> {
  const read = <T,>(queryType: "executionLinks.list" | "workItems.list") =>
    query<Envelope<{ items: T[] }>>({ queryType, workspaceId, limit: 100 }, signal);
  const [links, items] = await Promise.all([read<ExecutionLink>("executionLinks.list"), read<WorkItem>("workItems.list")]);
  const missionLinks = links.snapshot.items.filter((link) => link.missionId === mission.missionId);
  const workItems = items.snapshot.items.filter((item) => item.missionId === mission.missionId);
  const artifacts = new Map<string, OutputItem>();
  const attemptTotals: Record<string, number> = {};
  await Promise.all(workItems.map(async (item) => {
    const base = { workspaceId, workItemId: item.workItemId } as const;
    for (const state of ["uploading", "verified"] as const) {
      const found = await artifactsListQuery({ ...base, state, kind: "result" }, signal);
      for (const artifact of found.snapshot.items) if (!artifacts.has(artifact.artifactId)) artifacts.set(artifact.artifactId, { ...artifact, state });
    }
    const records = await artifactsListQuery({ ...base, state: "verified", kind: "record", limit: 20 }, signal);
    attemptTotals[item.workItemId] = records.totalEstimate ?? records.snapshot.items.length;
    for (const artifact of records.snapshot.items) if (!artifacts.has(artifact.artifactId)) artifacts.set(artifact.artifactId, { ...artifact, state: "verified" });
  }));
  return {
    snapshot: {
      artifacts: [...artifacts.values()],
      grouping: { workItems, missionTitles: { [mission.missionId]: mission.title }, links: missionLinks },
      attemptTotals,
    },
    asOf: links.asOf,
    sourceWatermark: links.sourceWatermark,
  };
}
