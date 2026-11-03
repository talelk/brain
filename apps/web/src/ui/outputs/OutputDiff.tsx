import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Alert } from "@talelk/newui-molecules";
import { shortDigest } from "../format";
import { artifactsDiffQuery } from "../../data/exec-outputs";
import type { ArtifactDiffResult, DiffOp } from "../../data/exec-outputs";
import { GovernorError } from "../../data/client";

/**
 * The diff view for two artifact versions (plan T61): unified hunks for text,
 * JSON, code and CSV artifacts; binary media refuses with an explanation.
 * Self-contained — it owns the `artifacts.diff` read for the given ids, so the
 * artifact detail page, the console right pane and any inspector can embed it
 * without re-implementing the fetch or the error postures.
 */
export function OutputDiff(props: { leftId: string; rightId: string; maxBytes?: number; onClose?: () => void }): JSX.Element {
  const [diff, setDiff] = createSignal<ArtifactDiffResult>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let generation = 0;
  createEffect(() => {
    const left = props.leftId;
    const right = props.rightId;
    const maxBytes = props.maxBytes;
    const current = ++generation;
    const controller = new AbortController();
    setDiff(undefined);
    setError("");
    setLoading(Boolean(left && right));
    if (!left || !right) return;
    void artifactsDiffQuery({ leftId: left, rightId: right, ...(maxBytes !== undefined ? { maxBytes } : {}) }, controller.signal)
      .then((loaded) => {
        if (current !== generation) return;
        setDiff(loaded.snapshot);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (current !== generation || controller.signal.aborted) return;
        setLoading(false);
        setError(diffErrorText(reason));
      });
  });

  return (
    <Show when={loading()} fallback={<DiffBody diff={diff()} error={error()} onClose={props.onClose} />}>
      <p role="status" class="text-base text-ink-gray-7">
        Comparing versions…
      </p>
    </Show>
  );
}

function diffErrorText(reason: unknown): string {
  if (reason instanceof GovernorError && reason.status === 404) return "One of the two versions no longer exists (or belongs to another workspace).";
  if (reason instanceof GovernorError && (reason.status === 401 || reason.status === 403))
    return "Your account no longer has access to one of these artifacts.";
  return reason instanceof Error ? reason.message : "The comparison could not be completed.";
}

function DiffBody(props: { diff?: ArtifactDiffResult; error: string; onClose?: () => void }): JSX.Element {
  return (
    <Show when={!props.error} fallback={<Alert theme="amber" variant="outline" title="Comparison unavailable" description={props.error} />}>
      <Show when={props.diff} fallback={<p class="text-base text-ink-gray-7">No comparison result.</p>}>
        {(diff) => (
          <div class="brain-detail-stack">
            <div class="flex min-w-0 flex-wrap items-center justify-between gap-control-gap text-caption text-ink-gray-6">
              <span class="flex min-w-0 flex-wrap items-center gap-1.5">
                <VersionChip side={diff().left} label="Left" />
                <span class="lucide-arrow-right size-3.5 shrink-0" aria-hidden="true" />
                <VersionChip side={diff().right} label="Right" />
              </span>
              <Show when={props.onClose}>
                <button type="button" class="text-caption text-ink-blue-7 underline focus-visible:focus-ring" onClick={props.onClose}>
                  Close comparison
                </button>
              </Show>
            </div>
            <Show when={diff().hunks.length === 0} fallback={<For each={diff().hunks}>{(hunk) => <HunkCard hunk={hunk} />}</For>}>
              <Alert
                theme="gray"
                variant="outline"
                title="The two versions are identical"
                description="No textual difference within the compared byte bound."
              />
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
}

function VersionChip(props: { side: { artifactId: string; digest: string; bytes: number; mediaType: string }; label: string }): JSX.Element {
  return (
    <span
      class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-control border border-outline-gray-2 px-1.5 py-0.5"
      title={`${props.side.artifactId} · ${props.side.digest}`}
    >
      <span class="shrink-0 font-medium text-ink-gray-7">{props.label}</span>
      <span class="truncate text-ink-gray-8">{shortDigest(props.side.digest)}</span>
      <span class="shrink-0 text-ink-gray-6">{props.side.bytes.toLocaleString()} B</span>
    </span>
  );
}

const OP_LABELS: Record<DiffOp["type"], string> = { context: "unchanged", add: "added", del: "removed" };

function HunkCard(props: { hunk: { header: string; lines: readonly DiffOp[] } }): JSX.Element {
  return (
    <div class="overflow-hidden rounded-card border border-outline-gray-1">
      <p class="brain-exec-log bg-surface-blue-1 px-3 py-1.5 text-caption text-ink-blue-8" title={props.hunk.header}>
        {props.hunk.header}
      </p>
      <pre class="brain-exec-log m-0 max-h-96 overflow-auto bg-surface-gray-1 p-3 text-caption">
        <For each={props.hunk.lines}>
          {(op) => {
            const tone = op.type === "add" ? "bg-surface-green-2 text-ink-green-9" : op.type === "del" ? "bg-surface-red-2 text-ink-red-9" : "text-ink-gray-8";
            const gutter = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
            const numbers = op.a !== undefined || op.b !== undefined ? `${op.a ?? "—"} / ${op.b ?? "—"}` : undefined;
            return (
              <span
                class={`block whitespace-pre ${tone}`}
                title={numbers ? `Left line ${numbers.split(" / ")[0]} · right line ${numbers.split(" / ")[1]} (${OP_LABELS[op.type]})` : undefined}
              >
                {gutter}
                {op.text || " "}
              </span>
            );
          }}
        </For>
      </pre>
    </div>
  );
}
