import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { BadgeTheme } from "@talelk/newui-atoms";
import type { ExecutionLink } from "@brain/contracts";
import { DateText, RelativeTime } from "../screen-region";
import { shortDigest } from "../format";
import { EmptyPreview } from "../components/Domain";
import type { ArtifactHistory, ArtifactVersion } from "../../data/exec-outputs";

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

export function workItemBoardUrl(workspaceId: string, workItemId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/board?card=${encodeURIComponent(workItemId)}`;
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
            <dl class="grid grid-cols-2 border-y border-outline-gray-1 text-caption sm:grid-cols-3 xl:grid-cols-7" aria-label="Artifact metadata">
              <MetaFact label="Workspace" value={props.history!.workspaceId} />
              <MetaFact label="Digest" value={<span class="brain-exec-log" title={props.history!.digest}>{shortDigest(props.history!.digest)}</span>} title="Immutable content address" />
              <MetaFact label="Producer" value={<ProducerLinks history={props.history!} />} />
              <MetaFact label="Generated" value={<DateText value={props.history!.createdAt} />} />
              <MetaFact label="Size" value={`${props.history!.bytes.toLocaleString()} B`} />
              <MetaFact label="Verification" value={<Badge size="sm" theme={verification().theme} label={verification().label} />} title={verification().detail} />
              <MetaFact label="Work item" value={
                <Show when={link()} fallback={<span class="text-ink-gray-6">Not linked</span>}>
                  <a class="break-all text-ink-blue-7 hover:underline focus-visible:focus-ring" href={workItemBoardUrl(props.history!.workspaceId, link()!.workItemId)}>
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
  return <div class="min-w-0 border-outline-gray-1 px-2 py-2 first:pl-0 sm:border-l sm:first:border-l-0" title={props.title}><dt class="text-ink-gray-6">{props.label}</dt><dd class="mt-1 min-w-0 break-words font-medium text-ink-gray-9">{props.value}</dd></div>;
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
  const alertTheme = (): "gray" | "green" | "red" | "amber" =>
    verification().theme === "gray" ? "gray" : verification().theme === "green" ? "green" : verification().theme === "red" ? "red" : "amber";
  return (
    <div class="brain-detail-stack">
      <Alert theme={alertTheme()} variant="outline" title={`Independent verification: ${verification().label}`} description={verification().detail} />
      <Show
        when={props.loading}
        fallback={
          <Show when={!props.error} fallback={<Alert theme="amber" variant="outline" title="History unavailable" description={props.error} />}>
            <Show
              when={props.history}
              fallback={
                <EmptyPreview
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
                <ol class="m-0 list-none p-0">
                  <For each={props.history!.history}>{(version) => <VersionRow version={version} />}</For>
                </ol>
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

function VersionRow(props: { version: ArtifactVersion }): JSX.Element {
  const outcome = () => props.version.verification?.outcome;
  return (
    <li class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-1.5 last:border-0">
      <span class="flex min-w-0 flex-wrap items-center gap-2 text-interface text-ink-gray-8">
        <Badge size="sm" theme={versionTheme(props.version.state)} label={props.version.state} />
        <span class="text-caption text-ink-gray-6" title={props.version.bundleDigest}>
          bundle {shortDigest(props.version.bundleDigest)}
        </span>
        <span class="text-caption text-ink-gray-6">
          generated <RelativeTime value={props.version.createdAt} />
        </span>
      </span>
      <span class="flex flex-wrap items-center gap-control-gap">
        <Show when={outcome()}>
          <Badge theme={outcome() === "verified" ? "green" : outcome() === "rejected" ? "red" : "amber"} label={`Verdict: ${outcome()}`} />
          <span class="text-caption text-ink-gray-6">
            <RelativeTime value={props.version.verification?.at} />
          </span>
        </Show>
        <a
          class="text-caption text-ink-blue-7 underline focus-visible:focus-ring"
          href={`/runs/${props.version.jobId}?attempt=${encodeURIComponent(props.version.attemptId)}`}
        >
          Producing attempt
        </a>
      </span>
    </li>
  );
}

function versionTheme(state: string): BadgeTheme {
  if (state === "verified") return "green";
  if (state === "rejected") return "red";
  if (state === "incomplete" || state === "submitted") return "amber";
  return "gray";
}
