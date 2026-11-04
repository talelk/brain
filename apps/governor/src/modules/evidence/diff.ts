export interface DiffOp {
  type: "context" | "add" | "del";
  text: string;
  a?: number;
  b?: number;
}

/** LCS line diff with a table guard; oversized inputs fall back to replace-all. */
export function lineDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [
      ...a.map((text, index) => ({ type: "del" as const, text, a: index + 1 })),
      ...b.map((text, index) => ({ type: "add" as const, text, b: index + 1 })),
    ];
  }
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", text: a[i]!, a: i + 1, b: j + 1 });
      i += 1; j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: "del", text: a[i]!, a: i + 1 });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j]!, b: j + 1 });
      j += 1;
    }
  }
  while (i < n) { ops.push({ type: "del", text: a[i]!, a: i + 1 }); i += 1; }
  while (j < m) { ops.push({ type: "add", text: b[j]!, b: j + 1 }); j += 1; }
  return ops;
}

/** Group a line diff into unified hunks with the given context size. */
export function unifiedHunks(a: readonly string[], b: readonly string[], context = 3): Array<{ header: string; lines: DiffOp[] }> {
  const ops = lineDiff(a, b);
  const changes = ops.map((op, index) => (op.type === "context" ? -1 : index)).filter((index) => index >= 0);
  if (changes.length === 0) return [];
  const groups: Array<[number, number]> = [];
  let start = changes[0]!;
  let end = changes[0]!;
  for (const index of changes.slice(1)) {
    if (index - end <= context * 2) end = index;
    else { groups.push([start, end]); start = index; end = index; }
  }
  groups.push([start, end]);
  return groups.map(([changeStart, changeEnd]) => {
    const from = Math.max(0, changeStart - context);
    const to = Math.min(ops.length, changeEnd + context + 1);
    const lines = ops.slice(from, to);
    const aLines = lines.filter((op) => op.type !== "add");
    const bLines = lines.filter((op) => op.type !== "del");
    const aStart = aLines[0]?.a ?? 0;
    const bStart = bLines[0]?.b ?? 0;
    return { header: `@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`, lines };
  });
}
