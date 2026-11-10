import type { ExecutionLink, WorkItem } from "@brain/contracts";
import type { ArtifactRef } from "../../data/exec-outputs";

/**
 * Outputs as files (T61): the pure model behind the Output Browser's file
 * explorer. Everything here derives from data the existing reads already
 * return — `ArtifactRef` (id, media type, size, state) and the grouping read
 * (work item, mission, execution link) — so the explorer never adds a query.
 */

export type ArtifactPreviewKind = "markdown" | "csv" | "json" | "diff" | "text" | "image" | "pdf" | "none";

const CODE_MEDIA = /^(application\/(x-ndjson|xml|yaml|x-yaml|javascript|typescript|sql))$/u;

/** The native preview kind for a media type; "none" offers download only. */
export function previewKindOf(mediaType: string): ArtifactPreviewKind {
  const kind = mediaType.toLowerCase();
  if (kind.includes("markdown")) return "markdown";
  if (kind.includes("csv")) return "csv";
  if (kind.includes("json")) return "json";
  if (kind.includes("diff") || kind.includes("patch")) return "diff";
  if (kind.startsWith("image/")) return "image";
  if (kind.includes("pdf")) return "pdf";
  if (kind.startsWith("text/") || kind === "application/xml" || CODE_MEDIA.test(kind) || /\+(json|xml)$/u.test(kind)) return "text";
  return "none";
}

/** Row label for the preview kind, shown beside the media type. */
export function previewKindLabel(kind: ArtifactPreviewKind): string {
  return { markdown: "Markdown", csv: "Table", json: "JSON", diff: "Diff", text: "Text", image: "Image", pdf: "PDF", none: "Download only" }[kind];
}

/** An artifact with the state it was listed under (the list itself carries no state). */
export type OutputItem = ArtifactRef & { state: string };

/** Where each artifact came from: its work item, that item's mission and the links that tie them together. */
export interface OutputGrouping {
  workItems: readonly WorkItem[];
  missionTitles: Readonly<Record<string, string>>;
  groupOf: Readonly<Record<string, string>>;
  links: readonly ExecutionLink[];
}

/** One kind → icon mapping so files read by type at a glance. */
export const KIND_ICONS: Record<ArtifactPreviewKind, string> = {
  markdown: "lucide-file-text",
  csv: "lucide-file-spreadsheet",
  json: "lucide-file-json",
  diff: "lucide-file-diff",
  text: "lucide-file-code",
  image: "lucide-file-image",
  pdf: "lucide-file-type",
  none: "lucide-file",
};

const EXTENSIONS: Record<ArtifactPreviewKind, string> = { markdown: "md", csv: "csv", json: "json", diff: "diff", text: "txt", image: "", pdf: "pdf", none: "" };

/**
 * The file name an artifact is shown and downloaded under: its id, with the
 * extension its media type implies when the id carries none. Images use their
 * subtype (`image/png` → `.png`).
 */
export function fileNameOf(artifact: Pick<ArtifactRef, "artifactId" | "mediaType">): string {
  if (/\.[a-z0-9]{1,5}$/iu.test(artifact.artifactId)) return artifact.artifactId;
  const kind = previewKindOf(artifact.mediaType);
  const extension = kind === "image" ? (artifact.mediaType.split("/")[1] ?? "").replace(/^svg\+xml$/u, "svg").replace(/[^a-z0-9]/giu, "") : EXTENSIONS[kind];
  return extension ? `${artifact.artifactId}.${extension}` : artifact.artifactId;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a work item needs from the person looking at its output. */
export function reviewStateOf(item: WorkItem | undefined): "review" | "done" | "other" {
  if (!item) return "other";
  return item.state === "review" ? "review" : item.state === "done" ? "done" : "other";
}

export type FileBadgeTheme = "amber" | "green" | "red" | "gray" | "blue";

/** The single status a file card shows: review need first, then the artifact's own state. */
export function fileStatusOf(artifact: OutputItem, item: WorkItem | undefined): { label: string; theme: FileBadgeTheme } {
  if (artifact.state === "quarantined") return { label: "Failed checks", theme: "red" };
  if (artifact.state === "deleted") return { label: "Deleted", theme: "gray" };
  if (artifact.state === "uploading") return { label: "In progress", theme: "amber" };
  const review = reviewStateOf(item);
  if (review === "review") return { label: "Needs review", theme: "amber" };
  if (review === "done") return { label: "Accepted", theme: "green" };
  return { label: "Final", theme: "blue" };
}

/** Folder ids: the two virtual folders, a mission, a work item and the bucket for output outside any mission. */
export type FolderId = "review" | "all" | "other" | `mission:${string}` | `item:${string}`;

export interface FolderNode {
  value: FolderId;
  label: string;
  icon: string;
  count: number;
  attention?: boolean;
  children?: FolderNode[];
}

/** The explorer's resolved view of one artifact. */
export interface OutputFile {
  artifact: OutputItem;
  name: string;
  kind: ArtifactPreviewKind;
  item: WorkItem | undefined;
  missionId: string | undefined;
  missionTitle: string | undefined;
  link: ExecutionLink | undefined;
  status: { label: string; theme: FileBadgeTheme };
}

export function resolveFiles(artifacts: readonly OutputItem[], grouping: OutputGrouping): OutputFile[] {
  const items = new Map(grouping.workItems.map((item) => [item.workItemId, item]));
  return artifacts.map((artifact) => {
    const itemId = grouping.groupOf[artifact.artifactId];
    const item = itemId ? items.get(itemId) : undefined;
    return {
      artifact,
      name: fileNameOf(artifact),
      kind: previewKindOf(artifact.mediaType),
      item,
      missionId: item?.missionId,
      missionTitle: item ? (grouping.missionTitles[item.missionId] ?? "Mission") : undefined,
      link: item ? grouping.links.find((link) => link.workItemId === item.workItemId) : undefined,
      status: fileStatusOf(artifact, item),
    };
  });
}

export const needsReview = (file: OutputFile) => file.status.label === "Needs review";

/** Folder tree: Needs review, All outputs, then missions → work items, then output outside any mission. */
interface MissionBucket {
  title: string;
  items: Map<string, { title: string; files: OutputFile[] }>;
  files: OutputFile[];
}

export function buildFolders(files: readonly OutputFile[]): FolderNode[] {
  const missions = new Map<string, MissionBucket>();
  const other: OutputFile[] = [];
  for (const file of files) {
    if (!file.item || !file.missionId) {
      other.push(file);
      continue;
    }
    const mission: MissionBucket = missions.get(file.missionId) ?? { title: file.missionTitle ?? "Mission", items: new Map(), files: [] };
    mission.files.push(file);
    const entry = mission.items.get(file.item.workItemId) ?? { title: file.item.title, files: [] };
    entry.files.push(file);
    mission.items.set(file.item.workItemId, entry);
    missions.set(file.missionId, mission);
  }
  const reviewCount = files.filter(needsReview).length;
  const missionNodes = [...missions.entries()]
    .sort(([, left], [, right]) => Number(right.files.some(needsReview)) - Number(left.files.some(needsReview)) || left.title.localeCompare(right.title))
    .map(([missionId, mission]): FolderNode => ({
      value: `mission:${missionId}`,
      label: mission.title,
      icon: "lucide-folder",
      count: mission.files.length,
      attention: mission.files.some(needsReview),
      children: [...mission.items.entries()].map(([workItemId, entry]) => ({
        value: `item:${workItemId}`,
        label: entry.title,
        icon: "lucide-folder-open",
        count: entry.files.length,
        attention: entry.files.some(needsReview),
      })),
    }));
  return [
    { value: "review", label: "Needs review", icon: "lucide-inbox", count: reviewCount, attention: reviewCount > 0 },
    { value: "all", label: "All outputs", icon: "lucide-files", count: files.length },
    ...missionNodes,
    ...(other.length ? [{ value: "other" as const, label: "Not linked to a work item", icon: "lucide-folder-x", count: other.length }] : []),
  ];
}

export function inFolder(file: OutputFile, folder: FolderId): boolean {
  if (folder === "all") return true;
  if (folder === "review") return needsReview(file);
  if (folder === "other") return !file.item;
  if (folder.startsWith("mission:")) return file.missionId === folder.slice("mission:".length);
  return file.item?.workItemId === folder.slice("item:".length);
}

export function matchesSearch(file: OutputFile, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [file.name, file.artifact.mediaType, file.item?.title ?? "", file.missionTitle ?? "", file.status.label].some((field) => field.toLowerCase().includes(needle));
}

/** Files grouped by mission for the file pane; needs-review files and groups first. */
export function groupByMission(files: readonly OutputFile[]): { key: string; title: string; missionId?: string; workspaceId?: string; files: OutputFile[] }[] {
  const groups = new Map<string, { key: string; title: string; missionId?: string; workspaceId?: string; files: OutputFile[] }>();
  for (const file of files) {
    const key = file.missionId ?? "";
    const group = groups.get(key) ?? {
      key,
      title: file.missionTitle ?? "Not linked to a work item",
      ...(file.missionId ? { missionId: file.missionId } : {}),
      ...(file.item ? { workspaceId: file.item.workspaceId } : {}),
      files: [],
    };
    group.files.push(file);
    groups.set(key, group);
  }
  const rank = (group: { key: string; files: OutputFile[] }) => (group.key === "" ? 2 : group.files.some(needsReview) ? 0 : 1);
  return [...groups.values()]
    .sort((left, right) => rank(left) - rank(right))
    .map((group) => ({ ...group, files: [...group.files].sort((left, right) => Number(needsReview(right)) - Number(needsReview(left))) }));
}
