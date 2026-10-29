import { Show, createResource } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { ArtifactRef } from "@brain/contracts";

const PREVIEW_LIMIT = 256 * 1024;
const textual = (mediaType: string) => mediaType.startsWith("text/") || /json|markdown|yaml|xml|javascript|typescript/u.test(mediaType);

async function loadPreview(artifact: ArtifactRef): Promise<{ text?: string; truncated: boolean }> {
  if (!textual(artifact.mediaType) || artifact.bytes > PREVIEW_LIMIT) return { truncated: artifact.bytes > PREVIEW_LIMIT };
  const response = await fetch(`/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`, { credentials: "same-origin", headers: { accept: "text/plain, application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string; message?: string };
    throw new Error(body.detail ?? body.message ?? `Artifact could not be read (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoder = new TextDecoder();
  let text = decoder.decode(bytes.subarray(0, PREVIEW_LIMIT));
  if (artifact.mediaType.includes("json")) {
    try { text = JSON.stringify(JSON.parse(text) as unknown, null, 2); } catch { /* Invalid JSON remains visible as source text. */ }
  }
  return { text, truncated: bytes.length > PREVIEW_LIMIT };
}

export function ArtifactContent(props: { artifact?: ArtifactRef; title?: string; compact?: boolean }): JSX.Element {
  const [preview] = createResource(() => props.artifact, loadPreview);
  return <Show when={props.artifact} fallback={<p class="text-base text-ink-gray-7">No artifact is attached.</p>}>
    {(artifact) => <div class="brain-detail-stack">
      <div class="flex flex-wrap items-center justify-between gap-control-gap">
        <div class="min-w-0"><h3 class="text-base-medium text-ink-gray-9">{props.title ?? artifact().artifactId}</h3><p class="text-caption text-ink-gray-6">{artifact().mediaType} · {artifact().bytes.toLocaleString()} bytes · {artifact().classification}</p></div>
        <a href={`/v1/artifacts/${encodeURIComponent(artifact().artifactId)}/content`} download={artifact().artifactId} class="inline-flex"><Button variant="outline" class="min-h-11">Download</Button></a>
      </div>
      <Show when={!preview.loading} fallback={<p role="status" class="text-base text-ink-gray-7">Loading authorized preview…</p>}>
        <Show when={!preview.error} fallback={<Alert theme="red" variant="outline" title="Preview unavailable" description={preview.error instanceof Error ? preview.error.message : "The artifact could not be read. Use Download to retry."} />}>
          <Show when={preview()?.text !== undefined} fallback={<Alert theme="gray" variant="outline" title={preview()?.truncated ? "Preview limit exceeded" : "No inline preview for this media type"} description="Use the authorized download to inspect the complete artifact." />}>
            <pre class={`brain-readable overflow-auto whitespace-pre-wrap break-words rounded-card bg-surface-gray-1 p-4 text-caption text-ink-gray-8 ${props.compact ? "max-h-64" : "max-h-[32rem]"}`}>{preview()?.text}</pre>
            <Show when={preview()?.truncated}><p class="text-caption text-ink-amber-8">Preview stopped at 256 KiB. Download the artifact for the complete content.</p></Show>
          </Show>
        </Show>
      </Show>
    </div>}
  </Show>;
}
