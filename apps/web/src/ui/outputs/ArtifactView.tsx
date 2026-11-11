import { For, Match, Show, Switch, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { shortDigest } from "../format";
import { MEDIA_EMBED_LIMIT, TEXT_PREVIEW_LIMIT, artifactObjectUrl, decodeArtifactText, readArtifactBytes } from "./artifact-bytes";
import type { ArtifactHistory, ArtifactRef } from "../../data/exec-outputs";
import { Markdown } from "./Markdown";
import { ResultReader } from "./ResultReader";
import { parseStructuredResult, trustLineOf } from "./result-model";
import type { StructuredResult } from "./result-model";
import { fileNameOf, previewKindLabel, previewKindOf } from "./output-files";
import type { ArtifactPreviewKind } from "./output-files";

/**
 * The single artifact preview policy (plan T61). Download is an action beside
 * the preview — never the only way to read an artifact. Previews are native
 * per media type: rendered markdown, plain text/code, pretty-printed JSON,
 * CSV as a table, colored diffs, images and embedded PDFs — all through the
 * one authorized read in artifact-bytes.ts, bounded so a huge artifact can
 * never flood the DOM. Embedded call sites (evidence, tickets, dossiers) and
 * the Output Browser render the same component, so preview policy cannot
 * drift per surface again.
 */

interface LoadedPreview {
  kind: ArtifactPreviewKind;
  text?: string;
  /** The artifact is a task result (summary, deliverable, checklist): shown as a document, not as source. */
  result?: StructuredResult;
  objectUrl?: string;
  /** The full artifact exceeds the inline bound; the shown content is clipped. */
  truncated: boolean;
  /**
   * A failed authorized read, carried as data so the preview resource never
   * rejects: callers render "Preview unavailable" with the authorized download
   * still at hand, and no page-level unhandled rejection fires.
   */
  error?: string;
}

/**
 * Loads the bytes for one preview. Read failures come back as `error` data —
 * never as a rejected fetcher promise.
 */
async function loadPreview(artifact: ArtifactRef): Promise<LoadedPreview> {
  const kind = previewKindOf(artifact.mediaType);
  if (kind === "none") return { kind, truncated: false };
  const maxBytes = kind === "image" || kind === "pdf" ? MEDIA_EMBED_LIMIT : TEXT_PREVIEW_LIMIT;
  try {
    const bytes = await readArtifactBytes(artifact.artifactId, { maxBytes });
    if (kind === "image" || kind === "pdf") return { kind, objectUrl: artifactObjectUrl(bytes, artifact.mediaType), truncated: artifact.bytes > maxBytes };
    let text = decodeArtifactText(bytes, maxBytes);
    const result = kind === "json" || kind === "text" ? parseStructuredResult(text) : undefined;
    if (result) return { kind, text, result, truncated: false };
    if (kind === "json") {
      try {
        text = JSON.stringify(JSON.parse(text) as unknown, null, 2);
      } catch {
        /* invalid JSON stays visible as source text */
      }
    }
    return { kind, text, truncated: artifact.bytes > TEXT_PREVIEW_LIMIT };
  } catch (e) {
    return { kind, truncated: false, error: e instanceof Error ? e.message : "The artifact could not be read. Use Download to inspect it." };
  }
}

export function ArtifactView(props: { artifact?: ArtifactRef; title?: string; compact?: boolean; resultTitle?: string | undefined; history?: ArtifactHistory | null | undefined }): JSX.Element {
  const [preview] = createResource(
    () => props.artifact,
    (artifact) => loadPreview(artifact),
  );
  // Blob URLs are revoked as soon as they are replaced or the view unmounts.
  let lastUrl: string | undefined;
  createEffect(() => {
    const url = preview()?.objectUrl;
    if (lastUrl && lastUrl !== url) URL.revokeObjectURL(lastUrl);
    lastUrl = url;
  });
  onCleanup(() => {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
  });

  // Copy puts the decoded text preview on the clipboard; media and download-only kinds have nothing to copy.
  const [copied, setCopied] = createSignal(false);
  const copyable = () => {
    const loaded = preview();
    return !preview.loading && loaded !== undefined && !loaded.error && typeof loaded.text === "string" && loaded.text.length > 0 && !loaded.truncated && !loaded.result;
  };
  async function copy(): Promise<void> {
    const text = preview()?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const heading = () => (preview()?.result && props.resultTitle ? props.resultTitle : (props.title ?? (props.artifact ? fileNameOf(props.artifact) : "")));
  const maxHeight = () => (props.compact ? "max-h-64" : "max-h-[32rem]");
  return (
    <Show when={props.artifact} fallback={<p class="text-base text-ink-gray-7">No artifact is attached.</p>}>
      {(artifact) => (
        <div class="flex min-w-0 flex-col gap-3">
          <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <h3 class="break-words text-base-medium text-ink-gray-9">{heading()}</h3>
              <Show when={!preview()?.result}>
              <p class="break-words text-caption text-ink-gray-6">
                {previewKindLabel(previewKindOf(artifact().mediaType))} · {artifact().mediaType} · {artifact().bytes.toLocaleString()} B ·{" "}
                {artifact().classification} · <span class="brain-exec-log" title={artifact().digest}>{shortDigest(artifact().digest)}</span>
              </p>
              </Show>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <Show when={copyable()}>
                <Button size="sm" variant="ghost" iconLeft={copied() ? "lucide-check" : "lucide-copy"} onClick={() => void copy()}>
                  {copied() ? "Copied" : "Copy"}
                </Button>
              </Show>
              <a href={`/v1/artifacts/${encodeURIComponent(artifact().artifactId)}/content`} download={fileNameOf(artifact())} class="inline-flex shrink-0">
                <Button size="sm" variant="outline" iconLeft="lucide-download">
                  Download
                </Button>
              </a>
            </div>
          </div>
          <Show
            when={!preview.loading}
            fallback={
              <p role="status" class="text-base text-ink-gray-7">
                Loading authorized preview…
              </p>
            }
          >
            <Show when={preview()} keyed>
              {(loaded) =>
                loaded.error ? (
                  <Alert theme="amber" variant="outline" title="Preview unavailable" description={loaded.error} />
                ) : (
                  <Show when={loaded.result} fallback={<PreviewBody artifact={artifact()} preview={loaded} maxHeight={maxHeight()} />}>
                    {(result) => <ResultReader result={result()} title={props.resultTitle ?? heading()} trust={props.history ? trustLineOf(props.history, result()) : undefined} />}
                  </Show>
                )}
            </Show>
          </Show>
        </div>
      )}
    </Show>
  );
}

function PreviewBody(props: { artifact: ArtifactRef; preview: LoadedPreview; maxHeight: string }): JSX.Element {
  return (
    <Switch>
      <Match when={props.preview.kind === "markdown"}>
        <MarkdownPreview preview={props.preview} maxHeight={props.maxHeight} />
      </Match>
      <Match when={props.preview.kind === "csv"}>
        <TablePreview preview={props.preview} maxHeight={props.maxHeight} />
      </Match>
      <Match when={props.preview.kind === "diff"}>
        <DiffPreview preview={props.preview} maxHeight={props.maxHeight} />
      </Match>
      <Match when={props.preview.kind === "image"}>
        <img
          src={props.preview.objectUrl}
          alt={`Preview of ${props.artifact.artifactId}`}
          class="max-h-[32rem] w-auto max-w-full rounded-card border border-outline-gray-1"
        />
      </Match>
      <Match when={props.preview.kind === "pdf"}>
        <iframe
          src={props.preview.objectUrl}
          title={`PDF preview of ${props.artifact.artifactId}`}
          class="h-[32rem] w-full rounded-card border border-outline-gray-1"
        />
      </Match>
      <Match when={props.preview.kind === "none"}>{NO_PREVIEW_FALLBACK}</Match>
      <Match when={true}>
        <TextFamilyPreview preview={props.preview} maxHeight={props.maxHeight} />
      </Match>
    </Switch>
  );
}

const NO_PREVIEW_FALLBACK = (
  <Alert
    theme="gray"
    variant="outline"
    title="No inline preview for this media type"
    description="Use the authorized download to inspect the complete artifact."
  />
);

function TextFamilyPreview(props: { preview: LoadedPreview; maxHeight: string }): JSX.Element {
  return (
    <Show when={props.preview.text !== undefined && props.preview.text.length > 0} fallback={NO_PREVIEW_FALLBACK}>
      <pre
        class={`brain-readable min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-card bg-surface-gray-1 p-3 text-caption text-ink-gray-8 ${props.maxHeight}`}
      >
        {props.preview.text}
      </pre>
    </Show>
  );
}

/** A unified-diff artifact renders with per-line add/remove tone; pure presentation, no diff engine. */
function DiffPreview(props: { preview: LoadedPreview; maxHeight: string }): JSX.Element {
  const lines = () => (props.preview.text ?? "").split("\n");
  const lineClass = (line: string) =>
    line.startsWith("+") && !line.startsWith("+++")
      ? "bg-surface-green-2 text-ink-green-9"
      : line.startsWith("-") && !line.startsWith("---")
        ? "bg-surface-red-2 text-ink-red-9"
        : line.startsWith("@@")
          ? "text-ink-blue-8"
          : "text-ink-gray-8";
  return (
    <Show when={props.preview.text !== undefined} fallback={NO_PREVIEW_FALLBACK}>
      <pre class={`brain-exec-log overflow-auto rounded-card bg-surface-gray-1 p-4 text-caption ${props.maxHeight}`}>
        <For each={lines()}>{(line) => <span class={`block whitespace-pre ${lineClass(line)}`}>{line || " "}</span>}</For>
      </pre>
    </Show>
  );
}

/** Markdown artifacts read as a document (headings, lists, tables, quotes, code); text nodes only. */
function MarkdownPreview(props: { preview: LoadedPreview; maxHeight: string }): JSX.Element {
  return (
    <Show when={props.preview.text !== undefined} fallback={NO_PREVIEW_FALLBACK}>
      <div class={`overflow-auto rounded-card bg-surface-gray-1 p-4 sm:p-6 ${props.maxHeight}`}>
        <Markdown text={props.preview.text ?? ""} />
      </div>
    </Show>
  );
}

const CSV_PREVIEW_ROWS = 50;

/** Bounded CSV parse: RFC 4180 quoting, first row as the header, first CSV_PREVIEW_ROWS records shown. */
function parseCsvRows(text: string): { header: readonly string[]; rows: readonly string[][]; totalRecords: number } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      // Bound the parse work: the preview table never needs the whole file.
      if (records.length > CSV_PREVIEW_ROWS) break;
      continue;
    }
    field += char;
  }
  if (field !== "" || record.length > 0) endRecord();
  const totalRecords = records.length;
  const clipped = records.slice(0, CSV_PREVIEW_ROWS + 1);
  return { header: clipped[0] ?? [], rows: clipped.slice(1), totalRecords };
}

function TablePreview(props: { preview: LoadedPreview; maxHeight: string }): JSX.Element {
  const parsed = () => parseCsvRows(props.preview.text ?? "");
  return (
    <Show when={props.preview.text !== undefined && parsed().header.length > 0} fallback={NO_PREVIEW_FALLBACK}>
      <figure class="m-0 min-w-0 max-w-full">
        <div class={`max-w-full overflow-auto rounded-card border border-outline-gray-1 ${props.maxHeight}`}>
          <table class="w-full border-collapse text-caption">
            <thead class="sticky top-0 bg-surface-gray-1">
              <tr>
                <For each={parsed().header}>
                  {(cell) => <th class="border-b border-outline-gray-2 px-3 py-2 text-start font-medium text-ink-gray-7">{cell}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={parsed().rows}>
                {(row) => (
                  <tr class="hover:bg-surface-gray-1">
                    <For each={row}>{(cell) => <td class="whitespace-pre-wrap border-b border-outline-gray-1 px-3 py-1.5 text-ink-gray-8">{cell}</td>}</For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <figcaption class="mt-1 text-caption text-ink-gray-6">
          First {parsed().rows.length.toLocaleString()} data rows of {Math.max(0, parsed().totalRecords - 1).toLocaleString()}.
        </figcaption>
      </figure>
    </Show>
  );
}
