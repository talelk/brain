import type { JSX } from "solid-js";
import { For, Show, createSignal, createEffect } from "solid-js";
import { Badge, Progress } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { EvidenceBundle, VerificationVerdict } from "@brain/contracts";
import { evidenceQuery } from "../../data/governor";
import { ArtifactView } from "../outputs/ArtifactView";
import { DigestValue } from "./DigestValue";
import { StatusBadge, statusHeaderTheme, statusTheme } from "./StatusBadge";

/**
 * Evidence is what makes "done" mean something (document 25).
 *
 * This composition fetches the authoritative bundle, shows its pinned inputs
 * and the independent verdict against it, and links each accepted check to its
 * artifact. A runner exit code or model self-report is never rendered as
 * completion here; only an accepted verdict counts.
 */
export function EvidenceList(props: { bundleDigest?: string; workspaceId?: string; emptyHint?: string }): JSX.Element {
  const [bundle, setBundle] = createSignal<EvidenceBundle | undefined>();
  const [verdict, setVerdict] = createSignal<VerificationVerdict | undefined>();
  const [status, setStatus] = createSignal<"loading" | "ready" | "missing">("loading");
  const [error, setError] = createSignal("");

  let requestGeneration = 0;
  createEffect(() => {
    const digest = props.bundleDigest;
    const workspaceId = props.workspaceId;
    const current = ++requestGeneration;
    setBundle(undefined);
    setVerdict(undefined);
    setStatus("loading");
    setError("");
    if (!digest) {
      setStatus("missing");
      setError(props.emptyHint ?? "No evidence bundle is bound to this record yet.");
      return;
    }
    void evidenceQuery(digest, workspaceId)
      .then((loaded) => {
        if (current !== requestGeneration) return;
        setBundle(loaded.snapshot.bundle);
        if (loaded.snapshot.verdict) setVerdict(loaded.snapshot.verdict);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (current !== requestGeneration) return;
        setStatus("missing");
        setError(e instanceof Error ? e.message : "Evidence is not available.");
      });
  });

  const current = () => verdict();

  return (
    <Show when={status() !== "loading"} fallback={<Progress indeterminate label="Loading evidence" />}>
      <Show when={bundle()} fallback={<Alert theme="amber" variant="outline" title="No accepted evidence" description={error()} />}>
        <div class="flex min-w-0 flex-col gap-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <Badge size="sm"
              theme={current() ? statusTheme("evidence", current()!.outcome) : "gray"}
              label={current() ? `Verdict: ${current()!.outcome}` : "Pending verification"}
            />
            <span class="min-w-0 break-all text-caption text-ink-gray-7">
              {bundle()!.jobId ? `job ${bundle()!.jobId}` : "record"} · {bundle()!.artifacts.length} artifacts
            </span>
          </div>
          <dl class="grid grid-cols-1 gap-2 border-y border-outline-gray-1 py-2 text-caption sm:grid-cols-3">
            <div class="min-w-0"><dt class="text-ink-gray-6">Configuration</dt><dd class="mt-1"><DigestValue value={bundle()!.configDigest} label="Configuration digest" /></dd></div>
            <div class="min-w-0"><dt class="text-ink-gray-6">Source revision</dt><dd class="mt-1"><DigestValue value={bundle()!.sourceRevision} label="Source revision" /></dd></div>
            <div class="min-w-0"><dt class="text-ink-gray-6">Pinned primitives</dt><dd class="mt-1 font-medium text-ink-gray-9">{Object.keys(bundle()!.primitiveVersions).length}</dd></div>
          </dl>
          <Show when={current()}>
            <Alert
              theme={statusHeaderTheme("evidence", current()!.outcome)}
              variant="outline"
              title={`Independent verdict: ${current()!.outcome}`}
              description={`Evaluator attempt ${current()!.evaluatorAttemptId} · independence ${current()!.independence} · ${current()!.checks.filter((c) => c.status === "passed").length}/${current()!.checks.length} checks passed`}
            />
            <For each={current()!.checks}>
              {(check) => (
                <div class="flex items-center justify-between gap-2 border-b border-outline-gray-1 py-1">
                  <span class="min-w-0 truncate text-interface text-ink-gray-9" title={check.criterionId ?? check.checkId}>{check.criterionId ?? check.checkId}</span>
                  <StatusBadge kind="check" status={check.status} />
                </div>
              )}
            </For>
          </Show>
          <Show when={bundle()!.artifacts.length}>
            <div class="flex min-w-0 flex-col gap-3">
              <For each={bundle()!.artifacts}>{(artifact) => <ArtifactView artifact={artifact} compact />}</For>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
