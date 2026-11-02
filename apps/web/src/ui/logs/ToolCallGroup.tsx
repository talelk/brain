import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, KeyValue } from "@talelk/newui-atoms";
import { createScopedRead } from "../../data/screens";
import { streamContextQuery } from "../../data/exec-logs";
import type { StreamContextBundle } from "../../data/exec-logs";
import type { ArtifactRef } from "../../data/exec-outputs";
import { shortDigest } from "../../ui/format";
import { ScreenRegion } from "../screen-region";
import { DateText } from "../screen-region";
import { DisclosureCard } from "../components/primitives";
import { CorrelationLink } from "../exec/CorrelationLink";
import { ArtifactView } from "../outputs/ArtifactView";
import { useApp } from "../app-context";
import { receiptDuration, receiptOf, toolIdentity } from "./LogRow";
import type { LogRowModel } from "./LogRow";

/**
 * The expansion of one tool invocation group (T61): tool identity, sanitized
 * arguments, stdout and stderr previews, duration, exit status, the result
 * artifact and the linked effect receipt — every fact read from the projected
 * records and the invocation's correlation bundle. Previews render through the
 * outputs module's one ArtifactView policy; no invented thought process: what
 * the engine exposed is all this view can show.
 */

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Classification = ArtifactRef["classification"];
const CLASSIFICATIONS: readonly Classification[] = ["public", "internal", "confidential", "restricted"];
const isClassification = (value: unknown): value is Classification =>
  typeof value === "string" && (CLASSIFICATIONS as readonly string[]).includes(value);

function artifactRefOf(value: unknown): ArtifactRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref["artifactId"] !== "string" || typeof ref["digest"] !== "string") return undefined;
  return {
    artifactId: ref["artifactId"],
    digest: ref["digest"],
    bytes: typeof ref["bytes"] === "number" ? ref["bytes"] : 0,
    mediaType: typeof ref["mediaType"] === "string" ? ref["mediaType"] : "application/octet-stream",
    classification: isClassification(ref["classification"]) ? ref["classification"] : "internal",
  };
}

export function ToolCallGroup(props: { group: Extract<LogRowModel, { kind: "tool" }> }): JSX.Element {
  const app = useApp();
  const result = () => props.group.result;
  const receipt = () => receiptOf(result());
  const proposed = () => props.group.proposed;
  const context = createScopedRead<StreamContextBundle>({
    scope: app.scope,
    resource: () => result()?.eventId,
    load: (_scope, signal, resource) => streamContextQuery(resource ?? "", signal),
    isEmpty: () => false,
  });

  const invocation = () => context.state().data?.invocation;
  const stdoutRef = () => artifactRefOf(receipt()?.stdout);
  const stderrRef = () => artifactRefOf(receipt()?.stderr);
  const resultArtifacts = () => context.state().data?.artifacts ?? [];

  return <div class="flex flex-col gap-3" data-testid="tool-call-group">
    <div class="flex flex-wrap items-center gap-2">
      <span class="lucide-wrench size-4 text-ink-blue-8" aria-hidden="true" />
      <span class="brain-exec-log text-base-medium text-ink-gray-9">{toolIdentity(proposed() ?? result())}</span>
      <Show when={receipt()?.result}><Badge size="sm" variant="outline" theme={receipt()?.result === "succeeded" ? "green" : receipt()?.result === "failed" ? "red" : "amber"} label={receipt()?.result ?? ""} /></Show>
      <Show when={toolIdentity(proposed() ?? result()) === "tool invocation"}><span class="text-caption text-ink-gray-6">identity arrives with the proposal record</span></Show>
    </div>
    <div class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
      <KeyValue label="Proposal" value={<span class="brain-exec-log break-all">{props.group.proposalKey}</span>} orientation="vertical" />
      <KeyValue label="Invocation" value={<span class="brain-exec-log break-all">{receipt()?.invocationId ?? "—"}</span>} orientation="vertical" />
      <KeyValue label="Duration" value={receiptDuration(receipt())} orientation="vertical" />
      <KeyValue label="Exit status" value={receipt()?.exitCode !== undefined ? `exit ${receipt()?.exitCode}` : receipt()?.result ?? "—"} orientation="vertical" />
      <KeyValue label="Started" value={<DateText value={receipt()?.startedAt} />} orientation="vertical" />
      <KeyValue label="Finished" value={<DateText value={receipt()?.finishedAt} />} orientation="vertical" />
    </div>

    <div class="flex flex-col gap-3" data-testid="tool-outputs">
      <Show when={stdoutRef()}>{(ref) => (
        <div class="rounded-card border border-outline-gray-1 p-card-pad">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-base-medium text-ink-gray-8">stdout</h3>
            <div class="flex items-center gap-2">
              <span class="text-caption text-ink-gray-6">{ref().mediaType} · {formatBytes(ref().bytes)}</span>
              <CorrelationLink target={{ kind: "artifact", artifactId: ref().artifactId }} label="Open in Outputs" icon="lucide-external-link" />
            </div>
          </div>
          <ArtifactView artifact={ref()} title="stdout" compact />
        </div>
      )}</Show>
      <Show when={stderrRef()}>{(ref) => (
        <div class="rounded-card border border-outline-gray-1 p-card-pad">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-base-medium text-ink-gray-8">stderr</h3>
            <div class="flex items-center gap-2">
              <span class="text-caption text-ink-gray-6">{ref().mediaType} · {formatBytes(ref().bytes)}</span>
              <CorrelationLink target={{ kind: "artifact", artifactId: ref().artifactId }} label="Open in Outputs" icon="lucide-external-link" />
            </div>
          </div>
          <ArtifactView artifact={ref()} title="stderr" compact />
        </div>
      )}</Show>
      <Show when={!stdoutRef() && !stderrRef()}>
        <span class="text-caption text-ink-gray-6">The receipt declares no stdout/stderr artifact; output text stays in the record summaries below.</span>
      </Show>
    </div>

    <Show when={resultArtifacts().length > 0}>
      <div>
        <h3 class="text-base-medium text-ink-gray-8">Result artifacts</h3>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <For each={resultArtifacts()}>{(artifact) => (
            <CorrelationLink target={{ kind: "artifact", artifactId: artifact.artifactId }}
              label={`${artifact.mediaType} · ${shortDigest(artifact.digest, 8)} · ${formatBytes(artifact.bytes)}`}
              icon="lucide-package" class="w-80" />
          )}</For>
        </div>
      </div>
    </Show>

    <div>
      <h3 class="text-base-medium text-ink-gray-8">Linked effect receipt</h3>
      <Show when={invocation()} fallback={
        <p class="mt-1 text-caption text-ink-gray-6">
          This invocation has no effect permit on record — it either needed no external effect or the record is not retained.
        </p>}>
        <div class="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <KeyValue label="Permit state" value={invocation()!.state} orientation="vertical" />
          <KeyValue label="Permit" value={<span class="brain-exec-log break-all">{invocation()!.permitId}</span>} orientation="vertical" />
        </div>
        <Show when={invocation()?.approvalId}>
          <div class="mt-2">
            <CorrelationLink target={{ kind: "approval", approvalId: invocation()!.approvalId! }} label={`approval ${invocation()!.approvalId!.slice(0, 11)}…`} icon="lucide-shield-check" />
          </div>
        </Show>
      </Show>
      <Show when={(receipt()?.effects.length ?? 0) > 0}>
        <ul class="brain-exec-log mt-2 list-none p-0">
          <For each={receipt()?.effects}>{(effect, index) => {
            const view = (effect ?? {}) as Record<string, unknown>;
            return <li class="flex items-center gap-2 border-b border-outline-gray-1 py-1" data-testid={`tool-effect-${index()}`}>
              <span class="w-48 shrink-0 truncate text-ink-gray-8" title={String(view["operation"] ?? "")}>{String(view["operation"] ?? "effect")}</span>
              <span class="text-ink-gray-7">{String(view["outcome"] ?? "unknown")}</span>
            </li>;
          }}</For>
        </ul>
      </Show>
    </div>

    <div class="flex flex-col gap-2">
      <Show when={proposed()}>{(proposal) => (
        <DisclosureCard label="Sanitized arguments (proposal record)">
          <pre class="brain-exec-log max-h-72 overflow-auto text-ink-gray-7">{JSON.stringify(proposal().summary, null, 2)}</pre>
          <p class="mt-2 text-caption text-ink-gray-6">Recorded <DateText value={proposal().at} /> · stream_seq {proposal().streamSeq}</p>
        </DisclosureCard>
      )}</Show>
      <Show when={result()}>{(record) => (
        <DisclosureCard label="Raw result record (original redacted payload)">
          <pre class="brain-exec-log max-h-72 overflow-auto text-ink-gray-7">{JSON.stringify({ streamSeq: record().streamSeq, eventId: record().eventId, at: record().at, payloadRef: record().payloadRef ?? undefined, summary: record().summary }, null, 2)}</pre>
        </DisclosureCard>
      )}</Show>
    </div>

    <ScreenRegion state={context.state()} skeleton="rows"
      emptyTitle="Correlation not found" emptyDescription="The invocation's records may have aged out of the retained stream."
      onRetry={() => void context.refresh({ force: true })}>
      <span class="hidden" />
    </ScreenRegion>
  </div>;
}
