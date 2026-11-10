import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { FileCard } from "@talelk/newui-molecules";
import type { Mission, Output, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "../components/Domain";
import { TechnicalDetails } from "../components/PageLayout";
import { formatRelative } from "../format";
import { execOutputsUrl } from "../exec/exec-filters";
import type { FileBadgeTheme } from "./output-files";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** The status a named output shows: its latest version's state and verification. */
function outputStatus(output: Output): { label: string; theme: FileBadgeTheme } {
  const latest = output.versions.at(-1);
  if (!latest) return { label: "No version yet", theme: "gray" };
  if (latest.verified) return { label: "Verified", theme: "green" };
  return latest.state === "final" ? { label: "Final", theme: "blue" } : { label: "Draft", theme: "gray" };
}

/**
 * A mission's Outputs tab (#41, T61): its named outputs as files, in one
 * folder per plan task that produced their latest version. Each file opens the
 * named output page with every version, lineage and compare. Reads only
 * `missionOutputs.list` and `workItems.list`; nothing is fetched per file.
 */
export function MissionOutputs(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const outputs = createScopedRead<Output[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: Output[] }>>({ queryType: "missionOutputs.list", workspaceId: scope.workspaceId, resourceId: props.mission.missionId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === props.mission.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  /** Outputs grouped by the plan task whose work produced their latest version; tasks in review first. */
  const groups = createMemo(() => {
    const byTask = new Map<string, { title: string; review: boolean; outputs: Output[] }>();
    for (const output of outputs.state().data ?? []) {
      const producer = items.state().data?.find((item) => item.workItemId === output.versions.at(-1)?.workItemId);
      const title = producer?.title ?? "Not yet produced";
      const group = byTask.get(title) ?? { title, review: producer?.state === "review", outputs: [] };
      group.outputs.push(output);
      byTask.set(title, group);
    }
    return [...byTask.values()].sort((left, right) => Number(right.review) - Number(left.review));
  });
  const latestAt = (output: Output) => output.versions.at(-1)?.createdAt ?? output.createdAt;

  return (
    <WorkspaceSection
      title="Mission outputs"
      description="Named outputs as files, in one folder per plan task. Only verified final versions feed other work."
      actions={
        <Button size="sm" variant="ghost" iconLeft="lucide-folder-open" onClick={() => void navigate(execOutputsUrl(props.mission.workspaceId))}>
          Browse all outputs
        </Button>
      }
    >
      <ScreenRegion
        state={outputs.state()}
        skeleton="cards"
        onRetry={() => void outputs.refresh({ force: true })}
        emptyTitle="No outputs yet"
        emptyDescription="Outputs appear when work records a version of a named output."
      >
        <div class="flex min-w-0 flex-col gap-5">
          <For each={groups()}>
            {(group) => (
              <section class="flex min-w-0 flex-col gap-2" aria-label={`Outputs of ${group.title}`}>
                <header class="flex min-w-0 items-center gap-2">
                  <span class="lucide-folder size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
                  <h3 class="min-w-0 truncate text-interface font-medium text-ink-gray-9">{group.title}</h3>
                  <Show when={group.review}>
                    <Badge size="sm" theme="amber" label="Needs review" />
                  </Show>
                  <span class="text-caption tabular-nums text-ink-gray-6">{group.outputs.length}</span>
                </header>
                <div class="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-2">
                  <For each={group.outputs}>
                    {(output) => {
                      const status = outputStatus(output);
                      const count = output.versions.length;
                      return (
                        <FileCard
                          as="button"
                          size="md"
                          name={output.name}
                          icon="lucide-file-text"
                          aria-label={`Open output ${output.name}`}
                          meta={`${count} ${count === 1 ? "version" : "versions"} · updated ${formatRelative(latestAt(output))}${output.continues ? " · continues earlier work" : ""}`}
                          badge={<Badge size="sm" theme={status.theme} label={status.label} />}
                          onClick={() => void navigate(`/outputs/${encodeURIComponent(output.outputId)}`)}
                        />
                      );
                    }}
                  </For>
                </div>
              </section>
            )}
          </For>
          <TechnicalDetails label="About output versions">
            <p>Versions are immutable. A task input pins one exact verified final version when its attempt is admitted.</p>
          </TechnicalDetails>
        </div>
      </ScreenRegion>
    </WorkspaceSection>
  );
}
