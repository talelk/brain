import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import type { StreamCorrelation } from "../../data/exec-logs";
import { execArtifactUrl, execLogsUrl, execOutputsUrl, type ExecLogFilters } from "./exec-filters";

/**
 * Correlation jumps (plan §2 P0): every log record, tool call and output links
 * to its exact execution context with persistent filters. The href builders
 * live in exec-filters.ts; this component only renders and navigates them.
 */

export type ExecCorrelationTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "job"; jobId: string }
  | { kind: "attempt"; jobId: string; attemptId: string }
  | { kind: "run"; runId: string }
  | { kind: "approval"; approvalId: string }
  | { kind: "artifact"; artifactId: string; diff?: { leftId: string; rightId: string } }
  | { kind: "logs"; workspaceId: string; filters?: ExecLogFilters }
  | { kind: "outputs"; workspaceId: string; jobId?: string; runId?: string; workItemId?: string };

export function execTargetHref(target: ExecCorrelationTarget): string {
  switch (target.kind) {
    case "session": return `/sessions/${target.sessionId}`;
    case "job": return `/jobs/${target.jobId}`;
    case "attempt": return `/jobs/${target.jobId}?attempt=${encodeURIComponent(target.attemptId)}`;
    case "run": return `/jobs/${target.runId}`;
    case "approval": return `/approvals/${target.approvalId}`;
    case "artifact": return execArtifactUrl(target.artifactId, target.diff);
    case "logs": return execLogsUrl(target.workspaceId, target.filters ?? { severity: [], emitter: [] });
    case "outputs": return execOutputsUrl(target.workspaceId, { jobId: target.jobId, runId: target.runId, workItemId: target.workItemId });
  }
}

const chip = "brain-exec-log inline-flex max-w-48 items-center gap-1 truncate rounded-control border border-outline-gray-2 px-1.5 py-0.5 text-xs text-ink-blue-8 hover:border-outline-blue-3 hover:bg-surface-blue-1 focus-visible:focus-ring";

/** One correlation jump rendered as a navigable chip. */
export function CorrelationLink(props: { target: ExecCorrelationTarget; label: string; icon?: string; class?: string }): JSX.Element {
  return <A href={execTargetHref(props.target)} class={`${chip} ${props.class ?? ""}`} title={props.label}>
    <Show when={props.icon}><span class={`${props.icon} size-3 shrink-0`} aria-hidden="true" /></Show>
    <span class="truncate">{props.label}</span>
  </A>;
}

const CORRELATION_ICONS = { session: "lucide-square-terminal", job: "lucide-workflow", run: "lucide-git-branch", attempt: "lucide-repeat", workItem: "lucide-list-todo", invocation: "lucide-wrench", proposal: "lucide-wrench" } as const;

/** The correlation chips for one stream record's correlation bundle. */
export function CorrelationChips(props: { correlation?: StreamCorrelation }): JSX.Element {
  return <Show when={props.correlation}>
    <span class="flex flex-wrap items-center gap-1">
      <For each={correlationTargets(props.correlation)}>
        {(target) => <CorrelationLink target={target.target} label={target.label} icon={target.icon} />}
      </For>
    </span>
  </Show>;
}

function correlationTargets(correlation: StreamCorrelation | undefined): Array<{ target: ExecCorrelationTarget; label: string; icon: string }> {
  if (!correlation) return [];
  const targets: Array<{ target: ExecCorrelationTarget; label: string; icon: string }> = [];
  if (correlation.sessionId) targets.push({ target: { kind: "session", sessionId: correlation.sessionId }, label: `session ${shortId(correlation.sessionId)}`, icon: CORRELATION_ICONS.session });
  if (correlation.jobId) targets.push({ target: { kind: "job", jobId: correlation.jobId }, label: `job ${shortId(correlation.jobId)}`, icon: CORRELATION_ICONS.job });
  if (correlation.runId) targets.push({ target: { kind: "run", runId: correlation.runId }, label: `run ${shortId(correlation.runId)}`, icon: CORRELATION_ICONS.run });
  if (correlation.attemptId && correlation.jobId) targets.push({ target: { kind: "attempt", jobId: correlation.jobId, attemptId: correlation.attemptId }, label: `attempt ${shortId(correlation.attemptId)}`, icon: CORRELATION_ICONS.attempt });
  return targets;
}

/** Bounded chip labels: ids are long digests, chips show the readable head. */
function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 11)}…` : id;
}
