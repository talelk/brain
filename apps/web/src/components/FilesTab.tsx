import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Dialog, EmptyState, toast } from "@talelk/newui-molecules";
import { PaneLayout } from "@talelk/newui-templates";
import type { FileEntry } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { DEFAULT_FOLDER, MAX_EDITED, MAX_FILE, MAX_UPLOAD, base64Of, cleanPath, downloadUrl, folderOf, isConfiguration, isImage, isMarkdown, mb, nameOk, pathOk, treeOf, type TreeNode } from "../lib/documents";
import { ago, bytes } from "../lib/format";
import { CodeEditor } from "./CodeEditor";
import { Markdown } from "./Markdown";
import { ConfirmButton, Failure, Icon } from "./bits";

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
  const editable = (): boolean => !props.readOnly && !binary() && size() <= MAX_EDITED;

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
          <Show when={!props.readOnly && !props.isNew && file.data()}>
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
      <Show when={props.readOnly}><p class="mb-5 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2">{t("files.readOnly")}</p></Show>
      <Show when={props.isNew || file.data()} fallback={<Failure error={file.error()} />}>
        <Switch>
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

/** A link to a file. The router's own link marks itself current by path alone, and every file shares the path of this tab, so this one looks at the query too. */
function FileLink(props: { href: string; current: boolean; children: JSX.Element }): JSX.Element {
  const navigate = useNavigate();
  return (
    <a href={props.href} aria-current={props.current ? "page" : undefined} class="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-surface-gray-2 aria-[current=page]:bg-surface-gray-3 focus-visible:focus-ring"
      onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); navigate(props.href); }}>{props.children}</a>
  );
}

function Branch(props: { nodes: readonly TreeNode[]; open: (path: string) => boolean; toggle: (node: TreeNode) => void; href: (path: string) => string; current: string }): JSX.Element {
  return (
    <ul class="flex flex-col gap-0.5">
      <For each={props.nodes}>
        {(node) => (
          <li>
            <Show when={node.folder} fallback={
              <FileLink href={props.href(node.path)} current={props.current === node.path}>
                <Icon name={isImage(node.path) ? "lucide-image" : "lucide-file-text"} class="size-4 text-ink-3" />
                <span class="min-w-0 flex-1 truncate t-text text-ink code-ltr" dir="ltr">{node.name}</span>
                <span class="shrink-0 t-small text-ink-2" dir="ltr">{bytes(node.bytes)}</span>
              </FileLink>
            }>
              <button type="button" aria-expanded={props.open(node.path)} onClick={() => props.toggle(node)} class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-start hover:bg-surface-gray-2 focus-visible:focus-ring">
                <Icon name="lucide-chevron-right" class={`size-4 text-ink-3 transition-transform rtl:rotate-180 ${props.open(node.path) ? "rotate-90 rtl:rotate-90" : ""}`} />
                <Icon name={props.open(node.path) ? "lucide-folder-open" : "lucide-folder"} class="size-4 text-ink-3" />
                <span class="min-w-0 flex-1 truncate t-text font-semibold text-ink code-ltr" dir="ltr">{node.name}</span>
              </button>
              <Show when={props.open(node.path)}>
                <div class="ms-3 border-s border-rule ps-1"><Branch nodes={node.children} open={props.open} toggle={props.toggle} href={props.href} current={props.current} /></div>
              </Show>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

export function FilesTab(props: { files: readonly FileEntry[]; readOnly: boolean }): JSX.Element {
  const place = usePlace();
  const navigate = useNavigate();
  const [search] = useSearchParams<{ path?: string; new?: string }>();
  const mine = createMemo(() => props.files.filter((file) => file.source === "workspace"));
  const present = createMemo(() => new Set(mine().map((file) => file.path)));
  const tree = createMemo(() => treeOf(mine()));
  const [filter, setFilter] = createSignal("");
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set([DEFAULT_FOLDER]));
  const [target, setTarget] = createSignal(DEFAULT_FOLDER);
  const [problems, setProblems] = createSignal<readonly string[]>([]);
  const [pending, setPending] = createSignal<{ uploads: readonly Upload[]; replaces: readonly string[] }>();
  const [dragging, setDragging] = createSignal(false);
  const [naming, setNaming] = createSignal<string>();
  let picker: HTMLInputElement | undefined;

  const selected = (): string => search.path ?? "";
  const isNew = (): boolean => search.new !== undefined && !present().has(selected());
  const href = (path?: string, fresh = false): string => `${place.to("/workspace/files")}${path ? `?path=${encodeURIComponent(path)}${fresh ? "&new=1" : ""}` : ""}`;
  const open = (path: string | undefined, fresh = false): void => navigate(href(path, fresh));
  const isOpen = (path: string): boolean => filter() !== "" || expanded().has(path) || selected().startsWith(`${path}/`);
  const toggle = (node: TreeNode): void => {
    const next = new Set(expanded());
    if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
    setExpanded(next);
    setTarget(node.path);
  };
  const matches = createMemo(() => {
    const words = filter().trim().toLowerCase();
    return words === "" ? [] : mine().filter((file) => !file.path.endsWith("/.gitkeep") && file.path.toLowerCase().includes(words));
  });
  const documents = (): boolean => mine().some((file) => !isConfiguration(file.path));

  const write = useAction(async (uploads: readonly Upload[]) => {
    await command("file.write", { workspaceId: place.id(), files: [...uploads], message: uploads.length === 1 ? `Upload ${uploads[0]?.path}` : `Upload ${uploads.length} files to ${folderOf(uploads[0]?.path ?? "") || "the folder"}` });
    toast.success({ title: t("files.upload.done") });
    setExpanded(new Set([...expanded(), ...uploads.flatMap((upload) => upload.path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/")))]));
    const first = uploads[0];
    if (first && uploads.length === 1) open(first.path);
  });

  /** Checks the files against the limits and the name rules, then sends them, after a confirmation when they replace files. */
  const stage = async (list: readonly File[]): Promise<void> => {
    if (props.readOnly || list.length === 0) return;
    const folder = cleanPath(target());
    const found: string[] = [];
    if (folder !== "" && !pathOk(folder)) found.push(t("files.upload.error.folder", { folder }));
    const accepted: File[] = [];
    for (const file of list) {
      if (!nameOk(file.name)) found.push(t("files.upload.error.name", { name: file.name }));
      else if (file.size > MAX_FILE) found.push(t("files.upload.error.size", { name: file.name, limit: mb(MAX_FILE) }));
      else accepted.push(file);
    }
    if (accepted.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD) { found.push(t("files.upload.error.total", { limit: mb(MAX_UPLOAD) })); accepted.length = 0; }
    setProblems(found);
    if (accepted.length === 0 || (folder !== "" && !pathOk(folder))) return;
    const uploads = await Promise.all(accepted.map(async (file): Promise<Upload> => {
      const path = folder === "" ? file.name : `${folder}/${file.name}`;
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
  const list = (): JSX.Element => (
    <div class={selected() ? "max-lg:hidden" : ""}>
      <TextInput size="md" type="search" label={t("files.filter")} placeholder={t("files.filter")} value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} />
      <Show when={!props.readOnly}>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          {uploadButton()}
          <Button variant="outline" size="md" iconLeft="lucide-file-plus" onClick={() => setNaming(naming() === undefined ? `${DEFAULT_FOLDER}/` : undefined)}>{t("files.new")}</Button>
        </div>
        <div class="mt-3"><TextInput size="md" class="t-code" label={t("files.upload.to")} value={target()} onInput={(event) => setTarget(event.currentTarget.value)} /></div>
        <p class="mt-1 t-small text-ink-2">{t("files.upload.limits", { file: mb(MAX_FILE), total: mb(MAX_UPLOAD) })}</p>
        <Show when={naming() !== undefined}>
          <form class="mt-3 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); create(); }}>
            <div class="min-w-0 flex-1"><TextInput size="md" class="t-code" label={t("files.new.path")} value={naming() ?? ""} onInput={(event) => setNaming(event.currentTarget.value)} autofocus /></div>
            <Button type="submit" variant="outline" size="md" disabled={!pathOk(cleanPath(naming() ?? "")) || present().has(cleanPath(naming() ?? ""))}>{t("workspace.new.create")}</Button>
          </form>
        </Show>
        <Show when={problems().length > 0}>
          <div class="mt-3 rounded-xl bg-bad-soft px-4 py-3 t-small text-bad" role="alert"><ul class="flex flex-col gap-1"><For each={problems()}>{(problem) => <li>{problem}</li>}</For></ul></div>
        </Show>
        <Failure error={write.error()} class="mt-3" />
      </Show>
      <nav class="mt-4" aria-label={t("files.tree")}>
        <Show when={filter() === ""} fallback={
          <Show when={matches().length > 0} fallback={<p class="px-2 t-small text-ink-2">{t("files.noMatch")}</p>}>
            <ul class="flex flex-col gap-0.5">
              <For each={matches()}>{(file) => (
                <li><FileLink href={href(file.path)} current={selected() === file.path}>
                  <span class="min-w-0 flex-1 truncate t-text text-ink code-ltr" dir="ltr">{file.path}</span><span class="shrink-0 t-small text-ink-2" dir="ltr">{bytes(file.bytes)}</span>
                </FileLink></li>
              )}</For>
            </ul>
          </Show>
        }>
          <Branch nodes={tree()} open={isOpen} toggle={toggle} href={href} current={selected()} />
        </Show>
      </nav>
    </div>
  );

  return (
    <div classList={{ "drop-active": dragging() }}
      onDragOver={(event) => { if (!props.readOnly && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={dropped}>
      <input ref={picker} type="file" multiple hidden aria-label={t("files.upload")} onChange={(event) => { const chosen = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void stage(chosen); }} />
      <Show when={dragging()}><p class="mb-3 rounded-control bg-surface-gray-2 px-4 py-3 t-small font-medium text-ink" role="status">{t("files.upload.drop", { folder: cleanPath(target()) || "/" })}</p></Show>
      <PaneLayout active={selected() ? "end" : "start"} defaultSize={30} minStartSize={22} maxStartSize={45} resizeLabel={t("task.resize")} start={<div class="lg:pe-5">{list()}</div>}
        end={
          <div class="min-w-0 lg:ps-6">
            <Show when={selected()} keyed fallback={
              <div class="max-lg:hidden">
                <EmptyState bordered icon={documents() ? "lucide-mouse-pointer-click" : "lucide-cloud-upload"} title={documents() ? t("files.pick") : t("files.empty.title")}
                  description={props.readOnly ? t("files.empty.viewer") : documents() ? t("files.pick.text") : t("files.empty.text")} action={props.readOnly ? undefined : uploadButton()} />
              </div>
            }>
              {(path) => (
                <>
                  <A href={href()} class="link mb-3 inline-flex items-center gap-1 t-small lg:hidden"><Icon name="lucide-chevron-left" class="size-3.5 rtl:rotate-180" />{t("workspace.tab.files")}</A>
                  <Show when={present().has(path) || isNew()} fallback={<EmptyState bordered title={t("workspace.notFound", { name: path })} />}>
                    <FileView path={path} isNew={isNew()} readOnly={props.readOnly} open={(to) => open(to)} />
                  </Show>
                </>
              )}
            </Show>
          </div>
        } />
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
