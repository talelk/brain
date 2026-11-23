import { createResource, createSignal, For, Show, type JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { iconKindOf, previewOf } from "@brain/contracts/media";
import { t } from "../i18n";
import { bytes } from "../lib/format";
import { downloadZip } from "../lib/zip";
import { Icon } from "./bits";
import { Preview } from "./Preview";

/** The files an agent saved in `/out`: grouped by folder, each with its size, a type icon and a preview by type, and all of them as one zip. */
export interface OutFile { readonly name: string; readonly bytes: number; readonly url: string }
interface Dir { readonly name: string; readonly dirs: Map<string, Dir>; readonly files: OutFile[] }

const ICONS = { text: "lucide-file-text", code: "lucide-file-code", table: "lucide-file-spreadsheet", image: "lucide-file-image", video: "lucide-file-video", archive: "lucide-file-archive", slides: "lucide-presentation", file: "lucide-file" } as const;

function treeOf(files: readonly OutFile[]): Dir {
  const root: Dir = { name: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.name.split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part);
      if (!next) { next = { name: part, dirs: new Map(), files: [] }; at.dirs.set(part, next); }
      at = next;
    }
    at.files.push(file);
  }
  return root;
}
const countOf = (dir: Dir): number => dir.files.length + [...dir.dirs.values()].reduce((sum, child) => sum + countOf(child), 0);

function Row(props: { file: OutFile }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const base = (): string => props.file.name.split("/").at(-1) ?? props.file.name;
  const viewable = (): boolean => previewOf(props.file.name) !== "file";
  return (
    <li class="border-b border-rule py-2 last:border-b-0">
      <div class="flex items-center gap-2">
        <Icon name={ICONS[iconKindOf(props.file.name)]} class="size-4 text-ink-3" />
        <Show when={viewable()} fallback={<span class="t-code code-ltr min-w-0 truncate" dir="ltr">{base()}</span>}>
          <button type="button" class="link t-code code-ltr min-w-0 truncate text-start" dir="ltr" aria-expanded={open()} title={t(open() ? "outputs.hide" : "outputs.preview")} onClick={() => setOpen(!open())}>{base()}</button>
        </Show>
        <span class="ms-auto whitespace-nowrap t-small text-ink-3">{bytes(props.file.bytes)}</span>
        <a class="rounded-md p-1 text-ink-3 hover:text-ink" href={props.file.url} download={base()} aria-label={t("outputs.download", { name: base() })} title={t("outputs.download", { name: base() })}><Icon name="lucide-download" /></a>
      </div>
      <Show when={open()}><div class="mt-2 ps-6"><Preview name={props.file.name} url={props.file.url} /></div></Show>
    </li>
  );
}

function Folder(props: { dir: Dir }): JSX.Element {
  return (
    <>
      <For each={[...props.dir.dirs.values()]}>
        {(child) => (
          <li class="border-b border-rule py-2 last:border-b-0">
            <p class="flex items-center gap-2 t-small font-medium text-ink-2"><Icon name="lucide-folder" class="size-4 text-ink-3" /><span class="code-ltr" dir="ltr">{child.name}</span><span class="ms-auto text-ink-3">{countOf(child)}</span></p>
            <ul class="ms-2 mt-1 border-s border-rule ps-3"><Folder dir={child} /></ul>
          </li>
        )}
      </For>
      <For each={props.dir.files}>{(file) => <Row file={file} />}</For>
    </>
  );
}

interface Manifest { readonly title?: string; readonly kind?: string; readonly entry?: string }
const manifestOf = (text: string): Manifest => {
  try {
    const found = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: string): string | undefined => (typeof found[key] === "string" && found[key] !== "" ? (found[key] as string).slice(0, 200) : undefined);
    const title = pick("title"); const kind = pick("kind"); const entry = pick("entry")?.replace(/^\.?\//u, "");
    return { ...(title ? { title } : {}), ...(kind ? { kind } : {}), ...(entry ? { entry } : {}) };
  } catch { return {}; }
};

export function Outputs(props: { files: readonly OutFile[] }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [manifest] = createResource(() => props.files.find((file) => file.name === "manifest.json")?.url, async (url) => { const response = await fetch(url, { credentials: "same-origin" }); return response.ok ? manifestOf(await response.text()) : {}; });
  const deliverable = (): OutFile | undefined => { const entry = manifest()?.entry; return entry ? props.files.find((file) => file.name === entry) : undefined; };
  const zip = async (): Promise<void> => {
    setBusy(true); setFailed(false);
    try {
      await downloadZip(props.files, "results.zip");
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <div class="flex flex-col gap-3">
      <Show when={deliverable()}>
        {(file) => (
          <section class="rounded-xl border border-rule-2 p-3.5" aria-label={t("outputs.deliverable")}>
            <p class="mb-2 flex flex-wrap items-baseline gap-x-2 t-small"><span class="font-semibold text-ink">{manifest()?.title ?? file().name}</span><Show when={manifest()?.kind}><span class="rounded-full bg-lilac px-2 text-ink-2">{manifest()?.kind}</span></Show><span class="ms-auto text-ink-3">{t("outputs.deliverable")}</span></p>
            <Preview name={file().name} url={file().url} />
          </section>
        )}
      </Show>
      <ul><Folder dir={treeOf(props.files)} /></ul>
      <Show when={props.files.length > 1}>
        <div class="flex items-center gap-3">
          <Button variant="outline" size="sm" iconLeft="lucide-archive" loading={busy()} onClick={() => void zip()}>{t("outputs.zip")}</Button>
          <Show when={failed()}><span class="t-small text-bad">{t("outputs.failed")}</span></Show>
        </div>
      </Show>
    </div>
  );
}
