/** The files of a pack at two versions as one unified diff (what `Diff` reads): each changed file, line by line. */
export type PackFiles = ReadonlyArray<{ readonly path: string; readonly content: string }>;

const lines = (text: string | undefined): string[] => (text === undefined || text === "" ? [] : text.replace(/\n$/u, "").split("\n"));

function fileDiff(path: string, before: string | undefined, after: string | undefined): string {
  const old = lines(before);
  const now = lines(after);
  const edits: Array<{ kind: " " | "-" | "+"; line: string }> = [];
  if (old.length * now.length > 1_000_000) {
    for (const line of old) edits.push({ kind: "-", line });
    for (const line of now) edits.push({ kind: "+", line });
  } else {
    const table = Array.from({ length: old.length + 1 }, () => new Array<number>(now.length + 1).fill(0));
    for (let i = old.length - 1; i >= 0; i -= 1) for (let j = now.length - 1; j >= 0; j -= 1) table[i]![j] = old[i] === now[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < old.length || j < now.length) {
      if (i < old.length && j < now.length && old[i] === now[j]) { edits.push({ kind: " ", line: old[i] as string }); i += 1; j += 1; }
      else if (j < now.length && (i === old.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { edits.push({ kind: "+", line: now[j] as string }); j += 1; }
      else { edits.push({ kind: "-", line: old[i] as string }); i += 1; }
    }
  }
  const changed = edits.flatMap((edit, at) => (edit.kind === " " ? [] : [at]));
  if (changed.length === 0) return "";
  const out = [`diff --git a/${path} b/${path}`];
  let from = 0;
  while (from < changed.length) {
    let to = from;
    while (to + 1 < changed.length && (changed[to + 1] as number) - (changed[to] as number) <= 7) to += 1;
    const start = Math.max(0, (changed[from] as number) - 3);
    const slice = edits.slice(start, Math.min(edits.length, (changed[to] as number) + 4));
    const oldStart = edits.slice(0, start).filter((edit) => edit.kind !== "+").length + 1;
    const newStart = edits.slice(0, start).filter((edit) => edit.kind !== "-").length + 1;
    out.push(`@@ -${oldStart},${slice.filter((edit) => edit.kind !== "+").length} +${newStart},${slice.filter((edit) => edit.kind !== "-").length} @@`, ...slice.map((edit) => `${edit.kind}${edit.line}`));
    from = to + 1;
  }
  return out.join("\n");
}

export function packDiff(before: PackFiles, after: PackFiles): string {
  const was = new Map(before.map((file) => [file.path, file.content]));
  const now = new Map(after.map((file) => [file.path, file.content]));
  return [...new Set([...was.keys(), ...now.keys()])].sort().map((path) => fileDiff(path, was.get(path), now.get(path))).filter((part) => part !== "").join("\n");
}
