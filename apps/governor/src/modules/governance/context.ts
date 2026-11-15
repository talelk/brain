import type { ActionSubject, ApprovalContext, JsonValue, ProposedChange } from "@brain/contracts";
import type { Store } from "../../application/store";
import { releaseRecord } from "../configuration/index";
import { describeOrigin } from "../missions/index";

export type ReleaseTools = NonNullable<NonNullable<ReturnType<typeof releaseRecord>>["release"]["manifest"]["tools"]> | undefined;

/** The most a file change of one approval may carry (the pull request tool's own limits): more than this is not rendered, and the exact JSON stays. */
const MAX_FILES = 20;
const MAX_FILE_BYTES = 100 * 1024;

/** The tools whose arguments name files to be committed; their approvals are read as a diff, not as JSON. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["git.open-pr"]);

function lineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * The files an approved call would commit, as a unified diff. Brain does not read the repository before the decision, so each file is
 * shown as its whole new content (every line added): a file already at that path is replaced, never merged. Undefined when the tool
 * commits no files or the arguments are not a well-formed list of them.
 */
export function proposedChange(toolId: string, args: JsonValue | undefined): ProposedChange | undefined {
  if (!FILE_TOOLS.has(toolId) || args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const files = (args as Record<string, JsonValue>)["files"];
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return undefined;
  const rendered: Array<{ path: string; lines: number; bytes: number }> = [];
  const patches: string[] = [];
  for (const file of files) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) return undefined;
    const { path, content } = file as Record<string, JsonValue>;
    if (typeof path !== "string" || !path || path.length > 512 || typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return undefined;
    const lines = lineCount(content);
    rendered.push({ path, lines, bytes: Buffer.byteLength(content, "utf8") });
    patches.push([`+++ b/${path}`, `@@ whole file, ${lines} line${lines === 1 ? "" : "s"} @@`, ...(lines === 0 ? [] : content.split("\n").slice(0, lines).map((line) => `+${line}`))].join("\n"));
  }
  return { files: rendered, diff: patches.join("\n") };
}

/**
 * What is read beside an approval, never bound by it (ADR 0048): the mission and task it was asked for (current titles), the change as a
 * diff, and the rollback the pinned Tool document declares. The digest covers the subject only, so none of this can change it.
 */
export function approvalContext(s: Store, organizationId: string, workspaceId: string, subject: ActionSubject, releases: Map<string, ReleaseTools> = new Map()): ApprovalContext {
  const origin = subject.origin ? describeOrigin(s.workspaceDb(workspaceId, organizationId), subject.origin) : undefined;
  const change = proposedChange(subject.tool.id, subject.effectBounds["arguments"]);
  // A list reads many approvals of the same release: its Tool documents are read once.
  if (!releases.has(subject.configDigest)) releases.set(subject.configDigest, releaseRecord(s, organizationId, subject.configDigest)?.release.manifest.tools);
  const declared = releases.get(subject.configDigest)?.find((tool) => tool.id === subject.tool.id && tool.digest === subject.tool.digest)?.compensatingAction;
  return { ...(origin ?? {}), ...(change ? { change } : {}), rollback: declared ? { declared: true, action: declared } : { declared: false } };
}
