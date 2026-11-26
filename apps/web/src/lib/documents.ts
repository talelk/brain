import type { FileEntry } from "@brain/contracts";

/**
 * The documents of a workspace folder, as the Files tab handles them (docs/model.md, Documents). The limits and the name rules are the
 * Governor's, written here so a refusal can be shown before anything is sent; the Governor checks them again.
 */
export const MAX_FILE = 5 * 1024 * 1024;
export const MAX_UPLOAD = 20 * 1024 * 1024;
/** A text file longer than this is not opened in the editor. */
export const MAX_EDITED = 512 * 1024;
export const DEFAULT_FOLDER = "docs";

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
export const extensionOf = (path: string): string => path.split("/").at(-1)?.split(".").slice(1).at(-1)?.toLowerCase() ?? "";
export const isImage = (path: string): boolean => IMAGES.has(extensionOf(path));
export const isMarkdown = (path: string): boolean => ["md", "markdown"].includes(extensionOf(path));
/** What Brain reads as configuration: changing it changes what agents do. */
export const isConfiguration = (path: string): boolean => path === "brain.toml" || /^(?:agents|tools|plays|skills|memory)\//u.test(path);
/** Where the bytes of a file are downloaded from. */
export const downloadUrl = (workspaceId: string, path: string): string => `/v1/workspaces/${workspaceId}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Whether a file name can be uploaded: no hidden name (except `.gitkeep`), no slash, no control character. */
export function nameOk(name: string): boolean {
  return name !== "" && name.length <= 120 && name !== "." && name !== ".." && !/[/\\\u0000-\u001f\u007f]/u.test(name) && (!name.startsWith(".") || name === ".gitkeep");
}
/** A typed path, cleaned: no leading or trailing slash, no doubled slash. */
export const cleanPath = (text: string): string => text.trim().replace(/\\/gu, "/").split("/").filter((part) => part !== "").join("/");
export const pathOk = (path: string): boolean => path !== "" && path.length <= 300 && path.split("/").length <= 12 && path.split("/").every((part, index, parts) => nameOk(part) && (part !== ".gitkeep" || index === parts.length - 1));

export const folderOf = (path: string): string => path.split("/").slice(0, -1).join("/");

/** Bytes as base64, for a write. */
export function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/** A limit in megabytes, as the Governor states it (binary megabytes). */
export const mb = (value: number): string => `${value / 1024 / 1024} MB`;

/** One line of the folder being looked at: a file, or a folder with what is under it. */
export interface Row {
  readonly kind: "folder" | "file";
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  /** For a folder: how many files are under it. */
  readonly count: number;
  /** `workspace`, or the pack that supplies it (for a folder: the pack when every file is that pack's). */
  readonly source: string;
  readonly replaces?: string;
  readonly lastCommit?: { readonly message: string; readonly atMs: number };
}
const isKeep = (path: string): boolean => path === ".gitkeep" || path.endsWith("/.gitkeep");

/** What is directly in `folder` ("" is the top): folders first, then files. `.gitkeep` makes its folder exist and is not shown. */
export function rowsOf(files: readonly FileEntry[], folder: string): Row[] {
  const prefix = folder === "" ? "" : `${folder}/`;
  const folders = new Map<string, FileEntry[]>();
  const rows: Row[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const [head = "", ...more] = rest.split("/");
    if (more.length > 0) folders.set(head, [...(folders.get(head) ?? []), file]);
    else if (!isKeep(file.path)) rows.push({ kind: "file", name: head, path: file.path, bytes: file.bytes, count: 0, source: file.source, ...(file.replaces ? { replaces: file.replaces } : {}), ...(file.lastCommit ? { lastCommit: file.lastCommit } : {}) });
  }
  for (const [name, inside] of folders) {
    const shown = inside.filter((file) => !isKeep(file.path));
    const sources = new Set(inside.map((file) => file.source));
    const last = inside.reduce<Row["lastCommit"]>((best, file) => (file.lastCommit && (!best || file.lastCommit.atMs > best.atMs) ? file.lastCommit : best), undefined);
    rows.push({ kind: "folder", name, path: `${prefix}${name}`, bytes: shown.reduce((sum, file) => sum + file.bytes, 0), count: shown.length, source: sources.size === 1 ? ([...sources][0] ?? "workspace") : "workspace", ...(last ? { lastCommit: last } : {}) });
  }
  return rows;
}

/** Every folder that holds a file, as nested items for a tree, with the number of files under each. */
export interface FolderItem { value: string; label: string; children: FolderItem[]; count: number; [key: string]: unknown }
export function foldersOf(files: readonly FileEntry[]): FolderItem[] {
  const root: FolderItem = { value: "", label: "", children: [], count: 0 };
  for (const file of files) {
    let at = root;
    const parts = file.path.split("/").slice(0, -1);
    for (const [index, name] of parts.entries()) {
      const path = parts.slice(0, index + 1).join("/");
      let next = at.children.find((child) => child.value === path);
      if (!next) { next = { value: path, label: name, children: [], count: 0 }; at.children.push(next); }
      if (!isKeep(file.path)) next.count += 1;
      at = next;
    }
  }
  const order = (items: FolderItem[]): FolderItem[] => items.sort((a, b) => a.label.localeCompare(b.label)).map((item) => ({ ...item, label: `${item.label} (${item.count})`, children: order(item.children) }));
  return order(root.children);
}

/** The files a selection stands for: each selected file, and every file under each selected folder. */
export const under = (files: readonly FileEntry[], selected: ReadonlySet<string>): FileEntry[] =>
  files.filter((file) => [...selected].some((path) => file.path === path || file.path.startsWith(`${path}/`)));

export type Conflict = "skip" | "replace" | "both";
export interface Planned { readonly from: string; readonly to: string }
/**
 * Where each selected file goes when the selection is copied or moved into `destination`: a selected folder keeps its name and what is
 * under it. A path that already exists is skipped, replaced, or given a new name ("a copy.md", "a copy 2.md"), by `conflict`.
 */
export function plan(files: readonly FileEntry[], selected: ReadonlySet<string>, destination: string, conflict: Conflict): { moves: Planned[]; skipped: string[] } {
  const taken = new Set(files.map((file) => file.path));
  const moves: Planned[] = [];
  const skipped: string[] = [];
  for (const top of selected) {
    const parent = folderOf(top);
    for (const file of files.filter((entry) => entry.path === top || entry.path.startsWith(`${top}/`))) {
      const relative = file.path.slice(parent === "" ? 0 : parent.length + 1);
      let to = destination === "" ? relative : `${destination}/${relative}`;
      if (to === file.path && conflict !== "both") { skipped.push(file.path); continue; }
      if (taken.has(to)) {
        if (conflict === "skip") { skipped.push(to); continue; }
        if (conflict === "both") {
          const dot = to.lastIndexOf(".") > to.lastIndexOf("/") + 1 ? to.lastIndexOf(".") : to.length;
          let copy = 1;
          let renamed = `${to.slice(0, dot)} copy${to.slice(dot)}`;
          while (taken.has(renamed)) { copy += 1; renamed = `${to.slice(0, dot)} copy ${copy}${to.slice(dot)}`; }
          to = renamed;
        }
      }
      taken.add(to);
      moves.push({ from: file.path, to });
    }
  }
  return { moves, skipped };
}
