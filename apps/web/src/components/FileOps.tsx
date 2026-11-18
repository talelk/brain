import { createEffect, createSignal, For, on, type JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Dialog, toast, Tree } from "@talelk/newui-molecules";
import type { FileEntry } from "@brain/contracts";
import { ApiFailure, command, query, useAction } from "../data/api";
import { usePlace } from "../data/session";
import { t, tn } from "../i18n";
import { base64Of, cleanPath, downloadUrl, foldersOf, pathOk, plan, under, type Conflict } from "../lib/documents";
import { Failure } from "./bits";
import { Choice } from "./fields";

/** Copy and move of files and folders (one commit each), and delete: what the Files tab's selection bar does. */

const bytesOf = async (workspaceId: string, path: string): Promise<{ content: string; encoding?: "base64" }> => {
  const file = await query("file.read", { workspaceId, path });
  if (!file.binary) return { content: file.content };
  const response = await fetch(downloadUrl(workspaceId, path), { credentials: "same-origin" });
  if (!response.ok) throw new ApiFailure(response.status === 404 ? "NOT_FOUND" : "INTERNAL", "");
  return { content: base64Of(await response.arrayBuffer()), encoding: "base64" };
};

/** Where to put the selection: a folder picked in a tree or typed, and what to do with a name that is taken. */
export function TransferDialog(props: { mode: "copy" | "move" | undefined; files: readonly FileEntry[]; selected: ReadonlySet<string>; start: string; onClose: () => void; onDone: (folder: string) => void }): JSX.Element {
  const place = usePlace();
  const [destination, setDestination] = createSignal("");
  const [conflict, setConflict] = createSignal<Conflict>("skip");
  createEffect(on(() => props.mode, (mode) => { if (mode) { setDestination(props.start); setConflict("skip"); } }));
  const folder = (): string => cleanPath(destination());
  const ready = (): boolean => (folder() === "" || pathOk(folder())) && props.selected.size > 0;
  const sources = (): readonly FileEntry[] => under(props.files, props.selected);
  const inside = (): boolean => props.mode === "move" && [...props.selected].some((path) => folder() === path || folder().startsWith(`${path}/`));
  const run = useAction(async () => {
    const mode = props.mode;
    if (!mode) return;
    const { moves, skipped } = plan(props.files, props.selected, folder(), conflict());
    if (moves.length > 200) throw new Error(t("files.transfer.tooMany"));
    const written = await Promise.all(moves.map(async (move) => ({ path: move.to, ...(await bytesOf(place.id(), move.from)) })));
    const message = `${mode === "move" ? "Move" : "Copy"} ${moves.length === 1 ? (moves[0]?.from ?? "") : `${moves.length} files`} to ${folder() || "the top"}`;
    await command("file.write", { workspaceId: place.id(), files: written, remove: mode === "move" ? moves.filter((move) => move.from !== move.to).map((move) => move.from) : [], message });
    toast.success({ title: tn(mode === "move" ? "files.moved" : "files.copied", moves.length, { skipped: skipped.length }) });
    props.onDone(folder());
  });
  return (
    <Dialog.Root open={props.mode !== undefined} onOpenChange={(open) => { if (!open) { props.onClose(); run.clear(); } }}>
      <Dialog.Content size="lg">
        <Dialog.Header>
          <Dialog.Title>{props.mode === "move" ? t("files.move.title", { n: sources().length }) : t("files.copy.title", { n: sources().length })}</Dialog.Title>
          <Dialog.Description>{t("files.transfer.text")}</Dialog.Description>
        </Dialog.Header>
        <form class="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (ready() && !inside()) void run.run(); }}>
          <div>
            <p class="mb-1 t-small font-medium text-ink-2" id="pick-folder">{t("files.transfer.pick")}</p>
            <div class="max-h-52 overflow-auto rounded-control border border-outline-gray-1 p-1">
              <Tree.Root items={foldersOf(props.files)} selectedValue={[folder()]} onSelectionChange={(value) => setDestination(value[0] ?? "")} defaultExpandedValue={folder().split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))}>
                <Tree.Label class="sr-only">{t("files.tree")}</Tree.Label>
                <Tree.Tree aria-labelledby="pick-folder"><For each={foldersOf(props.files)}>{(node, index) => <Tree.Node node={node} indexPath={[index()]} />}</For></Tree.Tree>
              </Tree.Root>
            </div>
          </div>
          <TextInput size="md" class="t-code" label={t("files.transfer.to")} description={t("files.transfer.to.help")} value={destination()} onInput={(event) => setDestination(event.currentTarget.value)} error={folder() !== "" && !pathOk(folder()) ? t("files.upload.error.folder", { folder: folder() }) : inside() ? t("files.move.inside") : undefined} />
          <Choice label={t("files.conflict")} value={conflict()} onChange={setConflict} options={[{ value: "skip", label: t("files.conflict.skip"), help: t("files.conflict.skip.help") }, { value: "replace", label: t("files.conflict.replace"), help: t("files.conflict.replace.help") }, { value: "both", label: t("files.conflict.both"), help: t("files.conflict.both.help") }]} />
          <Failure error={run.error()} />
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={props.onClose}>{t("action.cancel")}</Button>
            <Button type="submit" variant="solid" theme="blue" size="md" loading={run.busy()} disabled={!ready() || inside()}>{props.mode === "move" ? t("files.move") : t("files.copy")}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Asks before removing the selection; the removal is one commit that git can revert. */
export function DeleteDialog(props: { open: boolean; paths: readonly string[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const place = usePlace();
  const remove = useAction(async () => {
    await command("file.delete", { workspaceId: place.id(), paths: [...props.paths], message: props.paths.length === 1 ? `Remove ${props.paths[0]}` : `Remove ${props.paths.length} files` });
    props.onDone();
  });
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) { props.onClose(); remove.clear(); } }}>
      <Dialog.Content size="sm">
        <Dialog.Header><Dialog.Title>{tn("files.delete.title", props.paths.length)}</Dialog.Title><Dialog.Description>{tn("files.delete.many", props.paths.length)}</Dialog.Description></Dialog.Header>
        <Failure error={remove.error()} class="mt-3" />
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={props.onClose}>{t("action.cancel")}</Button>
          <Button variant="solid" theme="red" size="md" loading={remove.busy()} onClick={() => void remove.run()}>{t("action.delete")}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Saves each file in turn through the browser's own download: one request per file. */
export async function downloadAll(workspaceId: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const link = document.createElement("a");
    link.href = downloadUrl(workspaceId, path);
    link.download = path.split("/").at(-1) ?? "file";
    document.body.append(link);
    link.click();
    link.remove();
    await new Promise((done) => setTimeout(done, 200));
  }
}
