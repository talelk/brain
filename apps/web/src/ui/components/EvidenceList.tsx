import type { JSX } from "solid-js";
import { For, Show, createSignal, createEffect } from "solid-js";
import { Badge, Button, KeyValue, Progress } from "@talelk/newui-atoms";
import { Alert, List } from "@talelk/newui-molecules";
import type { EvidenceBundle, VerificationVerdict } from "@brain/contracts";
import { evidenceQuery } from "../../data/governor";

/**
 * Evidence is what makes "done" mean something (document 25).
 *
 * This composition fetches the authoritative bundle, shows its pinned inputs
 * and the independent verdict against it, and links each accepted check to its
 * artifact. A runner exit code or model self-report is never rendered as
 * completion here; only an accepted verdict counts.
 */
export function EvidenceList(props: {
  bundleDigest?: string;
  workspaceId?: string;
  emptyHint?: string;
}): JSX.Element {
  const [bundle, setBundle] = createSignal<EvidenceBundle | undefined>();
  const [verdict, setVerdict] = createSignal<VerificationVerdict | undefined>();
  const [status, setStatus] = createSignal<"loading" | "ready" | "missing">("loading");
  const [error, setError] = createSignal("");

  let requestGeneration = 0;
  createEffect(() => {
    const digest = props.bundleDigest;
    const workspaceId = props.workspaceId;
    const current = ++requestGeneration;
    setBundle(undefined); setVerdict(undefined); setStatus("loading"); setError("");
    if (!digest) { setStatus("missing"); setError(props.emptyHint ?? "No evidence bundle is bound to this record yet."); return; }
    void evidenceQuery(digest, workspaceId)
      .then((loaded) => {
        if (current !== requestGeneration) return;
        setBundle(loaded.snapshot.bundle);
        if (loaded.snapshot.verdict) setVerdict(loaded.snapshot.verdict);
        setStatus("ready");
      })
      .catch((e: unknown) => { if (current !== requestGeneration) return; setStatus("missing"); setError(e instanceof Error ? e.message : "Evidence is not available."); });
  });

  const current = () => verdict();

  return (
    <Show when={status() !== "loading"} fallback={<Progress indeterminate label="Loading evidence" />}>
      <Show when={bundle()} fallback={<Alert theme="amber" variant="outline" title="No accepted evidence" description={error()} />}>
        <div class="flex flex-col gap-field-gap">
          <div class="flex flex-wrap items-center gap-control-gap">
            <Badge theme={current() ? (current()!.outcome === "verified" ? "green" : "red") : "gray"} label={current() ? `Verdict: ${current()!.outcome}` : "Pending verification"} />
            <span class="text-caption text-ink-gray-7">
              {bundle()!.jobId ? `job ${bundle()!.jobId}` : "record"} · {bundle()!.artifacts.length} artifacts
            </span>
          </div>
          <KeyValue label="Configuration digest" value={<code class="break-all">{bundle()!.configDigest}</code>} orientation="vertical" />
          <KeyValue label="Source revision" value={bundle()!.sourceRevision} />
          <KeyValue label="Pinned primitives" value={`${Object.keys(bundle()!.primitiveVersions).length} pinned`} />
          <Show when={current()}>
            <Alert theme={current()!.outcome === "verified" ? "green" : "red"} variant="outline"
              title={`Independent verdict: ${current()!.outcome}`}
              description={`Evaluator attempt ${current()!.evaluatorAttemptId} · independence ${current()!.independence} · ${current()!.checks.filter((c) => c.status === "passed").length}/${current()!.checks.length} checks passed`} />
            <For each={current()!.checks}>{(check) => (
              <div class="flex items-center justify-between gap-2 border-b border-outline-gray-1 py-1">
                <span class="truncate text-base text-ink-gray-9">{check.criterionId ?? check.checkId}</span>
                <Badge theme={check.status === "passed" ? "green" : check.status === "missing" ? "amber" : "red"} label={check.status} />
              </div>
            )}</For>
          </Show>
          <Show when={bundle()!.artifacts.length}>
            <List>
              <For each={bundle()!.artifacts}>{(artifact) => (
                <li class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-2">
                  <div class="min-w-0">
                    <p class="truncate text-base-medium text-ink-gray-9">{artifact.artifactId}</p>
                    <p class="break-all text-caption text-ink-gray-7">{artifact.digest} · {artifact.mediaType} · {artifact.bytes} bytes</p>
                  </div>
                  <Button size="sm" onClick={() => { window.location.href = `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`; }}>
                    Open artifact
                  </Button>
                </li>
              )}</For>
            </List>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
