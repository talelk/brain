/** Node-and-edge layout shared by the Task graph and the Team graph: columns by depth, curved edges from one box to the next. */
export interface Box { readonly id: string; readonly h: number }
export interface Link { readonly from: string; readonly to: string }
export interface Placed { readonly id: string; readonly col: number; readonly x: number; readonly y: number; readonly h: number }
export interface Layout { readonly placed: ReadonlyMap<string, Placed>; readonly order: readonly Placed[]; readonly width: number; readonly height: number }

export const NODE_W = 216;
export const COL_GAP = 44;
const ROW_GAP = 14;

/** Columns by the longest way in (a link that would close a loop is ignored), rows by the average row of what feeds a box, boxes centred in their column. */
export function layout(boxes: readonly Box[], links: readonly Link[]): Layout {
  const ids = new Set(boxes.map((box) => box.id));
  const into = new Map<string, string[]>();
  for (const link of links) if (ids.has(link.from) && ids.has(link.to) && link.from !== link.to) into.set(link.to, [...(into.get(link.to) ?? []), link.from]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(into.get(id) ?? []).map((from) => (visiting.has(from) ? -1 : depthOf(from)))) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  const columns: Box[][] = [];
  for (const box of boxes) (columns[depthOf(box.id)] ??= []).push(box);
  const rows = new Map<string, number>();
  const sorted = columns.map((column = []) => column);
  sorted.forEach((column, index) => {
    if (index > 0) {
      const mean = (box: Box): number => { const from = (into.get(box.id) ?? []).map((id) => rows.get(id)).filter((row): row is number => row !== undefined); return from.length === 0 ? Number.MAX_SAFE_INTEGER : from.reduce((sum, row) => sum + row, 0) / from.length; };
      const keyed = column.map((box, at) => ({ box, at, key: mean(box) }));
      keyed.sort((a, b) => a.key - b.key || a.at - b.at);
      column.splice(0, column.length, ...keyed.map((entry) => entry.box));
    }
    column.forEach((box, row) => { rows.set(box.id, row); });
  });
  const heights = sorted.map((column) => column.reduce((sum, box) => sum + box.h, 0) + Math.max(0, column.length - 1) * ROW_GAP);
  const height = Math.max(0, ...heights);
  const placed = new Map<string, Placed>();
  const order: Placed[] = [];
  sorted.forEach((column, col) => {
    let y = (height - (heights[col] ?? 0)) / 2;
    for (const box of column) {
      const at: Placed = { id: box.id, col, x: col * (NODE_W + COL_GAP), y, h: box.h };
      placed.set(box.id, at);
      order.push(at);
      y += box.h + ROW_GAP;
    }
  });
  return { placed, order, width: Math.max(1, sorted.length) * NODE_W + Math.max(0, sorted.length - 1) * COL_GAP, height };
}

/** The curve from one box to a box in another column: out of the side facing it, into the side facing this one. */
export function curve(from: Placed, to: Placed): string {
  const y1 = from.y + from.h / 2;
  const y2 = to.y + to.h / 2;
  const sign = to.col >= from.col ? 1 : -1;
  const x1 = sign > 0 ? from.x + NODE_W : from.x;
  const x2 = sign > 0 ? to.x : to.x + NODE_W;
  const pull = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + sign * pull},${y1} ${x2 - sign * pull},${y2} ${x2},${y2}`;
}

export interface Spot { readonly id: string; readonly x: number; readonly y: number; readonly h: number }
export interface Ring { readonly spots: readonly Spot[]; readonly width: number; readonly height: number }

/** Boxes round an ellipse, neighbours of the graph next to each other, so an arrow never has to pass through a third box. */
export function ring(ids: readonly string[], links: readonly Link[], h: number): Ring {
  const near = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const link of links) { near.get(link.from)?.add(link.to); near.get(link.to)?.add(link.from); }
  const order: string[] = [];
  const visit = (id: string): void => {
    if (order.includes(id)) return;
    order.push(id);
    for (const next of [...(near.get(id) ?? [])].sort((a, b) => (near.get(b)?.size ?? 0) - (near.get(a)?.size ?? 0))) visit(next);
  };
  for (const id of [...ids].sort((a, b) => (near.get(b)?.size ?? 0) - (near.get(a)?.size ?? 0))) visit(id);
  const n = order.length;
  const rx = n <= 1 ? 0 : Math.max(NODE_W * 1.3, (n * (NODE_W + 36)) / (2 * Math.PI) * 1.2);
  const ry = n <= 1 ? 0 : Math.max(h * 2.3, (n * (h + 56)) / (2 * Math.PI));
  const width = 2 * rx + NODE_W;
  const height = 2 * ry + h;
  const spots = order.map((id, at): Spot => {
    const angle = -Math.PI / 2 + (2 * Math.PI * at) / n;
    return { id, x: rx + rx * Math.cos(angle), y: ry + ry * Math.sin(angle), h };
  });
  return { spots, width, height };
}

/** An arrow between two ring boxes: from the border of one to the border of the other, bowed to one side by `bow` pixels. */
export function chord(from: Spot, to: Spot, bow: number): { readonly d: string; readonly mx: number; readonly my: number } {
  const half = (spot: Spot): { x: number; y: number } => ({ x: spot.x + NODE_W / 2, y: spot.y + spot.h / 2 });
  const a = half(from);
  const b = half(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const cx = (a.x + b.x) / 2 - (dy / length) * bow;
  const cy = (a.y + b.y) / 2 + (dx / length) * bow;
  /** Where the line from a box's middle toward `toward` leaves the box (a little outside, for the arrowhead). */
  const edge = (c: { x: number; y: number }, toward: { x: number; y: number }, spot: Spot): { x: number; y: number } => {
    const vx = toward.x - c.x;
    const vy = toward.y - c.y;
    const scale = 1 / Math.max(Math.abs(vx) / (NODE_W / 2 + 2) || 0, Math.abs(vy) / (spot.h / 2 + 2) || 0, 1e-6);
    return { x: c.x + vx * scale, y: c.y + vy * scale };
  };
  const start = edge(a, { x: cx, y: cy }, from);
  const end = edge(b, { x: cx, y: cy }, to);
  return { d: `M${start.x},${start.y} Q${cx},${cy} ${end.x},${end.y}`, mx: 0.25 * start.x + 0.5 * cx + 0.25 * end.x, my: 0.25 * start.y + 0.5 * cy + 0.25 * end.y };
}
