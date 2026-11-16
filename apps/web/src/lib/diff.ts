/** Reads `git diff` output into files and lines, for showing a working copy's change. */
export interface DiffLine { readonly kind: "add" | "del" | "context" | "hunk"; readonly text: string; readonly old?: number; readonly new?: number }
export interface DiffFile { readonly path: string; readonly added: number; readonly removed: number; readonly lines: readonly DiffLine[] }

export function parseDiff(text: string): DiffFile[] {
  const files: Array<{ path: string; added: number; removed: number; lines: DiffLine[] }> = [];
  let current: (typeof files)[number] | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: /^diff --git a\/(.*) b\/(.*)$/u.exec(line)?.[2] ?? line.slice(11), added: 0, removed: 0, lines: [] };
      files.push(current);
    } else if (!current) continue;
    else if (line.startsWith("@@")) {
      const at = /^@@ -(\d+)[^+]*\+(\d+)/u.exec(line);
      oldLine = Number(at?.[1] ?? 1);
      newLine = Number(at?.[2] ?? 1);
      current.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename ") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("\\")) continue;
    else if (line.startsWith("+")) { current.added += 1; current.lines.push({ kind: "add", text: line.slice(1), new: newLine++ }); }
    else if (line.startsWith("-")) { current.removed += 1; current.lines.push({ kind: "del", text: line.slice(1), old: oldLine++ }); }
    else if (current.lines.length > 0) current.lines.push({ kind: "context", text: line.slice(1), old: oldLine++, new: newLine++ });
  }
  return files;
}
