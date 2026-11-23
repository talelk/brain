/**
 * What a file is, found from its name: one table for the runner (which labels what an agent saved), the Governor (which says what a download
 * is) and the web app (which shows it). `Preview` is how a person is shown it: as a page (`html`), as written text, an image, a table, a tree,
 * a document viewer (`pdf`), a player (`video`), or only downloaded (`file`).
 */
export type Preview = "markdown" | "html" | "image" | "pdf" | "video" | "csv" | "sheet" | "json" | "text" | "file";
interface Kind { readonly type: string; readonly preview: Preview; readonly icon: "text" | "code" | "table" | "image" | "video" | "archive" | "slides" | "file" }

const text = (type: string, preview: Preview = "text", icon: Kind["icon"] = "code"): Kind => ({ type, preview, icon });
const KINDS: Readonly<Record<string, Kind>> = {
  md: text("text/markdown", "markdown", "text"), markdown: text("text/markdown", "markdown", "text"), txt: text("text/plain", "text", "text"), log: text("text/plain", "text", "text"),
  patch: text("text/x-diff"), diff: text("text/x-diff"), json: text("application/json", "json"), csv: text("text/csv", "csv", "table"), tsv: text("text/tab-separated-values", "csv", "table"),
  html: text("text/html", "html"), htm: text("text/html", "html"), css: text("text/css"),
  js: text("text/javascript"), mjs: text("text/javascript"), cjs: text("text/javascript"), ts: text("text/typescript"), tsx: text("text/typescript"), py: text("text/x-python"), sh: text("text/x-shellscript"),
  yaml: text("application/yaml"), yml: text("application/yaml"), toml: text("application/toml"), xml: text("application/xml"),
  svg: { type: "image/svg+xml", preview: "image", icon: "image" }, png: { type: "image/png", preview: "image", icon: "image" }, jpg: { type: "image/jpeg", preview: "image", icon: "image" }, jpeg: { type: "image/jpeg", preview: "image", icon: "image" },
  gif: { type: "image/gif", preview: "image", icon: "image" }, webp: { type: "image/webp", preview: "image", icon: "image" },
  pdf: { type: "application/pdf", preview: "pdf", icon: "text" },
  mp4: { type: "video/mp4", preview: "video", icon: "video" }, webm: { type: "video/webm", preview: "video", icon: "video" },
  zip: { type: "application/zip", preview: "file", icon: "archive" }, gz: { type: "application/gzip", preview: "file", icon: "archive" }, tar: { type: "application/x-tar", preview: "file", icon: "archive" },
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", preview: "file", icon: "text" },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", preview: "sheet", icon: "table" },
  pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", preview: "file", icon: "slides" },
};
const OTHER: Kind = { type: "application/octet-stream", preview: "file", icon: "file" };

const kindOf = (name: string): Kind => KINDS[name.split("/").at(-1)?.split(".").slice(1).at(-1)?.toLowerCase() ?? ""] ?? OTHER;
export const mediaTypeOf = (name: string): string => kindOf(name).type;
export const previewOf = (name: string): Preview => kindOf(name).preview;
export const iconKindOf = (name: string): Kind["icon"] => kindOf(name).icon;
/** The response header of a page preview: scripts run, but never as Brain's own origin, also when the link is opened directly. */
export const PAGE_SANDBOX = "sandbox allow-scripts";
/** Types that may be served to be shown rather than saved: a page (sandboxed), an image, a PDF or a video. Everything else is always a download. */
export const shownInline = (name: string): boolean => ["html", "image", "pdf", "video"].includes(previewOf(name));
