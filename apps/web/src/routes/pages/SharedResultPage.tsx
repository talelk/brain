import { Show, createResource } from "solid-js";
import type { JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { readShared } from "../../data/result-links";
import { Markdown } from "../../ui/outputs/Markdown";
import { ResultReader } from "../../ui/outputs/ResultReader";
import { parseStructuredResult } from "../../ui/outputs/result-model";
import { formatDateTime } from "../../ui/format";

/**
 * `/shared/:token` (ADR 0013): one verified result, read-only, for someone with no account. It shows that result's text, when it
 * was recorded and when the link expires, and offers nothing to click that changes anything. It loads without cookies and is the
 * only page that does not need a signed-in person.
 */
export default function SharedResultPage(): JSX.Element {
  const params = useParams();
  const [outcome] = createResource(() => params.token ?? "", readShared);
  const ok = () => { const value = outcome(); return value?.kind === "ok" ? value.result : undefined; };
  const gone = () => { const value = outcome(); return value?.kind === "gone" ? value.reason : undefined; };
  const missing = () => outcome()?.kind === "missing";
  return <main class="mx-auto flex min-h-dvh w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6 sm:px-6" data-testid="shared-result">
    <header class="flex min-w-0 flex-col gap-1">
      <p class="m-0 mb-2 flex items-center gap-2 text-interface font-medium text-ink-gray-8"><img src="/icon-192.png" alt="" width="24" height="24" class="size-6 rounded-md" />Keyrus Brain<span class="font-normal text-ink-gray-6">· shared with you, read only</span></p>
      <Show when={ok()} fallback={<h1 class="text-heading">{gone() ? "This link is no longer available" : missing() ? "This link does not exist" : "Opening the result…"}</h1>}>{(result) => <>
        <h1 class="break-words text-heading">{result().name}</h1>
        <p class="text-interface text-ink-gray-7">{result().versionLabel} · verified by Brain · recorded {formatDateTime(result().recordedAt)} · this link expires {formatDateTime(result().expiresAt)}</p>
      </>}</Show>
    </header>
    <Show when={ok()}>{(result) => {
      const structured = () => parseStructuredResult(result().text);
      const prose = () => result().mediaType.startsWith("text/markdown") || result().mediaType.startsWith("text/plain");
      return <article class="min-w-0 rounded-card border border-outline-gray-2 bg-surface-elevation-1 p-4 sm:p-6" aria-label="Shared result">
        <Show when={structured()} fallback={<Markdown text={prose() ? result().text : `\`\`\`\n${result().text}\n\`\`\``} />}>
          {(document) => <ResultReader result={document()} title={result().name} />}
        </Show>
        <Show when={result().truncated}><p class="mt-3 text-caption text-ink-gray-6">The rest of this long result is not shown here.</p></Show>
      </article>;
    }}</Show>
    <Show when={gone()}><p class="text-interface text-ink-gray-7" role="status">{gone() === "expired" ? "This link has expired." : "The person who shared it withdrew this link."} Ask them for a new one.</p></Show>
    <Show when={missing()}><p class="text-interface text-ink-gray-7" role="status">Check that you copied the whole link.</p></Show>
    <p class="mt-auto text-caption text-ink-gray-6">This page is read-only. It cannot be edited or acted on, and it shows nothing else from the workspace.</p>
  </main>;
}
