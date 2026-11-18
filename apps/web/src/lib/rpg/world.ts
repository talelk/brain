/**
 * The village of the Live screen, as a pure simulation: where each workspace stands on the map, which tiles can be walked, the paths
 * between them, and the characters (an attempt running now is a hero; an agent that acted lately wanders its yard). Nothing here draws
 * or reads the clock: the screen passes the time and a seeded random source, so the same answers always give the same village.
 */

export const TILE = 16;
export const LOT_W = 14;
export const LOT_H = 11;
export const ROAD = 2;

export type Ground = "grass" | "road" | "stone" | "path";
export type Dir = 0 | 1 | 2 | 3; // down, left, right, up

export interface Lot {
  readonly slug: string | null; // null: the plaza
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly platform: boolean;
  /** The building's footprint in tiles, and the tile in front of its door. */
  readonly building: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly door: { readonly x: number; readonly y: number };
}

export interface Prop { readonly kind: "tree" | "bush" | "rock" | "flowers" | "lamp" | "fountain" | "board" | "bench" | "well" | "pond" | "stump"; readonly x: number; readonly y: number; readonly seed: number }

export interface Layout {
  readonly w: number;
  readonly h: number;
  readonly ground: readonly Ground[];
  readonly walk: Uint8Array;
  readonly lots: readonly Lot[];
  readonly plaza: Lot;
  readonly props: readonly Prop[];
  readonly fences: ReadonlyArray<{ readonly x: number; readonly y: number; readonly side: "h" | "v" }>;
  /** Where a hero appears and leaves: in front of the notice board. */
  readonly spawn: { readonly x: number; readonly y: number };
}

/** A small deterministic random source (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hashOf = (text: string): number => [...text].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) >>> 0, 2166136261);

/**
 * The map for these workspaces: lots in a grid between roads, the plaza in the middle slot, a cottage per workspace (a castle for a
 * platform workspace), a fenced yard with a gap where the path leads to the road, and the slots left over as woods or a pond.
 */
export function layout(places: ReadonlyArray<{ slug: string; platform: boolean }>): Layout {
  const slots = places.length + 1;
  const cols = Math.max(2, Math.ceil(Math.sqrt(slots * 1.4)));
  const rows = Math.max(1, Math.ceil(slots / cols));
  const w = cols * LOT_W + (cols + 1) * ROAD;
  const h = rows * LOT_H + (rows + 1) * ROAD;
  const ground: Ground[] = Array.from({ length: w * h }, () => "road");
  const walk = new Uint8Array(w * h).fill(1);
  const at = (x: number, y: number): number => y * w + x;
  const block = (x: number, y: number): void => { if (x >= 0 && y >= 0 && x < w && y < h) walk[at(x, y)] = 0; };
  const plazaIndex = Math.floor((rows - 1) / 2) * cols + Math.floor((cols - 1) / 2);
  const lots: Lot[] = [];
  const props: Prop[] = [];
  const fences: Array<{ x: number; y: number; side: "h" | "v" }> = [];
  let next = 0;
  for (let index = 0; index < rows * cols; index += 1) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = ROAD + col * (LOT_W + ROAD);
    const y = ROAD + row * (LOT_H + ROAD);
    const place = index === plazaIndex ? null : places[next];
    if (index !== plazaIndex && place) next += 1;
    const random = seeded(hashOf(place?.slug ?? `slot${index}`));
    if (index === plazaIndex) {
      for (let dy = 0; dy < LOT_H; dy += 1) for (let dx = 0; dx < LOT_W; dx += 1) ground[at(x + dx, y + dy)] = "stone";
      const cx = x + Math.floor(LOT_W / 2) - 1;
      props.push({ kind: "fountain", x: cx - 1, y: y + 3, seed: 1 });
      for (let dy = 0; dy < 3; dy += 1) for (let dx = 0; dx < 4; dx += 1) block(cx - 1 + dx, y + 3 + dy);
      props.push({ kind: "board", x: x + 2, y: y + 1, seed: 2 });
      block(x + 2, y + 1); block(x + 3, y + 1);
      for (const [dx, dy] of [[0, 0], [LOT_W - 1, 0], [0, LOT_H - 1], [LOT_W - 1, LOT_H - 1]] as const) { props.push({ kind: "lamp", x: x + dx, y: y + dy, seed: dx + dy }); block(x + dx, y + dy); }
      props.push({ kind: "bench", x: x + LOT_W - 4, y: y + 1, seed: 3 }); block(x + LOT_W - 4, y + 1); block(x + LOT_W - 3, y + 1);
      props.push({ kind: "well", x: x + LOT_W - 3, y: y + LOT_H - 4, seed: 4 }); block(x + LOT_W - 3, y + LOT_H - 4); block(x + LOT_W - 2, y + LOT_H - 4);
      const plaza: Lot = { slug: null, col, row, x, y, platform: false, building: { x: cx - 1, y: y + 3, w: 4, h: 3 }, door: { x: x + 3, y: y + 2 } };
      lots.push(plaza);
      continue;
    }
    for (let dy = 0; dy < LOT_H; dy += 1) for (let dx = 0; dx < LOT_W; dx += 1) ground[at(x + dx, y + dy)] = "grass";
    if (!place) {
      // A slot with no workspace: woods, or a pond with reeds.
      if (random() < 0.5) {
        props.push({ kind: "pond", x: x + 3, y: y + 3, seed: index });
        for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 7; dx += 1) block(x + 3 + dx, y + 3 + dy);
      }
      for (let n = 0; n < 9; n += 1) {
        const tx = x + 1 + Math.floor(random() * (LOT_W - 2));
        const ty = y + 1 + Math.floor(random() * (LOT_H - 3));
        if (walk[at(tx, ty)] === 0 || walk[at(tx, ty + 1)] === 0) continue;
        props.push({ kind: random() < 0.75 ? "tree" : "rock", x: tx, y: ty, seed: Math.floor(random() * 1e6) }); block(tx, ty + 1);
      }
      continue;
    }
    const castle = place.platform;
    const bw = castle ? 9 : 7;
    const bh = castle ? 6 : 5;
    const bx = x + Math.floor((LOT_W - bw) / 2);
    const by = y + 1;
    for (let dy = 0; dy < bh; dy += 1) for (let dx = 0; dx < bw; dx += 1) block(bx + dx, by + dy);
    const door = { x: bx + Math.floor(bw / 2), y: by + bh };
    // The path from the door down to the road, two tiles wide.
    for (let ty = door.y; ty < y + LOT_H; ty += 1) { ground[at(door.x, ty)] = "path"; ground[at(door.x - 1, ty)] = "path"; }
    // A fence around the yard, with the gap where the path leaves.
    for (let dx = 0; dx < LOT_W; dx += 1) {
      const tx = x + dx;
      if (tx !== door.x && tx !== door.x - 1) { fences.push({ x: tx, y: y + LOT_H - 1, side: "h" }); block(tx, y + LOT_H - 1); }
    }
    for (let dx = 1; dx < LOT_W - 1; dx += 1) { fences.push({ x: x + dx, y, side: "h" }); block(x + dx, y); }
    for (let dy = 0; dy < LOT_H - 1; dy += 1) { fences.push({ x, y: y + dy, side: "v" }); fences.push({ x: x + LOT_W - 1, y: y + dy, side: "v" }); block(x, y + dy); block(x + LOT_W - 1, y + dy); }
    // Trees behind and beside the house, flowers and a bush in the yard.
    for (const [dx, dy] of [[1, 1], [LOT_W - 3, 1], [1, 5], [LOT_W - 3, 5]] as const) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx >= bx - 1 && tx <= bx + bw) continue;
      props.push({ kind: random() < 0.8 ? "tree" : "stump", x: tx, y: ty, seed: Math.floor(random() * 1e6) }); block(tx, ty + 1); block(tx + 1, ty + 1);
    }
    for (let n = 0; n < 3; n += 1) {
      const tx = x + 2 + Math.floor(random() * (LOT_W - 4));
      const ty = y + bh + 2 + Math.floor(random() * 2);
      if (ground[at(tx, ty)] === "grass" && walk[at(tx, ty)] === 1) props.push({ kind: n === 0 ? "bush" : "flowers", x: tx, y: ty, seed: Math.floor(random() * 1e6) });
      if (n === 0 && ground[at(tx, ty)] === "grass") block(tx, ty);
    }
    lots.push({ slug: place.slug, col, row, x, y, platform: castle, building: { x: bx, y: by, w: bw, h: bh }, door });
  }
  // Lamps at the crossings of the roads.
  for (let row = 0; row <= rows; row += 2) for (let col = 0; col <= cols; col += 2) props.push({ kind: "lamp", x: col * (LOT_W + ROAD), y: row * (LOT_H + ROAD), seed: row * 31 + col });
  const plaza = lots.find((lot) => lot.slug === null) as Lot;
  return { w, h, ground, walk, lots, plaza, props, fences, spawn: { x: plaza.x + 3, y: plaza.y + 2 } };
}

/** The shortest walk between two tiles, as the tiles to step on (the start excluded); empty when there is none. */
export function path(map: Pick<Layout, "w" | "h" | "walk">, from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  const tx = Math.round(to.x);
  const ty = Math.round(to.y);
  if (sx === tx && sy === ty) return [];
  const size = map.w * map.h;
  if ([sx, tx].some((x) => x < 0 || x >= map.w) || [sy, ty].some((y) => y < 0 || y >= map.h)) return [];
  const back = new Int32Array(size).fill(-1);
  const start = sy * map.w + sx;
  const goal = ty * map.w + tx;
  if (start < 0 || start >= size || goal < 0 || goal >= size) return [];
  back[start] = start;
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cell = queue[head++] as number;
    if (cell === goal) break;
    const cx = cell % map.w;
    const cy = (cell - cx) / map.w;
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const n = ny * map.w + nx;
      if (back[n] !== -1 || (map.walk[n] === 0 && n !== goal)) continue;
      back[n] = cell;
      queue[tail++] = n;
    }
  }
  if (back[goal] === -1) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (let cell = goal; cell !== start; cell = back[cell] as number) out.push({ x: cell % map.w, y: Math.floor(cell / map.w) });
  return out.reverse();
}

export type Mode = "arrive" | "work" | "done" | "failed" | "leave" | "wander" | "handoff";
export type Emote = "!" | "ok" | "no" | "note" | "zz" | "dots" | "heart" | "?" | "scroll";
export interface Hero {
  readonly id: string;
  readonly agent: string;
  readonly kind: string;
  readonly slug: string;
  /** The goal the attempt works for: a hero that finishes carries its scroll to the next one on the same goal. */
  readonly rootId: string;
  /** Who a hero walks to with the scroll. */
  partner: string | null;
  /** Distinguishes parallel attempts of one agent: the colour of the cape. */
  readonly variant: number;
  x: number;
  y: number;
  dir: Dir;
  mode: Mode;
  route: Array<{ x: number; y: number }>;
  /** Distance walked, for the step of the legs. */
  walked: number;
  /** When the current pause, emote or exit ends. */
  until: number;
  emote: { kind: Emote; until: number } | null;
  hop: number;
  gone: boolean;
}

export interface Roster {
  readonly runs: ReadonlyArray<{ id: string; agent: string; kind: string; slug: string; rootId: string }>;
  /** Attempts that just ended, and how. */
  readonly leaving: ReadonlyArray<{ id: string; state: string }>;
  /** Agents that acted lately and work nowhere now, by workspace. */
  readonly idle: ReadonlyArray<{ slug: string; agent: string }>;
}

const SPEED = 3.2; // tiles a second

/** Where the n-th hero of a workspace works: in front of the door, spread left and right. */
export function workSpot(lot: Lot, n: number): { x: number; y: number } {
  const row = Math.floor(n / 5);
  const k = n % 5;
  const side = k % 2 === 0 ? 1 : -1;
  const step = Math.ceil(k / 2);
  // Five to a row, rows going down the path; never outside the fenced yard.
  return { x: Math.min(lot.x + LOT_W - 2, Math.max(lot.x + 1, lot.door.x - 0.5 + side * step * 1.4)), y: Math.min(lot.y + LOT_H - 2, lot.door.y + 1 + row) };
}

const variantOf = (id: string): number => hashOf(id) % 6;

/**
 * Makes the characters match the answers: a new attempt appears (at its door on the first read, at the plaza and walking otherwise),
 * one that ended plays how it ended and walks back to the plaza, and the agents that acted lately wander in their yard. Positions of
 * the characters that stay are never reset.
 */
export function reconcile(heroes: Map<string, Hero>, map: Layout, roster: Roster, now: number, first: boolean, random: () => number): void {
  const lotOf = new Map(map.lots.filter((lot) => lot.slug !== null).map((lot) => [lot.slug as string, lot]));
  const running = new Set(roster.runs.map((run) => run.id));
  const count = new Map<string, number>();
  for (const run of roster.runs) {
    const lot = lotOf.get(run.slug);
    if (!lot) continue;
    const n = count.get(run.slug) ?? 0;
    count.set(run.slug, n + 1);
    const spot = workSpot(lot, n);
    const hero = heroes.get(run.id);
    if (hero) {
      if (hero.mode === "work" && (Math.abs(hero.x - spot.x) > 0.01 || Math.abs(hero.y - spot.y) > 0.01) && hero.route.length === 0) hero.route = [...path(map, hero, spot), spot];
      continue;
    }
    const start = first ? spot : map.spawn;
    heroes.set(run.id, { id: run.id, agent: run.agent, kind: run.kind, slug: run.slug, rootId: run.rootId, partner: null, variant: variantOf(run.id), x: start.x, y: start.y, dir: 0, mode: first ? "work" : "arrive", route: first ? [] : [...path(map, start, spot), spot], walked: 0, until: 0, emote: null, hop: 0, gone: false });
  }
  // The Governor's word on how a task ended can arrive after the run left: a hero that played "done" corrects itself, and the other way round.
  for (const hero of heroes.values()) {
    if (first || running.has(hero.id) || hero.partner !== null) continue;
    const ended = roster.leaving.find((entry) => entry.id === hero.id)?.state;
    if (hero.mode === "done" && (ended === "failed" || ended === "stopped")) { hero.mode = "failed"; hero.until = now + 1800; hero.emote = { kind: "no", until: now + 2600 }; }
    else if (hero.mode === "failed" && ended === "done") { hero.mode = "done"; hero.until = now + 4000; hero.emote = { kind: "ok", until: now + 2600 }; }
  }
  for (const hero of heroes.values()) {
    if (hero.mode === "wander" || running.has(hero.id) || hero.mode === "done" || hero.mode === "failed" || hero.mode === "leave" || hero.mode === "handoff") continue;
    const ended = roster.leaving.find((entry) => entry.id === hero.id)?.state;
    hero.route = [];
    // Under reduced motion nothing walks or plays out: a run that ended is simply gone.
    if (first) { heroes.delete(hero.id); continue; }
    if (ended === "done") { hero.mode = "done"; hero.until = now + 4000; hero.emote = { kind: "ok", until: now + 2600 }; }
    else if (ended === "failed" || ended === "stopped") { hero.mode = "failed"; hero.until = now + 1800; hero.emote = { kind: "no", until: now + 2600 }; }
    else { hero.mode = "leave"; hero.route = path(map, hero, map.spawn); }
  }
  // A hero that just finished walks its scroll to the next hero of the same goal, in whatever house that one works.
  for (const hero of heroes.values()) {
    if (hero.mode !== "done" || hero.partner !== null || hero.rootId === "") continue;
    const next = [...heroes.values()].find((other) => other.id !== hero.id && other.rootId === hero.rootId && running.has(other.id));
    if (!next) continue;
    const lot = lotOf.get(next.slug);
    const spot = lot ? workSpot(lot, (count.get(next.slug) ?? 0) + 1) : { x: next.x + 1, y: next.y };
    hero.partner = next.id;
    hero.mode = "handoff";
    hero.route = [...path(map, hero, spot), spot];
  }
  // Wanderers: one per agent that acted lately in a workspace and runs nowhere now.
  const busy = new Set(roster.runs.map((run) => `${run.slug}|${run.agent}`));
  const wanted = new Set(roster.idle.filter((entry) => !busy.has(`${entry.slug}|${entry.agent}`) && lotOf.has(entry.slug)).map((entry) => `w:${entry.slug}:${entry.agent}`));
  for (const entry of roster.idle) {
    const id = `w:${entry.slug}:${entry.agent}`;
    const lot = lotOf.get(entry.slug);
    if (!wanted.has(id) || heroes.has(id) || !lot) continue;
    const spot = yardTile(map, lot, random);
    heroes.set(id, { id, agent: entry.agent, kind: "work", slug: entry.slug, rootId: "", partner: null, variant: variantOf(entry.agent), x: spot.x, y: spot.y, dir: 0, mode: "wander", route: [], walked: 0, until: now + 1000 + random() * 3000, emote: null, hop: 0, gone: false });
  }
  for (const hero of heroes.values()) if (hero.mode === "wander" && !wanted.has(hero.id)) hero.gone = true;
  for (const [id, hero] of heroes) if (hero.gone) heroes.delete(id);
}

function yardTile(map: Layout, lot: Lot, random: () => number): { x: number; y: number } {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const x = lot.x + 1 + Math.floor(random() * (LOT_W - 2));
    const y = lot.building.y + lot.building.h + 1 + Math.floor(random() * Math.max(1, lot.y + LOT_H - 2 - (lot.building.y + lot.building.h)));
    const nearDoor = Math.abs(x - lot.door.x) < 3 && y <= lot.door.y + 2;
    if (map.walk[y * map.w + x] === 1 && !nearDoor) return { x, y };
  }
  return { x: lot.door.x, y: lot.door.y + 1 };
}

const EMOTES: readonly Emote[] = ["note", "zz", "dots", "heart", "?"];

/** Moves everyone by `dt` milliseconds: walking along the route, pausing and wandering, playing an ending and leaving. */
export function step(heroes: Map<string, Hero>, map: Layout, dt: number, now: number, random: () => number): void {
  const lotOf = new Map(map.lots.filter((lot) => lot.slug !== null).map((lot) => [lot.slug as string, lot]));
  for (const hero of heroes.values()) {
    if (hero.emote && hero.emote.until < now) hero.emote = null;
    hero.hop = hero.mode === "done" && hero.until > now ? Math.abs(Math.sin((hero.until - now) / 140)) * 0.35 : 0;
    if ((hero.mode === "done" || hero.mode === "failed") && hero.until <= now && hero.route.length === 0) {
      hero.mode = "leave";
      hero.route = path(map, hero, map.spawn);
    }
    if (hero.mode === "wander" && hero.route.length === 0 && hero.until <= now) {
      const lot = lotOf.get(hero.slug);
      if (lot) {
        if (random() < 0.3) hero.emote = { kind: EMOTES[Math.floor(random() * EMOTES.length)] as Emote, until: now + 2200 };
        else hero.route = path(map, hero, yardTile(map, lot, random));
      }
      hero.until = now + 2000 + random() * 4000;
    }
    const target = hero.route[0];
    // Already at the way out (or no way found): leaving is over.
    if (!target && hero.mode === "leave") hero.gone = true;
    if (target) {
      const speed = SPEED * (hero.mode === "failed" || hero.mode === "leave" ? 0.75 : hero.mode === "wander" ? 0.55 : hero.mode === "handoff" ? 1.25 : 1);
      const dx = target.x - hero.x;
      const dy = target.y - hero.y;
      const distance = Math.hypot(dx, dy);
      const move = (speed * dt) / 1000;
      if (Math.abs(dx) > Math.abs(dy)) hero.dir = dx > 0 ? 2 : 1;
      else if (dy !== 0) hero.dir = dy > 0 ? 0 : 3;
      if (distance <= move) { hero.x = target.x; hero.y = target.y; hero.route.shift(); hero.walked += distance; }
      else { hero.x += (dx / distance) * move; hero.y += (dy / distance) * move; hero.walked += move; }
      if (hero.route.length === 0) {
        if (hero.mode === "arrive") { hero.mode = "work"; hero.dir = 0; }
        if (hero.mode === "work") hero.dir = 0;
        if (hero.mode === "leave") hero.gone = true;
        if (hero.mode === "handoff") {
          const partner = hero.partner ? heroes.get(hero.partner) : undefined;
          hero.emote = { kind: "scroll", until: now + 1800 };
          if (partner) { partner.emote = { kind: "heart", until: now + 1800 }; hero.dir = partner.x < hero.x ? 1 : 2; }
          hero.mode = "done";
          hero.until = now + 1600;
        }
      }
    }
  }
  for (const [id, hero] of heroes) if (hero.gone) heroes.delete(id);
}

/** Whether a character is walking now (its legs move). */
export const walking = (hero: Hero): boolean => hero.route.length > 0;
