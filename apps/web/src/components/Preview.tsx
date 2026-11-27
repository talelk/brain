import { createResource, For, Match, Show, Switch, type JSX } from "solid-js";
import { previewOf } from "@brain/contracts/media";
import { t } from "../i18n";
import { sheetOf } from "../lib/zip";
import { Code, Grid, Loading } from "./bits";
import { Markdown } from "./Markdown";

/**
 * A file an agent saved, shown by its type where it is. Text types are fetched and drawn by Brain itself (never as HTML). A page runs in an
 * iframe with `sandbox="allow-scripts"` and without `allow-same-origin`, and the route that serves it sends `content-security-policy: sandbox
 * allow-scripts`, so it has no origin of its own and cannot reach Brain's session. Anything else is only downloaded.
 */
const MAX_TEXT = 200_000;

/** RFC 4180 rows: quotes may hold commas, doubled quotes and line breaks. */
function csvRows(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at] as string;
    if (quoted) {
      if (ch === "\"" && text[at + 1] === "\"") { cell += "\""; at += 1; } else if (ch === "\"") quoted = false; else cell += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === separator) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[at + 1] === "\n") at += 1; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((entry) => entry.some((value) => value !== ""));
}

function Table(props: { rows: string[][] }): JSX.Element {
  const width = (): number => Math.max(1, ...props.rows.map((row) => row.length));
  const header = (): string[] => Array.from({ length: width() }, (_, at) => props.rows[0]?.[at] ?? "");
  return <Grid header={header()} rows={props.rows.slice(1, 501).map((row) => Array.from({ length: width() }, (_, at) => row[at] ?? ""))} />;
}

function Value(props: { name?: string; value: unknown; depth: number }): JSX.Element {
  const label = (): JSX.Element => <Show when={props.name !== undefined}><span class="text-ink-3">{props.name}: </span></Show>;
  const entries = (): [string, unknown][] => (Array.isArray(props.value) ? props.value.map((item, at) => [String(at), item] as [string, unknown]) : Object.entries(props.value as object));
  return (
    <Show when={typeof props.value === "object" && props.value !== null} fallback={<div class="break-words">{label()}<span class={typeof props.value === "string" ? "text-ink" : "text-needs-text"}>{typeof props.value === "string" ? JSON.stringify(props.value) : String(props.value)}</span></div>}>
      <details open={props.depth < 2}>
        <summary class="cursor-pointer">{label()}<span class="text-ink-3">{Array.isArray(props.value) ? `[${entries().length}]` : `{${entries().length}}`}</span></summary>
        <div class="ms-4 border-s border-rule ps-3"><For each={entries()}>{([key, item]) => <Value name={key} value={item} depth={props.depth + 1} />}</For></div>
      </details>
    </Show>
  );
}

function Json(props: { text: string }): JSX.Element {
  const parsed = (): { value: unknown } | undefined => { try { return { value: JSON.parse(props.text) as unknown }; } catch { return undefined; } };
  return <Show when={parsed()} fallback={<Code text={props.text} />}>{(found) => <div class="t-code code-ltr max-h-96 overflow-auto rounded-xl bg-lilac px-3.5 py-3 text-ink" dir="ltr"><Value value={found().value} depth={0} /></div>}</Show>;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(String(response.status));
  return response;
}

export function Preview(props: { name: string; url: string }): JSX.Element {
  const kind = previewOf(props.name);
  const shown = `${props.url}?view=1`;
  const [text] = createResource(() => (["markdown", "text", "json", "csv"].includes(kind) ? props.url : undefined), async (url) => { const full = await (await fetchOk(url)).text(); return { text: full.slice(0, MAX_TEXT), cut: full.length > MAX_TEXT }; });
  const [sheet] = createResource(() => (kind === "sheet" ? props.url : undefined), async (url) => sheetOf(await (await fetchOk(url)).arrayBuffer()));
  const loaded = (): { text: string; cut: boolean } | undefined => text();
  return (
    <div class="min-w-0">
      <Switch fallback={<p class="t-small text-ink-3">{t("outputs.noPreview")}</p>}>
        <Match when={kind === "html"}>
          <iframe sandbox="allow-scripts" src={shown} title={t("outputs.page", { name: props.name })} class="h-[28rem] w-full rounded-xl border border-rule bg-white" />
          <a class="link mt-2 inline-block t-small" href={shown} target="_blank" rel="noreferrer">{t("outputs.openPage")}</a>
        </Match>
        <Match when={kind === "pdf"}><iframe src={shown} title={t("outputs.page", { name: props.name })} class="h-[32rem] w-full rounded-xl border border-rule bg-white" /></Match>
        <Match when={kind === "image"}><img src={shown} alt={props.name} class="max-h-[32rem] max-w-full rounded-xl border border-rule bg-paper object-contain" /></Match>
        <Match when={kind === "video"}><video src={shown} controls class="max-h-[32rem] max-w-full rounded-xl" /></Match>
        <Match when={kind === "sheet"}>
          <Show when={sheet()} fallback={<Show when={sheet.error} fallback={<Loading />}><p class="t-small text-ink-3">{t("outputs.noPreview")}</p></Show>}>{(rows) => <Show when={rows().length > 0} fallback={<p class="t-small text-ink-3">{t("outputs.noPreview")}</p>}><Table rows={rows()} /></Show>}</Show>
        </Match>
        <Match when={["markdown", "text", "json", "csv"].includes(kind)}>
          <Show when={loaded()} fallback={<Show when={text.error} fallback={<Loading />}><p class="t-small text-bad">{t("outputs.failed")}</p></Show>}>
            {(file) => (
              <>
                <Switch fallback={<Code text={file().text} class="max-h-96" />}>
                  <Match when={kind === "markdown"}><div class="max-h-[32rem] overflow-auto rounded-xl border border-rule-2 bg-sheet p-5"><Markdown file text={file().text} /></div></Match>
                  <Match when={kind === "json"}><Json text={file().text} /></Match>
                  <Match when={kind === "csv"}><Table rows={csvRows(file().text, props.name.toLowerCase().endsWith(".tsv") ? "\t" : ",")} /></Match>
                </Switch>
                <Show when={file().cut}><p class="mt-1 t-small text-ink-3">{t("outputs.cut")}</p></Show>
              </>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  );
}
