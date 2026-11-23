import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, type JSX } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { Badge, Button, Checkbox, TextInput } from "@talelk/newui-atoms";
import { Breadcrumbs, Dialog, EmptyState, FileCard, Select, ToggleGroup, toast, Tree } from "@talelk/newui-molecules";
import { PaneLayout } from "@talelk/newui-templates";
import type { FileEntry } from "@brain/contracts";
import { ApiFailure, command, useAction, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t, tn } from "../i18n";
import { DEFAULT_FOLDER, MAX_EDITED, MAX_FILE, MAX_UPLOAD, base64Of, cleanPath, downloadUrl, extensionOf, folderOf, foldersOf, isConfiguration, isImage, isMarkdown, mb, nameOk, pathOk, rowsOf, under, type Row } from "../lib/documents";
import { ago, bytes } from "../lib/format";
import { previewOf } from "@brain/contracts/media";
import { downloadZip } from "../lib/zip";
import { CodeEditor } from "./CodeEditor";
import { Preview } from "./Preview";
import { Markdown } from "./Markdown";
import { ConfirmButton, Failure, Icon } from "./bits";
import { DeleteDialog, downloadAll, TransferDialog } from "./FileOps";

/** The Files tab of Workspace: the whole folder as a tree, a viewer and editor for one file, and uploads. Every change is one commit through `file.write`. */

interface Upload { readonly path: string; readonly content: string; readonly encoding?: "base64" }

function FileView(props: { path: string; isNew: boolean; readOnly: boolean; open: (path: string | undefined) => void }): JSX.Element {
  const place = usePlace();
  const file = useQuery("file.read", () => (props.isNew ? undefined : { workspaceId: place.id(), path: props.path }));
  const [draft, setDraft] = createSignal<string>();
  const [saved, setSaved] = createSignal<string>();
  const [message, setMessage] = createSignal("");
  const [renaming, setRenaming] = createSignal<string>();
  const [source, setSource] = createSignal(false);
  const base = (): string | undefined => saved() ?? (props.isNew ? "" : file.data()?.content);
  const text = (): string | undefined => draft() ?? base();
  const dirty = (): boolean => draft() !== undefined && draft() !== base();
  const size = (): number => file.data()?.bytes ?? 0;
  const binary = (): boolean => file.data()?.binary ?? false;
  const result = (): boolean => file.data()?.source === "results";
  const pack = (): string | undefined => { const source = file.data()?.source; return source && source !== "workspace" && source !== "results" ? source : undefined; };
  const editable = (): boolean => !props.readOnly && !binary() && size() <= MAX_EDITED && pack() === undefined && !result();
  const copy = useAction(async () => {
    const data = file.data();
    if (!data) return;
    await command("file.write", { workspaceId: place.id(), files: [{ path: props.path, content: data.content }], message: `Copy ${props.path} from the pack ${data.source}` });
    toast.success({ title: t("files.copyOver.done") });
  });

  const save = useAction(async () => {
    const content = text() ?? "";
    await command("file.write", { workspaceId: place.id(), files: [{ path: props.path, content }], message: message().trim() || `${props.isNew ? "Add" : "Change"} ${props.path}` });
    toast.success({ title: t("workspace.saved") });
    setSaved(content);
    setDraft(undefined);
    setMessage("");
    if (props.isNew) props.open(props.path);
  });
  const remove = useAction(async () => {
    await command("file.delete", { workspaceId: place.id(), paths: [props.path], message: `Remove ${props.path}` });
    props.open(undefined);
  });
  const rename = useAction(async (to: string) => {
    const before = file.data();
    if (!before) return;
    let content = before.content;
    let encoding: "base64" | undefined;
    if (before.binary) {
      const response = await fetch(downloadUrl(place.id(), props.path), { credentials: "same-origin" });
      if (!response.ok) throw new ApiFailure(response.status === 404 ? "NOT_FOUND" : "INTERNAL", "");
      content = base64Of(await response.arrayBuffer());
      encoding = "base64";
    }
    await command("file.write", { workspaceId: place.id(), files: [{ path: to, content, ...(encoding ? { encoding } : {}) }], remove: [props.path], message: `Rename ${props.path} to ${to}` });
    setRenaming(undefined);
    props.open(to);
  });
  const renamePath = (): string => cleanPath(renaming() ?? "");
  const mine = (): readonly { path: string; message: string }[] => (save.error()?.problems ?? []).filter((problem) => problem.path === props.path);
  const elsewhere = (): readonly { path: string; message: string }[] => (save.error()?.problems ?? []).filter((problem) => problem.path !== props.path);

  return (
    <div class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-5 sm:p-6">
      <header class="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div class="min-w-0">
          <h2 class="t-title break-all text-ink code-ltr" dir="ltr">{props.path}</h2>
          <p class="mt-1 t-small text-ink-2">
            <Show when={!props.isNew && file.data()} fallback={props.isNew ? t("workspace.source.new") : ""}>
              {(data) => <>{bytes(data().bytes)}<Show when={data().lastCommit}>{(last) => <> · {t("files.lastCommit", { message: last().message, when: ago(last().atMs) })}</>}</Show></>}
            </Show>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={!props.isNew}><a class="link inline-flex items-center gap-1.5 t-small font-medium" href={downloadUrl(place.id(), props.path)} download=""><Icon name="lucide-download" />{t("files.download")}</a></Show>
          <Show when={!props.readOnly && pack() !== undefined && !binary()}>
            <Button variant="solid" theme="blue" size="md" iconLeft="lucide-copy" loading={copy.busy()} onClick={() => void copy.run()}>{t("files.copyOver")}</Button>
          </Show>
          <Show when={!props.readOnly && !props.isNew && file.data() && pack() === undefined && !result()}>
            <Button variant="ghost" size="md" iconLeft="lucide-pencil" onClick={() => setRenaming(renaming() === undefined ? props.path : undefined)}>{t("files.rename")}</Button>
            <ConfirmButton label={t("action.delete")} confirm={t("files.delete.confirm", { path: props.path })} busy={remove.busy()} onConfirm={() => void remove.run()} />
          </Show>
        </div>
      </header>
      <Failure error={remove.error()} class="mb-4" />
      <Show when={renaming() !== undefined}>
        <form class="mb-5 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (pathOk(renamePath()) && renamePath() !== props.path) void rename.run(renamePath()); }}>
          <div class="min-w-0 flex-1 basis-64"><TextInput size="md" class="t-code" label={t("files.rename.to")} value={renaming() ?? ""} onInput={(event) => setRenaming(event.currentTarget.value)} autofocus /></div>
          <Button type="submit" variant="outline" size="md" loading={rename.busy()} disabled={!pathOk(renamePath()) || renamePath() === props.path}>{t("files.rename")}</Button>
        </form>
        <Failure error={rename.error()} class="mb-4" />
      </Show>
      <Show when={isConfiguration(props.path)}><p class="mb-5 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2">{t("files.warn.config")}</p></Show>
      <Failure error={copy.error()} class="mb-4" />
      <Show when={result()}><p class="mb-5 flex flex-wrap items-center gap-2 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2"><Badge theme="violet" size="md" label={t("files.fromTask")} />{t("files.result.note")}</p></Show>
      <Show when={pack()}>{(source) => <p class="mb-5 flex flex-wrap items-center gap-2 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2"><Badge theme="violet" size="md" label={t("files.fromPack", { pack: source() })} />{t("files.pack.note")}</p>}</Show>
      <Show when={file.data()?.replaces}>{(source) => <p class="mb-5 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2">{t("files.replaces", { pack: source() })}</p>}</Show>
      <Show when={props.readOnly}><p class="mb-5 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2">{t("files.readOnly")}</p></Show>
      <Show when={props.isNew || file.data()} fallback={<Failure error={file.error()} />}>
        <Switch>
          <Match when={result() && previewOf(props.path) !== "file"}><Preview name={props.path} url={downloadUrl(place.id(), props.path)} /></Match>
          <Match when={binary()}>
            <Show when={isImage(props.path)}>
              <img class="mb-4 max-h-96 max-w-full rounded-xl border border-rule bg-paper object-contain" src={downloadUrl(place.id(), props.path)} alt={props.path} />
            </Show>
            <p class="t-small text-ink-2">{t("files.binary")}</p>
          </Match>
          <Match when={!props.isNew && size() > MAX_EDITED}><p class="t-small text-ink-2">{t("files.tooLarge", { limit: "512 KB" })}</p></Match>
          <Match when={editable()}>
            <div class={isMarkdown(props.path) ? "grid gap-4 xl:grid-cols-2" : ""}>
              <CodeEditor label={props.path} value={text() ?? ""} onChange={setDraft} problems={mine()} rows={16} />
              <Show when={isMarkdown(props.path)}>
                <div class="min-w-0 rounded-xl border border-rule-2 bg-sheet p-5"><p class="mb-3 t-small font-medium text-ink-2">{t("editor.preview")}</p><Markdown text={text() ?? ""} /></div>
              </Show>
            </div>
            <div class="mt-6 flex flex-col gap-3 border-t border-rule pt-5">
              <Failure error={save.error()} problems={elsewhere()} />
              <div class="max-w-xl"><TextInput size="md" label={t("files.commit")} placeholder={t("files.commit.hint")} value={message()} maxLength={200} onInput={(event) => setMessage(event.currentTarget.value)} /></div>
              <div><Button variant="solid" theme="blue" size="md" loading={save.busy()} disabled={!dirty() && !props.isNew} onClick={() => void save.run()}>{t("action.save")}</Button></div>
            </div>
          </Match>
          <Match when={true}>
            <Show when={isMarkdown(props.path)}>
              <button type="button" class="link mb-3 t-small" aria-pressed={source()} onClick={() => setSource(!source())}>{source() ? t("files.rendered") : t("files.source")}</button>
            </Show>
            <Show when={isMarkdown(props.path) && !source()} fallback={<pre class="t-code code-ltr max-h-[32rem] overflow-auto rounded-xl bg-lilac px-4 py-3 text-ink" tabindex="0">{text()}</pre>}>
              <div class="rounded-xl border border-rule-2 bg-sheet p-5"><Markdown text={text() ?? ""} /></div>
            </Show>
          </Match>
        </Switch>
      </Show>
    </div>
  );
}

const ICONS: Record<string, string> = { md: "lucide-file-text", markdown: "lucide-file-text", txt: "lucide-file-text", pdf: "lucide-file-text", toml: "lucide-file-code", sh: "lucide-file-code", json: "lucide-file-code", yaml: "lucide-file-code", yml: "lucide-file-code", csv: "lucide-file-spreadsheet", xlsx: "lucide-file-spreadsheet", zip: "lucide-file-archive", gz: "lucide-file-archive" };
const iconOf = (row: Row): string => (row.kind === "folder" ? "lucide-folder" : isImage(row.path) ? "lucide-file-image" : (ICONS[extensionOf(row.path)] ?? "lucide-file"));

interface Upload { readonly path: string; readonly content: string; readonly encoding?: "base64" }
type SortKey = "name" | "size" | "modified";

/** Where a row comes from, as a badge: a pack's file, or a workspace file that replaces one. */
function Origin(props: { row: Row }): JSX.Element {
  return (
    <>
      <Show when={props.row.source !== "workspace"}><Badge theme="violet" size="md" label={props.row.source === "results" ? t("files.fromTask") : t("files.fromPack", { pack: props.row.source })} /></Show>
      <Show when={props.row.replaces}>{(pack) => <Badge theme="gray" size="md" label={t("files.replacesBadge", { pack: pack() })} />}</Show>
    </>
  );
}

export function FilesTab(props: { files: readonly FileEntry[]; readOnly: boolean }): JSX.Element {
  const place = usePlace();
  const navigate = useNavigate();
  const [search] = useSearchParams<{ path?: string; folder?: string; new?: string }>();
  const present = createMemo(() => new Set(props.files.filter((file) => file.source === "workspace").map((file) => file.path)));
  const [filter, setFilter] = createSignal("");
  const [sort, setSort] = createSignal<SortKey>("name");
  const [descending, setDescending] = createSignal(false);
  const [grid, setGrid] = createSignal(false);
  const [selection, setSelection] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [anchor, setAnchor] = createSignal<string>();
  const [expanded, setExpanded] = createSignal<string[]>([]);
  const [target, setTarget] = createSignal("");
  const [problems, setProblems] = createSignal<readonly string[]>([]);
  const [pending, setPending] = createSignal<{ uploads: readonly Upload[]; replaces: readonly string[] }>();
  const [dragging, setDragging] = createSignal(false);
  const [naming, setNaming] = createSignal<string>();
  const [transfer, setTransfer] = createSignal<"copy" | "move">();
  const [deleting, setDeleting] = createSignal(false);
  let picker: HTMLInputElement | undefined;
  let shift = false;

  const selected = (): string => search.path ?? "";
  const folder = (): string => search.folder ?? (selected() ? folderOf(selected()) : "");
  const isNew = (): boolean => search.new !== undefined && !present().has(selected());
  const href = (path?: string, fresh = false, inFolder = folder()): string => {
    const query = [path ? `path=${encodeURIComponent(path)}${fresh ? "&new=1" : ""}` : "", !path && inFolder ? `folder=${encodeURIComponent(inFolder)}` : ""].filter(Boolean).join("&");
    return `${place.to("/workspace/files")}${query ? `?${query}` : ""}`;
  };
  const open = (path: string | undefined, fresh = false): void => navigate(href(path, fresh));
  const go = (to: string): void => { setSelection(new Set<string>()); navigate(href(undefined, false, to)); };
  createEffect(on(folder, (current) => {
    setTarget(current === "" ? DEFAULT_FOLDER : current);
    setExpanded((was) => [...new Set([...was, ...current.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")).filter(Boolean)])]);
  }));

  const rows = createMemo((): Row[] => {
    const words = filter().trim().toLowerCase();
    const base = words === ""
      ? rowsOf(props.files, folder())
      : props.files.filter((file) => !file.path.endsWith("/.gitkeep") && file.path.toLowerCase().includes(words)).map((file): Row => ({ kind: "file", name: file.path, path: file.path, bytes: file.bytes, count: 0, source: file.source, ...(file.replaces ? { replaces: file.replaces } : {}), ...(file.lastCommit ? { lastCommit: file.lastCommit } : {}) }));
    const sign = descending() ? -1 : 1;
    const key = sort();
    return base.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      const order = key === "size" ? a.bytes - b.bytes : key === "modified" ? (a.lastCommit?.atMs ?? 0) - (b.lastCommit?.atMs ?? 0) : a.name.localeCompare(b.name);
      return sign * (order !== 0 ? order : a.name.localeCompare(b.name));
    });
  });
  const chosen = (): readonly FileEntry[] => under(props.files, selection());
  const onlyMine = (): boolean => chosen().every((file) => file.source === "workspace");

  /** A click on a row's box or on the row with a modifier: toggle it, or with shift select the range from the last one touched. */
  const pick = (path: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void => {
    const next = new Set(selection());
    const list = rows().map((row) => row.path);
    const from = anchor();
    if (event.shiftKey && from !== undefined && list.includes(from)) {
      const [low, high] = [list.indexOf(from), list.indexOf(path)].sort((a, b) => a - b);
      if (!event.ctrlKey && !event.metaKey) next.clear();
      for (const item of list.slice(low ?? 0, (high ?? low ?? 0) + 1)) next.add(item);
    } else {
      if (next.has(path)) next.delete(path); else next.add(path);
      setAnchor(path);
    }
    setSelection(next);
  };
  const allSelected = (): boolean => rows().length > 0 && rows().every((row) => selection().has(row.path));
  const toggleAll = (): void => { setSelection(allSelected() ? new Set<string>() : new Set(rows().map((row) => row.path))); setAnchor(undefined); };

  const write = useAction(async (uploads: readonly Upload[]) => {
    await command("file.write", { workspaceId: place.id(), files: [...uploads], message: uploads.length === 1 ? `Upload ${uploads[0]?.path}` : `Upload ${uploads.length} files to ${folderOf(uploads[0]?.path ?? "") || "the folder"}` });
    toast.success({ title: t("files.upload.done") });
    const first = uploads[0];
    if (first && uploads.length === 1) open(first.path);
    else if (first) go(folderOf(first.path));
  });

  /** Checks the files against the limits and the name rules, then sends them, after a confirmation when they replace files. */
  const stage = async (list: readonly File[]): Promise<void> => {
    if (props.readOnly || list.length === 0) return;
    const into = cleanPath(target());
    const found: string[] = [];
    if (into !== "" && !pathOk(into)) found.push(t("files.upload.error.folder", { folder: into }));
    const accepted: File[] = [];
    for (const file of list) {
      if (!nameOk(file.name)) found.push(t("files.upload.error.name", { name: file.name }));
      else if (file.size > MAX_FILE) found.push(t("files.upload.error.size", { name: file.name, limit: mb(MAX_FILE) }));
      else accepted.push(file);
    }
    if (accepted.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD) { found.push(t("files.upload.error.total", { limit: mb(MAX_UPLOAD) })); accepted.length = 0; }
    setProblems(found);
    if (accepted.length === 0 || (into !== "" && !pathOk(into))) return;
    const uploads = await Promise.all(accepted.map(async (file): Promise<Upload> => {
      const path = into === "" ? file.name : `${into}/${file.name}`;
      // Brain's own files are text; any other document is bytes.
      return isConfiguration(path) ? { path, content: await file.text() } : { path, content: base64Of(await file.arrayBuffer()), encoding: "base64" };
    }));
    const replaces = uploads.map((upload) => upload.path).filter((path) => present().has(path));
    if (replaces.length > 0) setPending({ uploads, replaces });
    else await write.run(uploads);
  };
  const dropped = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    void stage([...(event.dataTransfer?.files ?? [])]);
  };
  const create = (): void => {
    const made = cleanPath(naming() ?? "");
    if (!pathOk(made) || present().has(made)) return;
    setNaming(undefined);
    open(made, true);
  };

  const uploadButton = (): JSX.Element => (
    <Button variant="solid" theme="blue" size="md" iconLeft="lucide-upload" loading={write.busy()} onClick={() => picker?.click()}>{t("files.upload")}</Button>
  );
  const crumbs = () => [{ label: place.summary().name, onClick: () => go(""), route: href(undefined, false, "") }, ...folder().split("/").filter(Boolean).map((name, index, parts) => ({ label: name, onClick: () => go(parts.slice(0, index + 1).join("/")), route: href(undefined, false, parts.slice(0, index + 1).join("/")) }))];

  const rowLink = (row: Row, children: JSX.Element): JSX.Element => (
    <a href={row.kind === "folder" ? href(undefined, false, row.path) : href(row.path)} aria-current={selected() === row.path ? "page" : undefined} class="flex min-w-0 flex-1 items-center gap-2 rounded-control focus-visible:focus-ring"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) { event.preventDefault(); pick(row.path, event); return; }
        if (event.button !== 0) return;
        event.preventDefault();
        if (row.kind === "folder") { setFilter(""); go(row.path); } else open(row.path);
      }}>{children}</a>
  );
  const check = (row: Row): JSX.Element => (
    <span onClick={(event) => { shift = event.shiftKey; }}>
      <Checkbox size="md" aria-label={t("files.select", { name: row.name })} checked={selection().has(row.path)} onCheckedChange={() => { pick(row.path, { shiftKey: shift, ctrlKey: false, metaKey: false }); shift = false; }} />
    </span>
  );
  const meta = (row: Row): string => `${row.kind === "folder" ? tn("files.items", row.count) : ""}${row.kind === "folder" ? " · " : ""}${bytes(row.bytes)}${row.lastCommit ? ` · ${ago(row.lastCommit.atMs)}` : ""}`;

  const listing = (): JSX.Element => (
    <div class="min-w-0">
      <Show when={rows().length > 0} fallback={
        <EmptyState bordered size="sm" icon={filter() ? "lucide-search-x" : "lucide-folder-open"} title={filter() ? t("files.noMatch") : t("files.folder.empty")} description={filter() ? undefined : props.readOnly ? t("files.empty.viewer") : t("files.folder.empty.text")} />
      }>
        <Show when={!grid()} fallback={
          <ul class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label={t("files.list")}>
            <For each={rows()}>{(row) => (
              <li class="flex items-center gap-2">
                {check(row)}
                {rowLink(row, <FileCard as="div" class="flex-1" size="md" icon={iconOf(row)} selected={selection().has(row.path) || selected() === row.path} name={<span dir="ltr" class="code-ltr">{row.name}</span>} meta={meta(row)} badge={<Origin row={row} />} />)}
              </li>
            )}</For>
          </ul>
        }>
          <div class="overflow-x-auto rounded-card border border-outline-gray-1">
            <table class="w-full min-w-0 border-collapse text-start t-small">
              <caption class="sr-only">{t("files.list")}</caption>
              <thead class="bg-surface-gray-2 text-ink-2">
                <tr>
                  <th scope="col" class="w-10 px-3 py-2 text-start"><Checkbox size="md" aria-label={t("files.selectAll")} checked={allSelected()} indeterminate={selection().size > 0 && !allSelected()} onCheckedChange={toggleAll} /></th>
                  <th scope="col" class="px-2 py-2 text-start font-medium">{t("files.col.name")}</th>
                  <th scope="col" class="px-2 py-2 text-end font-medium max-sm:hidden">{t("files.col.size")}</th>
                  <th scope="col" class="px-2 py-2 text-start font-medium max-md:hidden">{t("files.col.modified")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>{(row) => (
                  <tr class="border-t border-outline-gray-1 hover:bg-surface-gray-2 aria-selected:bg-surface-blue-2" aria-selected={selection().has(row.path)}
                    onClick={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).tagName === "TD") { if (event.metaKey || event.ctrlKey || event.shiftKey) pick(row.path, event); } }}>
                    <td class="w-10 px-3 py-2">{check(row)}</td>
                    <td class="min-w-0 px-2 py-2">
                      {rowLink(row, <>
                        <Icon name={iconOf(row)} class="size-4 text-ink-3" />
                        <span class="min-w-0 flex-1"><span class={`block truncate t-text ${row.kind === "folder" ? "font-semibold" : ""} text-ink code-ltr`} dir="ltr">{row.name}</span>
                        <span class="block truncate t-small text-ink-2 sm:hidden">{meta(row)}</span></span>
                      </>)}
                      <span class="mt-1 flex flex-wrap gap-1 empty:hidden"><Origin row={row} /></span>
                    </td>
                    <td class="whitespace-nowrap px-2 py-2 text-end tabular-nums text-ink-2 max-sm:hidden" dir="ltr">{bytes(row.bytes)}<Show when={row.kind === "folder"}><span class="block t-small">{tn("files.items", row.count)}</span></Show></td>
                    <td class="px-2 py-2 text-ink-2 max-md:hidden"><Show when={row.lastCommit} fallback="—">{(last) => <span class="block max-w-64 truncate" title={last().message}>{last().message}<span class="block t-small">{ago(last().atMs)}</span></span>}</Show></td>
                  </tr>
                )}</For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </div>
  );

  const tree = (): JSX.Element => (
    <nav aria-label={t("files.tree")} class="min-w-0">
      <button type="button" aria-current={folder() === "" ? "page" : undefined} class="mb-1 flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-start t-text hover:bg-surface-gray-2 aria-[current=page]:bg-surface-gray-3 focus-visible:focus-ring" onClick={() => go("")}>
        <Icon name="lucide-folder-tree" class="size-4 text-ink-3" /><span class="min-w-0 flex-1 truncate">{t("files.allFiles")}</span><span class="t-small text-ink-2">{props.files.filter((file) => !file.path.endsWith(".gitkeep")).length}</span>
      </button>
      <Tree.Root items={foldersOf(props.files)} selectedValue={folder() ? [folder()] : []} onSelectionChange={(value) => { if (value[0] !== undefined && value[0] !== folder()) { setFilter(""); go(value[0]); } }} expandedValue={expanded()} onExpandedChange={setExpanded}>
        <Tree.Label class="sr-only">{t("files.tree")}</Tree.Label>
        <Tree.Tree><For each={foldersOf(props.files)}>{(node, index) => <Tree.Node node={node} indexPath={[index()]} />}</For></Tree.Tree>
      </Tree.Root>
    </nav>
  );

  const toolbar = (): JSX.Element => (
    <div class="mb-3 flex flex-col gap-3">
      <Breadcrumbs items={crumbs()} aria-label={t("files.breadcrumbs")} />
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-48 flex-1 basis-56"><TextInput size="md" type="search" label={t("files.filter")} placeholder={t("files.filter")} value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} /></div>
        <div class="w-40"><Select size="md" label={t("files.sort")} options={[{ value: "name", label: t("files.col.name") }, { value: "size", label: t("files.col.size") }, { value: "modified", label: t("files.col.modified") }]} value={sort()} onValueChange={(value) => { if (value) setSort(value as SortKey); }} /></div>
        <Button variant="outline" size="md" icon={descending() ? "lucide-arrow-down-wide-narrow" : "lucide-arrow-up-narrow-wide"} aria-label={t(descending() ? "files.sort.desc" : "files.sort.asc")} onClick={() => setDescending(!descending())} />
        <ToggleGroup.Root variant="outline" size="lg" aria-label={t("files.view")} value={[grid() ? "grid" : "list"]} onValueChange={(value) => { if (value[0]) setGrid(value[0] === "grid"); }}>
          <ToggleGroup.Item value="list" icon="lucide-list" aria-label={t("files.view.list")} />
          <ToggleGroup.Item value="grid" icon="lucide-layout-grid" aria-label={t("files.view.grid")} />
        </ToggleGroup.Root>
        <Show when={!props.readOnly}>
          {uploadButton()}
          <Button variant="outline" size="md" iconLeft="lucide-file-plus" onClick={() => setNaming(naming() === undefined ? `${folder() || DEFAULT_FOLDER}/` : undefined)}>{t("files.new")}</Button>
        </Show>
      </div>
      <Show when={!props.readOnly}>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-control bg-surface-gray-2 px-3 py-2">
          <label class="flex max-w-full flex-wrap items-center gap-2 t-small font-medium text-ink"><span>{t("files.upload.to")}</span><TextInput size="sm" class="t-code w-48 max-w-full" aria-label={t("files.upload.to")} value={target()} onInput={(event) => setTarget(event.currentTarget.value)} /></label>
          <p class="t-small text-ink-2">{t("files.upload.limits", { file: mb(MAX_FILE), total: mb(MAX_UPLOAD) })}</p>
        </div>
        <Show when={naming() !== undefined}>
          <form class="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); create(); }}>
            <div class="min-w-0 flex-1"><TextInput size="md" class="t-code" label={t("files.new.path")} value={naming() ?? ""} onInput={(event) => setNaming(event.currentTarget.value)} autofocus /></div>
            <Button type="submit" variant="outline" size="md" disabled={!pathOk(cleanPath(naming() ?? "")) || present().has(cleanPath(naming() ?? ""))}>{t("workspace.new.create")}</Button>
          </form>
        </Show>
        <Show when={problems().length > 0}>
          <div class="rounded-xl bg-bad-soft px-4 py-3 t-small text-bad" role="alert"><ul class="flex flex-col gap-1"><For each={problems()}>{(problem) => <li>{problem}</li>}</For></ul></div>
        </Show>
        <Failure error={write.error()} />
      </Show>
    </div>
  );

  const bar = (): JSX.Element => (
    <Show when={selection().size > 0}>
      <section aria-label={t("files.selection")} class="sticky bottom-3 z-10 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-card border border-outline-gray-2 bg-surface-elevation-1 p-2 shadow-sm">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 px-1">
          <span class="t-text font-medium text-ink" role="status">{tn("files.selected", selection().size)}</span>
          <span class="t-small tabular-nums text-ink-2">{tn("files.selected.files", chosen().length)} · {bytes(chosen().reduce((sum, file) => sum + file.bytes, 0))}</span>
          <Show when={!onlyMine()}><span class="t-small text-needs-text">{t("files.selection.pack")}</span></Show>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" iconLeft="lucide-download" onClick={() => void downloadAll(place.id(), chosen().map((file) => file.path))}>{t("files.download.n", { n: chosen().length })}</Button>
          <Show when={chosen().length > 1}><Button variant="outline" size="sm" iconLeft="lucide-archive" onClick={() => void downloadZip(chosen().map((file) => ({ name: file.path, url: downloadUrl(place.id(), file.path) })), "files.zip")}>{t("outputs.zip")}</Button></Show>
          <Show when={!props.readOnly}>
            <Button variant="outline" size="sm" iconLeft="lucide-copy" onClick={() => setTransfer("copy")}>{t("files.copy.n", { n: chosen().length })}</Button>
            <Button variant="outline" size="sm" iconLeft="lucide-folder-input" disabled={!onlyMine()} onClick={() => setTransfer("move")}>{t("files.move.n", { n: chosen().length })}</Button>
            <Button variant="solid" theme="red" size="sm" iconLeft="lucide-trash-2" disabled={!onlyMine()} onClick={() => setDeleting(true)}>{t("files.delete.n", { n: chosen().length })}</Button>
          </Show>
          <Button variant="ghost" size="sm" onClick={() => setSelection(new Set<string>())}>{t("files.clear")}</Button>
        </div>
      </section>
    </Show>
  );

  return (
    <div classList={{ "drop-active": dragging() }} data-testid="files"
      onDragEnter={(event) => { if (!props.readOnly && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragOver={(event) => { if (!props.readOnly && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={dropped}>
      <input ref={picker} type="file" multiple hidden aria-label={t("files.upload")} onChange={(event) => { const chosenFiles = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void stage(chosenFiles); }} />
      <Show when={dragging()}><p class="mb-3 rounded-control bg-surface-gray-2 px-4 py-3 t-small font-medium text-ink" role="status">{t("files.upload.drop", { folder: cleanPath(target()) || "/" })}</p></Show>
      {toolbar()}
      {bar()}
      <Show when={props.files.some((file) => !file.path.endsWith(".gitkeep"))} fallback={
        <EmptyState bordered icon="lucide-cloud-upload" title={t("files.empty.title")} description={props.readOnly ? t("files.empty.viewer") : t("files.empty.text")} action={props.readOnly ? undefined : uploadButton()} />
      }>
        <Show when={selected()} keyed fallback={
          <div class="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
            <div class="max-lg:order-2">{tree()}</div>
            {listing()}
          </div>
        }>
          {(path) => (
            <PaneLayout active="end" defaultSize={36} minStartSize={24} maxStartSize={50} resizeLabel={t("task.resize")} start={<div class="lg:pe-5 max-lg:hidden">{listing()}</div>}
              end={
                <div class="min-w-0 lg:ps-6">
                  <A href={href(undefined, false, folder())} class="link mb-3 inline-flex items-center gap-1 t-small"><Icon name="lucide-chevron-left" class="size-3.5 rtl:rotate-180" />{folder() || t("workspace.tab.files")}</A>
                  <Show when={props.files.some((file) => file.path === path) || isNew()} fallback={<EmptyState bordered title={t("workspace.notFound", { name: path })} />}>
                    <FileView path={path} isNew={isNew()} readOnly={props.readOnly} open={(to) => open(to)} />
                  </Show>
                </div>
              } />
          )}
        </Show>
      </Show>
      <TransferDialog mode={transfer()} files={props.files} selected={selection()} start={folder()} onClose={() => setTransfer(undefined)} onDone={(into) => { setTransfer(undefined); setSelection(new Set<string>()); go(into); }} />
      <DeleteDialog open={deleting()} paths={chosen().map((file) => file.path)} onClose={() => setDeleting(false)} onDone={() => { setDeleting(false); setSelection(new Set<string>()); }} />
      <Dialog.Root open={pending() !== undefined} onOpenChange={(opened) => { if (!opened) setPending(undefined); }}>
        <Dialog.Content size="sm">
          <Dialog.Header>
            <Dialog.Title>{t("files.upload.replace.title")}</Dialog.Title>
            <Dialog.Description>{t("files.upload.replace.text", { files: (pending()?.replaces ?? []).join(", ") })}{(pending()?.replaces ?? []).some(isConfiguration) ? ` ${t("files.warn.config")}` : ""}</Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer actions={[{ label: t("action.cancel"), variant: "ghost" }, { label: t("files.upload.replace.confirm"), variant: "solid", theme: "red", onClick: ({ close }) => { const uploads = pending()?.uploads ?? []; close(); void write.run(uploads); } }]} />
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
