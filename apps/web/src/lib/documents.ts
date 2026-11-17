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
export const isConfiguration = (path: string): boolean => path === "brain.toml" || /^(?:agents|tools|plays|memory)\//u.test(path);
/** Where the bytes of a file are downloaded from. */
export const downloadUrl = (workspaceId: string, path: string): string => `/v1/workspaces/${workspaceId}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Whether a file name can be uploaded: no hidden name (except `.gitkeep`), no slash, no control character. */
export function nameOk(name: string): boolean {
  return name !== "" && name.length <= 120 && name !== "." && name !== ".." && !/[/\\\u0000-\u001f\u007f]/u.test(name) && (!name.startsWith(".") || name === ".gitkeep");
}
/** A typed path, cleaned: no leading or trailing slash, no doubled slash. */
export const cleanPath = (text: string): string => text.trim().replace(/\\/gu, "/").split("/").filter((part) => part !== "").join("/");
export const pathOk = (path: string): boolean => path !== "" && path.length <= 300 && path.split("/").length <= 12 && path.split("/").every((part, index, parts) => nameOk(part) && (part !== ".gitkeep" || index === parts.length - 1));

export interface TreeNode { readonly name: string; readonly path: string; readonly folder: boolean; readonly children: TreeNode[]; readonly bytes: number }

/** The files as folders and files, folders first. A `.gitkeep` is not shown, but makes its folder exist. */
export function treeOf(files: readonly FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", folder: true, children: [], bytes: 0 };
  for (const file of files) {
    let at = root;
    const parts = file.path.split("/");
    for (const [index, name] of parts.entries()) {
      const path = parts.slice(0, index + 1).join("/");
      const last = index === parts.length - 1;
      if (last && name === ".gitkeep") break;
      let next = at.children.find((child) => child.name === name && child.folder === !last);
      if (!next) {
        next = { name, path, folder: !last, children: [], bytes: last ? file.bytes : 0 };
        at.children.push(next);
      }
      at = next;
    }
  }
  const order = (nodes: TreeNode[]): TreeNode[] => nodes.sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1)).map((node) => ({ ...node, children: order(node.children) }));
  return order(root.children);
}

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
