import type { JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import { A } from "@solidjs/router";
import { Badge } from "@talelk/newui-atoms";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { DateText } from "../screen-region";

export interface ToolCallView {
  proposalId: string;
  runId: string;
  proposedAt: string;
  finishedAt?: string;
  outcome: "failed" | "succeeded" | "running" | "no-result";
  message?: string;
  diagnosis?: { cause: string; headline: string; nextStep: string };
}
export interface ToolCallsSnapshot {
  toolId: string;
  items: ToolCallView[];
  causes: Array<{ cause: string; headline: string; nextStep: string; count: number }>;
}

const OUTCOME: Record<ToolCallView["outcome"], { label: string; theme: "green" | "red" | "amber" | "blue" }> = {
  succeeded: { label: "Worked", theme: "green" },
  failed: { label: "Failed", theme: "red" },
  "no-result": { label: "No result", theme: "amber" },
  running: { label: "Running", theme: "blue" },
};

/**
 * What happened to this tool's recent calls, in plain words: failures grouped by cause with the next step, then the calls themselves
 * with the exact error and a link to the run. A call with no recorded result says so instead of reading as a success.
 */
export function ToolCallsPanel(props: { toolId: string }): JSX.Element {
  const app = useApp();
  const read = createScopedRead<ToolCallsSnapshot>({
    scope: app.scope,
    resource: () => props.toolId,
    load: async (scope, signal, toolId) => {
      const response = await query<{ snapshot: ToolCallsSnapshot; asOf: string; sourceWatermark: number }>({ queryType: "tools.calls", workspaceId: scope.workspaceId, resourceId: toolId ?? props.toolId, limit: 30 }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (data) => data.items.length === 0,
    refreshMs: 30_000,
  });
  const data = createMemo(() => read.state().data);
  return (
    <div class="flex flex-col gap-4" data-tool-history>
      <Show when={read.state().status === "loading" && !data()}><p class="text-interface text-ink-gray-7">Reading recent calls…</p></Show>
      <Show when={read.state().error && !data()}><p class="text-interface text-ink-red-7" role="alert">Recent calls could not be read: {read.state().error}</p></Show>
      <Show when={data() && data()!.items.length === 0}><p class="text-interface text-ink-gray-7" data-tool-history-empty>No calls of this tool are recorded in this workspace yet.</p></Show>
      <Show when={data() && data()!.causes.length > 0}>
        <section aria-label="Why calls failed" class="flex flex-col gap-3" data-tool-causes>
          <h3 class="text-label text-ink-gray-8">Why calls failed</h3>
          <For each={data()!.causes}>
            {(cause) => (
              <div class="rounded-md border border-outline-gray-1 p-3" data-tool-cause={cause.cause}>
                <div class="flex flex-wrap items-center gap-2"><Badge variant="outline" theme="red" label={`${cause.count} ${cause.count === 1 ? "call" : "calls"}`} /><span class="text-interface text-ink-gray-8">{cause.headline}</span></div>
                <p class="mt-2 text-caption text-ink-gray-7"><strong>Next:</strong> {cause.nextStep}</p>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show when={data() && data()!.items.length > 0}>
        <section aria-label="Recent calls" class="flex flex-col gap-2" data-tool-recent-calls>
          <h3 class="text-label text-ink-gray-8">Recent calls</h3>
          <ul class="flex flex-col divide-y divide-outline-gray-1">
            <For each={data()!.items}>
              {(call) => (
                <li class="flex flex-col gap-1 py-2" data-tool-call-outcome={call.outcome}>
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" theme={OUTCOME[call.outcome].theme} label={OUTCOME[call.outcome].label} />
                    <DateText value={call.proposedAt} />
                    <Show when={call.runId}><A class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${call.runId}`}>Open the run</A></Show>
                  </div>
                  <Show when={call.message}><p class="break-words text-caption text-ink-gray-8">{call.message}</p></Show>
                  <Show when={call.diagnosis}><p class="text-caption text-ink-gray-7">{call.diagnosis!.headline} <span class="text-ink-gray-6">{call.diagnosis!.nextStep}</span></p></Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  );
}
