import type { ExecutionLink, Mission, WorkItem } from "@brain/contracts";
import { query } from "../../data/client";
import { artifactsListQuery } from "../../data/exec-outputs";
import type { OutputGrouping, OutputItem } from "./output-files";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

export interface MissionFiles {
  artifacts: OutputItem[];
  grouping: OutputGrouping;
}

/**
 * Every file one mission's tasks produced, with the grouping the Outputs page
 * uses (work item per artifact), so the mission's Outputs tab shows the same
 * Result cards as the workspace page. Reads only the lists those pages read.
 */
export async function loadMissionFiles(workspaceId: string, mission: Mission, signal: AbortSignal): Promise<Envelope<MissionFiles>> {
  const read = <T,>(queryType: "executionLinks.list" | "workItems.list") =>
    query<Envelope<{ items: T[] }>>({ queryType, workspaceId, limit: 100 }, signal);
  const [links, items] = await Promise.all([read<ExecutionLink>("executionLinks.list"), read<WorkItem>("workItems.list")]);
  const missionLinks = links.snapshot.items.filter((link) => link.missionId === mission.missionId);
  const workItems = items.snapshot.items.filter((item) => item.missionId === mission.missionId);
  const producers = new Map<string, { workItemId: string; jobId?: string }>();
  for (const link of missionLinks) {
    const key = link.jobId ? `job:${link.jobId}` : `item:${link.workItemId}`;
    if (!producers.has(key)) producers.set(key, { workItemId: link.workItemId, ...(link.jobId ? { jobId: link.jobId } : {}) });
  }
  const groupOf: Record<string, string> = {};
  const artifacts = new Map<string, OutputItem>();
  await Promise.all(
    [...producers.values()].slice(0, 40).map(async (producer) => {
      for (const state of ["uploading", "verified"] as const) {
        const found = await artifactsListQuery({ workspaceId, state, ...(producer.jobId ? { jobId: producer.jobId } : { workItemId: producer.workItemId }) }, signal);
        for (const artifact of found.snapshot.items) {
          groupOf[artifact.artifactId] ??= producer.workItemId;
          if (!artifacts.has(artifact.artifactId)) artifacts.set(artifact.artifactId, { ...artifact, state });
        }
      }
    }),
  );
  return {
    snapshot: {
      artifacts: [...artifacts.values()],
      grouping: { workItems, missionTitles: { [mission.missionId]: mission.title }, groupOf, links: missionLinks },
    },
    asOf: links.asOf,
    sourceWatermark: links.sourceWatermark,
  };
}
