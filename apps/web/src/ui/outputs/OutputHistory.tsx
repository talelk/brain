import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import { Alert, EmptyState, Timeline } from "@talelk/newui-molecules";
import type { BadgeTheme } from "@talelk/newui-atoms";
import type { ExecutionLink } from "@brain/contracts";
import { DateText, RelativeTime } from "../screen-region";
import { shortDigest } from "../format";
import { missionHref } from "../mission-links";
import { StatusIcon } from "../viz/StatusIcon";
import type { ArtifactHistory } from "../../data/exec-outputs";

/**
 * Version history, independent verification and work-item association for one
 * artifact (plan T61). The history rows are evidence bundles that pin the
 * artifact's digest, so "version/snapshot" is the digest and each version
 * carries its producer attempt and the independent verdict against it.
 * Independent verification stays authoritative for completion — the browser
 * displays it, it never derives completion from the artifact itself.
 */

export interface VerificationSummary {
  label: string;
  theme: BadgeTheme;
  detail: string;
}

/** The governing verdict for this digest: the newest bundle that carries one. */
export function verificationSummary(history: ArtifactHistory | undefined): VerificationSummary {
  const verdict = history?.history.find((version) => version.verification)?.verification;
  if (verdict?.outcome === "verified")
    return { label: "Verified", theme: "green", detail: "An independent evaluator verified an evidence bundle pinning this digest." };
  if (verdict?.outcome === "rejected") return { label: "Rejected", theme: "red", detail: "The newest independent verdict against this digest was rejected." };
  if (verdict?.outcome === "incomplete")
    return { label: "Inconclusive", theme: "amber", detail: "The newest independent verdict could not complete its checks." };
  return {
    label: "Unverified",
    theme: "gray",
    detail: "No evidence bundle with an independent verdict pins this digest yet. Verification remains authoritative for completion.",
  };
}

/** The work item this artifact's producer is linked to, resolved from the workspace's execution links. */
export function resolveWorkItemLink(executions: readonly ExecutionLink[], history: ArtifactHistory | undefined): ExecutionLink | undefined {
  const producer = history?.producer;
  if (!producer) return undefined;
  return executions.find((link) => (producer.attemptId && link.attemptId === producer.attemptId) || (producer.jobId && link.jobId === producer.jobId));
}

/** The work item lives on its mission's plan tab, where Done and evidence are handled. */
export function workItemPlanUrl(workspaceId: string, missionId: string): string {
  return missionHref(workspaceId, missionId, "plan");
}

/**
 * The one metadata strip every artifact surface shows: source, version/snapshot,
 * producer, generation time, size, verification status and work-item
 * association (the plan's "every artifact shows" list).
 */
export function ArtifactMetaStrip(props: {
  history: ArtifactHistory | undefined;
  loading: boolean;
  error: string;
  executions?: readonly ExecutionLink[];
}): JSX.Element {
  const verification = () => verificationSummary(props.history);
  const link = () => (props.executions ? resolveWorkItemLink(props.executions, props.history) : undefined);
  return (
    <Show
      when={props.loading}
      fallback={
        <Show when={!props.error} fallback={<Alert theme="amber" variant="outline" title="Metadata unavailable" description={props.error} />}>
          <Show when={props.history} fallback={<p class="text-base text-ink-gray-7">No artifact is identified yet.</p>}>
            <dl class="grid grid-cols-2 gap-x-4 text-caption" aria-label="Artifact metadata">
              <MetaFact label="Workspace" value={props.history!.workspaceId} />
              <MetaFact label="Digest" value={<span class="brain-exec-log" title={props.history!.digest}>{shortDigest(props.history!.digest)}</span>} title="Immutable content address" />
              <MetaFact label="Producer" value={<ProducerLinks history={props.history!} />} />
              <MetaFact label="Generated" value={<DateText value={props.history!.createdAt} />} />
              <MetaFact label="Size" value={`${props.history!.bytes.toLocaleString()} B`} />
              <MetaFact label="Verification" value={<span class="inline-flex items-center gap-1.5"><StatusIcon state={verification().label} theme={verification().theme} /><Badge size="sm" theme={verification().theme} label={verification().label} /></span>} title={verification().detail} />
              <MetaFact label="Work item" value={
                <Show when={link()} fallback={<span class="text-ink-gray-6">Not linked</span>}>
                  <a class="break-all text-ink-blue-7 hover:underline focus-visible:focus-ring" href={workItemPlanUrl(props.history!.workspaceId, link()!.missionId)}>
                    {shortDigest(link()!.workItemId, 10)}
                  </a>
                </Show>
              } />
            </dl>
          </Show>
        </Show>
      }
    >
      <p role="status" class="text-base text-ink-gray-7">
        Loading artifact metadata…
      </p>
    </Show>
  );
}

function MetaFact(props: { label: string; value: JSX.Element; title?: string }): JSX.Element {
  return <div class="min-w-0 py-1.5" title={props.title}><dt class="text-ink-gray-6">{props.label}</dt><dd class="mt-1 min-w-0 break-words font-medium text-ink-gray-9">{props.value}</dd></div>;
}

function ProducerLinks(props: { history: ArtifactHistory }): JSX.Element {
  const producer = () => props.history.producer;
  return (
    <Show when={producer()} fallback={<span class="text-ink-gray-6">Unknown producer</span>}>
      <span class="flex flex-wrap items-center gap-2">
        <Show when={producer()?.attemptId}>
          <a
            class="text-ink-blue-7 underline focus-visible:focus-ring"
            href={`/runs/${producer()!.jobId}?attempt=${encodeURIComponent(producer()!.attemptId!)}`}
          >
            Attempt {producer()!.number ?? "—"}
          </a>
        </Show>
        <Show when={producer()?.jobId}>
          <a class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${producer()!.jobId}`}>
            Run inspector
          </a>
        </Show>
        <Show when={producer()?.state}>
          <Badge theme="gray" label={producer()!.state!} />
        </Show>
      </span>
    </Show>
  );
}

/** The version history: evidence bundles pinning this digest, newest first, each with its verdict. */
export function OutputHistory(props: { history: ArtifactHistory | undefined; loading: boolean; error: string }): JSX.Element {
  const verification = () => verificationSummary(props.history);
  return (
    <div class="brain-detail-stack">
      <div class="flex items-start gap-2 rounded-card border border-outline-gray-2 p-3 text-base text-ink-gray-8" data-testid="outputs-verification">
        <StatusIcon state={verification().label} theme={verification().theme} class="mt-0.5 size-4" />
        <span class="min-w-0"><strong class="font-medium">{verification().label}.</strong> {verification().detail}</span>
      </div>
      <Show
        when={props.loading}
        fallback={
          <Show when={!props.error} fallback={<Alert theme="amber" variant="outline" title="History unavailable" description={props.error} />}>
            <Show
              when={props.history}
              fallback={
                <EmptyState size="sm"
                  icon="lucide-history"
                  title="No artifact selected"
                  description="Select an artifact to see the evidence bundles that pin it over time."
                />
              }
            >
              <Show
                when={props.history!.history.length}
                fallback={
                  <p class="text-base text-ink-gray-7">
                    No evidence bundle pins this digest yet. Brain binds the final artifact digest and its verification when the run completes.
                  </p>
                }
              >
                <Timeline
                  items={props.history!.history.map((version) => {
                    const outcome = version.verification?.outcome;
                    return {
                      id: version.bundleDigest,
                      title: (
                        <span class="flex flex-wrap items-center gap-2">
                          <span>{outcome ? `Checked: ${outcome}` : "Recorded"}</span>
                          <Badge size="sm" theme={versionTheme(version.state)} label={version.state} />
                        </span>
                      ),
                      description: (
                        <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span title={version.bundleDigest}>bundle {shortDigest(version.bundleDigest)}</span>
                          <a class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${version.jobId}?attempt=${encodeURIComponent(version.attemptId)}`}>
                            Producing attempt
                          </a>
                        </span>
                      ),
                      timestamp: <RelativeTime value={version.verification?.at ?? version.createdAt} />,
                      tone: outcome === "verified" ? ("green" as const) : outcome === "rejected" ? ("red" as const) : outcome ? ("amber" as const) : ("gray" as const),
                      icon: outcome === "verified" ? "lucide-check" : outcome === "rejected" ? "lucide-x" : outcome ? "lucide-triangle-alert" : "lucide-file-clock",
                    };
                  })}
                />
              </Show>
            </Show>
          </Show>
        }
      >
        <p role="status" class="text-base text-ink-gray-7">
          Loading version history…
        </p>
      </Show>
    </div>
  );
}

function versionTheme(state: string): BadgeTheme {
  if (state === "verified") return "green";
  if (state === "rejected") return "red";
  if (state === "incomplete" || state === "submitted") return "amber";
  return "gray";
}
