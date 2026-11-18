import { hashOf, seeded, TILE, type Dir, type Emote, type Ground, type Layout, type Prop } from "./world";

/**
 * The pixel art of the village, painted in code: characters (four directions, standing, two steps and two working poses, six classes,
 * hair, skin and a cape that tells parallel attempts apart), cottages and castles, trees, the plaza and the ground. Each picture is
 * painted once into a small canvas and drawn scaled with smoothing off.
 */

type Ctx = CanvasRenderingContext2D;
const canvas = (w: number, h: number): HTMLCanvasElement => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const ctxOf = (c: HTMLCanvasElement): Ctx => c.getContext("2d") as Ctx;

/** Mixes two colours, `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const p = (hex: string, i: number): number => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
const dark = (c: string, t = 0.25): string => mix(c, "#1b1630", t);
const light = (c: string, t = 0.25): string => mix(c, "#ffffff", t);
const OUTLINE = "#1b1630";

/** Draws a dark outline around everything already painted in a frame. */
function outline(ctx: Ctx, x0: number, y0: number, w: number, h: number): void {
  const image = ctx.getImageData(x0, y0, w, h);
  const data = image.data;
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && (data[(y * w + x) * 4 + 3] ?? 0) > 0;
  const marks: number[] = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) marks.push(x, y);
  ctx.fillStyle = OUTLINE;
  for (let i = 0; i < marks.length; i += 2) ctx.fillRect(x0 + (marks[i] as number), y0 + (marks[i + 1] as number), 1, 1);
}

// ——— Characters ———

export type Class = "knight" | "mage" | "cleric" | "scribe" | "builder" | "ranger";
/** An agent's class, read from its name: who checks is a knight, who plans a mage, who heals a cleric, who writes down a scribe, who watches a ranger. */
export const classOf = (agent: string): Class =>
  /check|review|verif|test|audit|guard|secur/iu.test(agent) ? "knight"
    : /plan|architect|analy|research|design|think/iu.test(agent) ? "mage"
      : /heal|fix|repair|sre|operator|support|doctor|care/iu.test(agent) ? "cleric"
        : /capital|sync|librar|memory|doc|writ|scribe|summar|report/iu.test(agent) ? "scribe"
          : /monitor|watch|scout|search|find|explor|crawl/iu.test(agent) ? "ranger" : "builder";

export const CW = 16;
export const CH = 24;
export const FRAMES = 5; // stand, step A, step B, work 1, work 2
const SKINS = ["#f4cfa8", "#e6b48a", "#c98d62", "#9a6440", "#6e4630"] as const;
const HAIRS = ["#3b2a20", "#7a4a26", "#c9883a", "#e8d27a", "#2b3550", "#9b3b3b", "#d9d4e6"] as const;
const TUNICS = ["#3f7fd1", "#c0453b", "#2e9a6a", "#8e5bd1", "#d68f1a", "#1f9fb4", "#5a6fd6", "#b8478a"] as const;
export const CAPES = ["#c0392b", "#2e86c1", "#27ae60", "#8e44ad", "#e67e22", "#16a085"] as const;
type Hair = "short" | "long" | "spiky" | "bun" | "bald";
const HAIR_STYLES: readonly Hair[] = ["short", "long", "spiky", "bun", "bald"];

interface Look { skin: string; hair: string; hairStyle: Hair; tunic: string; pants: string; boots: string; cape: string; accent: string; kind: Class }
const pick = <T,>(list: readonly T[], seed: number, salt: number): T => list[(seed + salt * 7919) % list.length] as T;

export function lookOf(agent: string, variant: number): Look {
  const seed = hashOf(agent);
  const kind = classOf(agent);
  return {
    skin: pick(SKINS, seed, 1), hair: pick(HAIRS, seed, 2), hairStyle: pick(HAIR_STYLES, seed, 3), tunic: pick(TUNICS, seed, 4),
    pants: pick(["#3a3f58", "#4a3a2a", "#2f4a3a", "#3d2f4f"], seed, 5), boots: pick(["#5a3b24", "#3b2a20", "#2b2b38"], seed, 6),
    cape: CAPES[variant % CAPES.length] as string, accent: pick(["#c0392b", "#2e86c1", "#d4ac0d", "#8e44ad", "#16a085"], seed, 7), kind,
  };
}

type P = (x: number, y: number, c: string) => void;
type R = (x: number, y: number, w: number, h: number, c: string) => void;
const STEEL = "#b9c0cf";
const WOOD = "#8a5a34";
const GOLD = "#f2c14e";

/** One frame of a character facing down, left or up (right is left mirrored). */
function figure(p: P, r: R, look: Look, dir: 0 | 1 | 3, frame: number): void {
  const { kind } = look;
  const robe = kind === "mage" || kind === "cleric";
  const body = kind === "cleric" ? "#efe9dc" : kind === "mage" ? look.tunic : kind === "ranger" ? "#3f6e3a" : look.tunic;
  const lift = frame === 1 || frame === 2 ? -1 : 0;
  const act = frame === 3 || frame === 4;
  const metal = (x: number, y: number, w: number, h: number): void => { r(x, y, w, h, STEEL); r(x, y + h - 1, w, 1, dark(STEEL, 0.3)); r(x, y, w, 1, light(STEEL, 0.4)); };

  if (dir === 0) {
    // Cape hem behind the legs.
    if (kind !== "cleric") r(3, 11 + lift, 10, 9, dark(look.cape, 0.15));
    // Legs and boots.
    const leg = (x: number, up: boolean): void => { const y = up ? 16 : 17; r(x, y, 3, 4, look.pants); r(x + 2, y, 1, 4, dark(look.pants)); r(x, y + 4, 3, 3, look.boots); r(x, y + 6, 3, 1, dark(look.boots)); };
    if (!robe) { leg(5, frame === 1); leg(8, frame === 2); }
    else { r(5, 21, 3, 2, look.boots); r(8, 21, 3, 2, look.boots); }
    const y = lift;
    // Torso.
    const torsoH = robe ? 12 : 7;
    r(4, 10 + y, 8, torsoH, body); r(11, 10 + y, 1, torsoH, dark(body)); r(4, 10 + y, 1, torsoH, light(body, 0.15));
    if (robe) { r(4, 21 + y, 8, 1, kind === "cleric" ? GOLD : dark(body, 0.35)); r(7, 10 + y, 2, 11, kind === "cleric" ? light(body, 0.1) : dark(body, 0.12)); }
    else { r(4, 15 + y, 8, 1, "#4a2f1c"); r(7, 15 + y, 2, 1, GOLD); r(7, 10 + y, 2, 1, look.skin); }
    if (kind === "cleric") { r(7, 11 + y, 2, 5, look.accent); r(6, 12 + y, 4, 2, look.accent); }
    if (kind === "builder") { r(5, 12 + y, 6, 6, "#8b5a2b"); r(5, 12 + y, 6, 1, dark("#8b5a2b")); r(6, 14 + y, 2, 2, dark("#8b5a2b", 0.15)); }
    if (kind === "ranger") { r(4, 10 + y, 8, 2, dark(body, 0.2)); r(9, 11 + y, 1, 5, "#6b4426"); }
    // Arms: down at the sides, or raised while working.
    const sleeve = dark(body, 0.12);
    if (!act) { r(3, 10 + y, 1, 6, sleeve); r(12, 10 + y, 1, 6, sleeve); p(3, 16 + y, look.skin); p(12, 16 + y, look.skin); }
    else { const up = frame === 3 ? 0 : 2; r(2, 8 + y + up, 2, 4, sleeve); r(12, 8 + y + up, 2, 4, sleeve); r(2, 7 + y + up, 2, 1, look.skin); r(12, 7 + y + up, 2, 1, look.skin); }
    // Head.
    r(4, 2 + y, 8, 8, look.skin); r(11, 3 + y, 1, 7, dark(look.skin, 0.12)); p(4, 9 + y, "#00000000"); p(11, 9 + y, "#00000000");
    r(6, 6 + y, 1, 2, "#2a2340"); r(9, 6 + y, 1, 2, "#2a2340"); p(6, 6 + y, "#ffffff"); p(9, 6 + y, "#ffffff");
    p(5, 8 + y, mix(look.skin, "#e86a6a", 0.35)); p(10, 8 + y, mix(look.skin, "#e86a6a", 0.35)); r(7, 8 + y, 2, 1, dark(look.skin, 0.3));
    hairDown(p, r, look, y);
    gearDown(p, r, look, y, frame, metal);
  } else if (dir === 3) {
    const leg = (x: number, up: boolean): void => { const y = up ? 16 : 17; r(x, y, 3, 4, look.pants); r(x, y + 4, 3, 3, look.boots); };
    if (!robe) { leg(5, frame === 1); leg(8, frame === 2); } else { r(5, 21, 3, 2, look.boots); r(8, 21, 3, 2, look.boots); }
    const y = lift;
    r(4, 10 + y, 8, robe ? 12 : 7, body);
    if (kind !== "cleric") { r(4, 10 + y, 8, robe ? 11 : 9, look.cape); r(11, 10 + y, 1, robe ? 11 : 9, dark(look.cape)); r(4, 10 + y, 8, 1, dark(look.cape, 0.2)); }
    const sleeve = dark(body, 0.12);
    if (!act) { r(3, 10 + y, 1, 6, sleeve); r(12, 10 + y, 1, 6, sleeve); p(3, 16 + y, look.skin); p(12, 16 + y, look.skin); }
    else { r(2, 7 + y, 2, 4, sleeve); r(12, 7 + y, 2, 4, sleeve); }
    r(4, 2 + y, 8, 8, look.skin);
    if (kind === "knight") metal(3, 1 + y, 10, 8);
    else if (kind === "mage") { r(4, 1 + y, 8, 8, look.hair); mageHat(r, look, y); }
    else if (kind === "cleric" || kind === "ranger") { const hood = kind === "cleric" ? "#f6f2e8" : "#3f6e3a"; r(3, 1 + y, 10, 9, hood); r(11, 2 + y, 2, 8, dark(hood, 0.15)); }
    else { r(4, 1 + y, 8, 8, look.hair); r(4, 1 + y, 8, 1, light(look.hair)); if (look.hairStyle === "long") r(4, 8 + y, 8, 3, look.hair); if (look.hairStyle === "bun") r(6, 0 + y, 4, 2, dark(look.hair)); if (kind === "scribe") { r(3, 1 + y, 10, 2, look.accent); p(12, 0 + y, GOLD); } if (kind === "builder") { r(4, 1 + y, 8, 2, look.accent); } }
    if (kind === "ranger") { r(10, 9 + y, 3, 7, "#6b4426"); r(10, 8 + y, 1, 2, "#e8e2d0"); r(12, 8 + y, 1, 2, "#e8e2d0"); }
    if (kind === "knight") { r(13, 6 + y, 1, 10, light(STEEL, 0.3)); }
    if (kind === "mage" || kind === "cleric") staff(r, look, 14, y, act);
  } else {
    // Facing left: one side of the face, one arm in front, legs apart while stepping.
    const y = lift;
    if (!robe) {
      if (frame === 1 || frame === 2) {
        const front = frame === 1 ? look.pants : dark(look.pants, 0.2);
        const back = frame === 1 ? dark(look.pants, 0.2) : look.pants;
        r(8, 17, 3, 4, back); r(9, 21, 3, 2, dark(look.boots, 0.2));
        r(4, 17, 3, 4, front); r(3, 21, 3, 2, look.boots);
      } else { r(6, 17, 4, 4, look.pants); r(5, 21, 5, 2, look.boots); }
    } else { r(5, 21, 6, 2, look.boots); }
    if (kind !== "cleric") r(9, 10 + y, 3, robe ? 11 : 9, look.cape);
    r(5, 10 + y, 6, robe ? 12 : 7, body); r(10, 10 + y, 1, robe ? 12 : 7, dark(body));
    if (!robe) { r(5, 15 + y, 6, 1, "#4a2f1c"); }
    if (kind === "builder") r(5, 12 + y, 3, 6, "#8b5a2b");
    r(4, 2 + y, 7, 8, look.skin); p(3, 6 + y, look.skin); r(5, 6 + y, 1, 2, "#2a2340"); p(5, 6 + y, "#ffffff"); p(5, 8 + y, mix(look.skin, "#e86a6a", 0.35));
    hairSide(p, r, look, y);
    const sleeve = dark(body, 0.18);
    if (!act) { r(7, 11 + y, 2, 5, sleeve); r(7, 16 + y, 2, 1, look.skin); }
    else { r(4, 9 + y + (frame === 4 ? 2 : 0), 4, 2, sleeve); r(2, 9 + y + (frame === 4 ? 2 : 0), 2, 2, look.skin); }
    gearSide(p, r, look, y, frame, metal);
  }
}

function hairDown(p: P, r: R, look: Look, y: number): void {
  const { kind, hair } = look;
  if (kind === "knight") return;
  if (kind === "mage") { if (look.hairStyle === "bald" || look.hairStyle === "long") { r(5, 8 + y, 6, 3, "#e8e4f0"); r(7, 11 + y, 2, 2, "#e8e4f0"); } r(3, 4 + y, 1, 4, hair); r(12, 4 + y, 1, 4, hair); mageHat(r, look, y); return; }
  if (kind === "cleric" || kind === "ranger") {
    const hood = kind === "cleric" ? "#f6f2e8" : "#3f6e3a";
    r(3, 1 + y, 10, 4, hood); r(3, 1 + y, 2, 9, hood); r(11, 1 + y, 2, 9, dark(hood, 0.12)); r(5, 4 + y, 6, 1, hair); r(4, 1 + y, 8, 1, light(hood, 0.3));
    if (kind === "ranger") { r(7, 0 + y, 2, 1, hood); }
    return;
  }
  const s = look.hairStyle;
  if (s !== "bald") { r(4, 1 + y, 8, 3, hair); r(5, 1 + y, 4, 1, light(hair, 0.3)); p(4, 4 + y, hair); p(11, 4 + y, hair); p(4, 5 + y, hair); p(11, 5 + y, hair); }
  if (s === "long") { r(3, 3 + y, 1, 8, hair); r(12, 3 + y, 1, 8, dark(hair)); }
  if (s === "spiky") { p(5, 0 + y, hair); p(7, 0 + y, hair); p(9, 0 + y, hair); p(11, 1 + y, hair); }
  if (s === "bun") r(6, 0 + y, 4, 1, dark(hair));
  if (s === "bald") { p(4, 4 + y, hair); p(11, 4 + y, hair); r(5, 8 + y, 6, 2, hair); r(7, 8 + y, 2, 1, dark(look.skin, 0.3)); }
  if (kind === "scribe") { r(3, 1 + y, 10, 2, look.accent); r(3, 3 + y, 10, 1, dark(look.accent)); p(12, 0 + y, GOLD); p(13, 0 + y, light(GOLD)); }
  if (kind === "builder") { r(4, 1 + y, 8, 2, look.accent); r(3, 3 + y, 10, 1, dark(look.accent)); p(9, 1 + y, light(look.accent)); }
}

function mageHat(r: R, look: Look, y: number): void {
  const hat = dark(look.tunic, 0.15);
  r(2, 3 + y, 12, 1, dark(hat, 0.2)); r(4, 2 + y, 8, 1, hat); r(5, 1 + y, 6, 1, hat); r(6, 0 + y, 4, 1, hat); r(9, 0 + y, 2, 1, hat);
  r(7, 1 + y, 1, 1, GOLD); r(4, 2 + y, 2, 1, light(hat, 0.15));
}

function staff(r: R, look: Look, x: number, y: number, act: boolean): void {
  const top = act ? 0 : 3;
  r(x, top + 3 + y, 1, 20 - top, WOOD);
  if (look.kind === "mage") { r(x - 1, top + y, 3, 3, "#7dd3fc"); r(x - 1, top + y, 1, 1, "#e0f7ff"); }
  else { r(x - 1, top + 1 + y, 3, 1, GOLD); r(x, top + y, 1, 3, GOLD); }
}

function gearDown(p: P, r: R, look: Look, y: number, frame: number, metal: (x: number, y: number, w: number, h: number) => void): void {
  const act = frame === 3 || frame === 4;
  const raise = frame === 3 ? 0 : 2;
  switch (look.kind) {
    case "knight": {
      metal(3, 1 + y, 10, 4); r(3, 5 + y, 1, 5, STEEL); r(12, 5 + y, 1, 5, dark(STEEL, 0.2)); r(7, 0 + y, 2, 1, look.accent); r(6, 0 + y, 1, 1, look.accent);
      r(3, 10 + y, 2, 2, STEEL); r(11, 10 + y, 2, 2, STEEL);
      // Shield on the left arm, sword in the right hand.
      r(0, 11 + y, 4, 6, look.accent); r(0, 11 + y, 4, 1, STEEL); r(0, 16 + y, 4, 1, STEEL); r(1, 13 + y, 2, 2, GOLD);
      if (!act) { r(13, 8 + y, 1, 8, light(STEEL, 0.4)); r(12, 16 + y, 3, 1, GOLD); }
      else { r(13, raise + y, 1, 7, light(STEEL, 0.4)); r(12, 7 + raise + y, 3, 1, GOLD); }
      break;
    }
    case "mage": staff(r, look, 14, y, act); break;
    case "cleric": staff(r, look, 14, y, act); break;
    case "scribe": {
      r(5, 6 + y, 2, 1, "#2a2340"); r(9, 6 + y, 2, 1, "#2a2340"); r(7, 6 + y, 2, 1, "#2a2340");
      if (!act) { r(0, 13 + y, 4, 5, "#9b3b3b"); r(1, 13 + y, 3, 1, "#f4ecd8"); }
      else { r(0, 9 + raise + y, 6, 4, "#f4ecd8"); r(3, 9 + raise + y, 1, 4, "#c9bfa6"); p(13, 6 + raise + y, "#2a2340"); r(13, 4 + raise + y, 1, 2, "#f4ecd8"); }
      break;
    }
    case "builder": {
      if (!act) { r(13, 12 + y, 1, 6, WOOD); r(12, 11 + y, 3, 2, STEEL); }
      else if (frame === 3) { r(13, 2 + y, 1, 6, WOOD); r(12, 1 + y, 3, 2, STEEL); }
      else { r(13, 9 + y, 1, 5, WOOD); r(12, 14 + y, 3, 2, STEEL); }
      break;
    }
    case "ranger": {
      if (!act) { p(1, 9 + y, WOOD); r(0, 10 + y, 1, 8, WOOD); p(1, 18 + y, WOOD); r(2, 10 + y, 1, 8, "#e8e2d0"); }
      else { r(0, 6 + raise + y, 1, 8, WOOD); p(1, 5 + raise + y, WOOD); p(1, 14 + raise + y, WOOD); r(1, 9 + raise + y, 12, 1, "#e8e2d0"); p(13, 9 + raise + y, STEEL); }
      break;
    }
    default: break;
  }
  void p;
}

function hairSide(p: P, r: R, look: Look, y: number): void {
  const { kind, hair } = look;
  if (kind === "knight") { r(4, 1 + y, 7, 4, STEEL); r(8, 5 + y, 3, 5, STEEL); r(4, 1 + y, 7, 1, light(STEEL, 0.4)); r(6, 0 + y, 3, 1, look.accent); return; }
  if (kind === "mage") { r(7, 3 + y, 4, 5, hair); mageHat(r, look, y); return; }
  if (kind === "cleric" || kind === "ranger") { const hood = kind === "cleric" ? "#f6f2e8" : "#3f6e3a"; r(4, 1 + y, 7, 4, hood); r(7, 4 + y, 4, 6, hood); r(10, 2 + y, 1, 8, dark(hood, 0.15)); return; }
  if (look.hairStyle !== "bald") { r(4, 1 + y, 7, 3, hair); r(8, 3 + y, 3, 4, hair); r(5, 1 + y, 3, 1, light(hair, 0.3)); }
  if (look.hairStyle === "long") r(9, 6 + y, 2, 6, dark(hair));
  if (look.hairStyle === "bun") r(10, 1 + y, 2, 2, dark(hair));
  if (look.hairStyle === "spiky") { p(5, 0 + y, hair); p(8, 0 + y, hair); p(11, 2 + y, hair); }
  if (look.hairStyle === "bald") { r(4, 8 + y, 4, 2, hair); r(9, 4 + y, 2, 2, hair); }
  if (kind === "scribe") { r(3, 1 + y, 9, 2, look.accent); p(11, 0 + y, GOLD); r(4, 6 + y, 2, 1, "#2a2340"); }
  if (kind === "builder") { r(3, 1 + y, 8, 2, look.accent); r(2, 3 + y, 4, 1, dark(look.accent)); }
}

function gearSide(p: P, r: R, look: Look, y: number, frame: number, metal: (x: number, y: number, w: number, h: number) => void): void {
  const act = frame === 3 || frame === 4;
  const down = frame === 4 ? 2 : 0;
  switch (look.kind) {
    case "knight": { r(3, 11 + y, 3, 7, look.accent); r(3, 11 + y, 3, 1, STEEL); p(4, 14 + y, GOLD); if (act) { r(0, 3 + down + y, 1, 7, light(STEEL, 0.4)); r(0, 10 + down + y, 2, 1, GOLD); } metal(8, 10 + y, 3, 2); break; }
    case "mage": case "cleric": staff(r, look, act ? 2 : 6, y, act); break;
    case "scribe": if (act) { r(0, 9 + down + y, 4, 3, "#f4ecd8"); } else r(6, 13 + y, 3, 4, "#9b3b3b"); break;
    case "builder": if (act) { r(1, 3 + down * 3 + y, 1, 6, WOOD); r(0, 2 + down * 3 + y, 3, 2, STEEL); } break;
    case "ranger": r(10, 9 + y, 2, 7, "#6b4426"); p(10, 8 + y, "#e8e2d0"); break;
    default: break;
  }
}

const sheets = new Map<string, HTMLCanvasElement>();
/** The sheet of one character: four rows (down, left, right, up) of five frames. */
export function sheetOf(agent: string, variant: number): HTMLCanvasElement {
  const key = `${agent}|${variant}`;
  const cached = sheets.get(key);
  if (cached) return cached;
  const look = lookOf(agent, variant);
  const sheet = canvas(CW * FRAMES, CH * 4);
  const ctx = ctxOf(sheet);
  for (const dir of [0, 1, 3] as const) {
    const row = dir === 3 ? 3 : dir;
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const ox = frame * CW;
      const oy = row * CH;
      const p: P = (x, y, c) => { if (c === "#00000000") ctx.clearRect(ox + x, oy + y, 1, 1); else { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1); } };
      const r: R = (x, y, w, h, c) => { if (x >= CW || y >= CH) return; ctx.fillStyle = c; ctx.fillRect(ox + Math.max(0, x), oy + Math.max(0, y), Math.min(w, CW - x), Math.min(h, CH - y)); };
      figure(p, r, look, dir, frame);
      outline(ctx, ox, oy, CW, CH);
    }
  }
  // Right is left mirrored.
  for (let frame = 0; frame < FRAMES; frame += 1) {
    ctx.save();
    ctx.translate(frame * CW + CW, 2 * CH);
    ctx.scale(-1, 1);
    ctx.drawImage(sheet, frame * CW, CH, CW, CH, 0, 0, CW, CH);
    ctx.restore();
  }
  sheets.set(key, sheet);
  return sheet;
}

/** Where a frame lies on a sheet. */
export const frameAt = (dir: Dir, frame: number): { sx: number; sy: number } => ({ sx: frame * CW, sy: dir * CH });

// ——— Ground and scenery ———

const GRASS = ["#7ec85a", "#76c053", "#86cf62"] as const;
/** The ground and the fences, painted once at one pixel per pixel. */
export function paintGround(map: Layout): HTMLCanvasElement {
  const c = canvas(map.w * TILE, map.h * TILE);
  const ctx = ctxOf(c);
  const random = seeded(7);
  const g = (x: number, y: number): Ground | undefined => (x < 0 || y < 0 || x >= map.w || y >= map.h ? undefined : map.ground[y * map.w + x]);
  for (let ty = 0; ty < map.h; ty += 1) for (let tx = 0; tx < map.w; tx += 1) {
    const kind = g(tx, ty) as Ground;
    const x0 = tx * TILE;
    const y0 = ty * TILE;
    if (kind === "grass") {
      ctx.fillStyle = GRASS[(tx * 7 + ty * 13) % 3] as string; ctx.fillRect(x0, y0, TILE, TILE);
      for (let n = 0; n < 6; n += 1) { ctx.fillStyle = random() < 0.5 ? "#6bb04a" : "#93d870"; ctx.fillRect(x0 + Math.floor(random() * 15), y0 + Math.floor(random() * 15), 1, random() < 0.4 ? 2 : 1); }
      if (random() < 0.12) { ctx.fillStyle = "#5e9f40"; const x = x0 + 3 + Math.floor(random() * 9); const y = y0 + 4 + Math.floor(random() * 8); ctx.fillRect(x, y, 1, 3); ctx.fillRect(x - 1, y + 1, 1, 2); ctx.fillRect(x + 1, y + 1, 1, 2); }
    } else if (kind === "road" || kind === "path") {
      const base = kind === "road" ? "#cfa86c" : "#dcbc84";
      ctx.fillStyle = base; ctx.fillRect(x0, y0, TILE, TILE);
      for (let n = 0; n < 5; n += 1) { ctx.fillStyle = random() < 0.5 ? dark(base, 0.12) : light(base, 0.2); ctx.fillRect(x0 + Math.floor(random() * 15), y0 + Math.floor(random() * 15), random() < 0.3 ? 2 : 1, 1); }
      // A soft grass edge where the road meets the grass.
      ctx.fillStyle = "#6bb04a";
      if (g(tx, ty - 1) === "grass") for (let i = 0; i < TILE; i += 1) if (random() < 0.6) ctx.fillRect(x0 + i, y0, 1, 1 + Math.floor(random() * 2));
      if (g(tx, ty + 1) === "grass") for (let i = 0; i < TILE; i += 1) if (random() < 0.6) ctx.fillRect(x0 + i, y0 + TILE - 1, 1, 1);
      if (g(tx - 1, ty) === "grass") for (let i = 0; i < TILE; i += 1) if (random() < 0.6) ctx.fillRect(x0, y0 + i, 1 + Math.floor(random() * 2), 1);
      if (g(tx + 1, ty) === "grass") for (let i = 0; i < TILE; i += 1) if (random() < 0.6) ctx.fillRect(x0 + TILE - 1, y0 + i, 1, 1);
    } else {
      ctx.fillStyle = "#a9a3b8"; ctx.fillRect(x0, y0, TILE, TILE);
      for (let sy = 0; sy < 4; sy += 1) for (let sx = 0; sx < 2; sx += 1) {
        const shade = ["#bdb7cc", "#b2acc2", "#c6c1d4", "#aaa4bb"][Math.floor(random() * 4)] as string;
        const ox = x0 + sx * 8 + (sy % 2) * 4 - (sy % 2 && sx === 1 ? 8 : 0);
        ctx.fillStyle = shade; ctx.fillRect(Math.max(x0, ox) + 1, y0 + sy * 4 + 1, 6, 3);
        ctx.fillStyle = light(shade, 0.25); ctx.fillRect(Math.max(x0, ox) + 1, y0 + sy * 4 + 1, 6, 1);
      }
    }
  }
  for (const fence of map.fences) {
    const x0 = fence.x * TILE;
    const y0 = fence.y * TILE;
    ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.fillRect(x0 + 2, y0 + 12, 13, 2);
    if (fence.side === "h") {
      ctx.fillStyle = "#9c6b3f"; ctx.fillRect(x0, y0 + 5, TILE, 2); ctx.fillRect(x0, y0 + 9, TILE, 2);
      ctx.fillStyle = "#7a4f2c"; ctx.fillRect(x0 + 1, y0 + 2, 3, 11); ctx.fillStyle = "#b07d4c"; ctx.fillRect(x0 + 1, y0 + 2, 1, 11);
    } else {
      ctx.fillStyle = "#9c6b3f"; ctx.fillRect(x0 + 6, y0, 3, TILE);
      ctx.fillStyle = "#7a4f2c"; ctx.fillRect(x0 + 5, y0 + 1, 5, 4); ctx.fillStyle = "#b07d4c"; ctx.fillRect(x0 + 6, y0, 1, TILE);
    }
  }
  return c;
}

const ROOFS = ["#c0453b", "#2e7fc1", "#8e4fb8", "#d68910", "#2e8a4e", "#17a589", "#b8478a"] as const;
export const roofOf = (name: string): string => ROOFS[hashOf(name) % ROOFS.length] as string;

/** A cottage, `w` tiles wide, its roof two tiles above the footprint. Windows are returned for the lights of the night. */
export function paintCottage(name: string, w: number, h: number, lit: boolean): { image: HTMLCanvasElement; windows: Array<{ x: number; y: number }> } {
  const W = w * TILE;
  const top = 2 * TILE;
  const H = h * TILE + top;
  const c = canvas(W, H);
  const ctx = ctxOf(c);
  const r = (x: number, y: number, ww: number, hh: number, color: string): void => { ctx.fillStyle = color; ctx.fillRect(x, y, ww, hh); };
  const roof = roofOf(name);
  const wallTop = top + 22;
  const wallBottom = H - 10;
  // Walls: plaster between timber, a stone footing.
  r(6, wallTop, W - 12, wallBottom - wallTop, "#efe2c4"); r(W - 18, wallTop, 12, wallBottom - wallTop, "#e0d0ae");
  for (const x of [6, Math.floor(W * 0.3), Math.floor(W * 0.7), W - 10]) r(x, wallTop, 4, wallBottom - wallTop, "#7a4f2c");
  r(6, wallTop + 24, W - 12, 3, "#7a4f2c");
  for (let x = 4; x < W - 4; x += 8) { r(x, wallBottom, 7, 4, "#9a95a8"); r(x + 4, wallBottom + 5, 7, 4, "#8a8598"); r(x, wallBottom, 7, 1, "#b5b0c4"); }
  // Roof: rows of shingles, wider at the eaves, a ridge on top.
  const rows = wallTop + 6;
  for (let y = 4; y < rows; y += 1) {
    const t = (y - 4) / (rows - 4);
    const inset = Math.round((1 - t) * W * 0.18);
    const band = Math.floor((y - 4) / 5);
    r(inset, y, W - inset * 2, 1, band % 2 === 0 ? roof : dark(roof, 0.12));
    if ((y - 4) % 5 === 0) for (let x = inset + ((band % 2) * 4); x < W - inset; x += 8) r(x, y, 1, 5, dark(roof, 0.3));
  }
  r(Math.round(W * 0.18), 2, W - Math.round(W * 0.36), 3, dark(roof, 0.35));
  r(0, rows - 1, W, 2, dark(roof, 0.4));
  r(Math.round(W * 0.2), 5, W * 0.2, 2, light(roof, 0.25));
  // Chimney.
  r(W - 30, 0, 10, 18, "#8f8a9e"); r(W - 31, 0, 12, 3, "#6d687c"); r(W - 30, 6, 10, 1, "#77728a"); r(W - 30, 12, 10, 1, "#77728a");
  // Door with an arch, a lamp and a step.
  const dx = Math.floor(W / 2) - 8;
  r(dx, wallBottom - 30, 16, 30, "#6b4426"); r(dx + 2, wallBottom - 33, 12, 3, "#6b4426"); r(dx + 4, wallBottom - 35, 8, 2, "#6b4426");
  for (let x = dx + 3; x < dx + 16; x += 4) r(x, wallBottom - 30, 1, 30, "#553419");
  r(dx + 12, wallBottom - 15, 2, 2, GOLD); r(dx - 2, wallBottom - 36, 20, 2, "#553419");
  r(dx - 4, wallBottom, 24, 4, "#b5b0c4");
  r(dx + 20, wallBottom - 26, 3, 5, lit ? "#ffd866" : "#4a4458"); r(dx + 19, wallBottom - 27, 5, 1, "#2b2b38");
  // Windows with shutters and flower boxes.
  const windows: Array<{ x: number; y: number }> = [];
  for (const wx of [Math.floor(W * 0.15), Math.floor(W * 0.85) - 16]) {
    const wy = wallTop + 6;
    r(wx - 3, wy, 3, 16, roof); r(wx + 16, wy, 3, 16, roof);
    r(wx, wy, 16, 16, "#553419");
    r(wx + 1, wy + 1, 14, 14, lit ? "#ffd866" : "#5d6f96");
    if (!lit) { r(wx + 2, wy + 2, 4, 2, "#a9bde0"); r(wx + 2, wy + 4, 2, 2, "#a9bde0"); }
    else { r(wx + 1, wy + 1, 14, 3, "#ffeaa6"); }
    r(wx + 7, wy + 1, 2, 14, "#553419"); r(wx + 1, wy + 7, 14, 2, "#553419");
    r(wx - 2, wy + 16, 20, 4, "#7a4f2c");
    for (let i = 0; i < 6; i += 1) r(wx - 1 + i * 3, wy + 13 + (i % 2), 2, 2, ["#e74c3c", "#f1c40f", "#ff7eb6"][i % 3] as string);
    windows.push({ x: wx + 8, y: wy + 8 });
  }
  outline(ctx, 0, 0, W, H);
  return { image: c, windows };
}

/** A castle for a platform workspace: two towers with pointed roofs and flags, battlements, a gate and banners. */
export function paintCastle(name: string, w: number, h: number, lit: boolean): { image: HTMLCanvasElement; windows: Array<{ x: number; y: number }>; flags: Array<{ x: number; y: number }> } {
  const W = w * TILE;
  const top = 3 * TILE;
  const H = h * TILE + top;
  const c = canvas(W, H);
  const ctx = ctxOf(c);
  const r = (x: number, y: number, ww: number, hh: number, color: string): void => { ctx.fillStyle = color; ctx.fillRect(x, y, ww, hh); };
  const roof = roofOf(name);
  const stone = (x: number, y: number, ww: number, hh: number, base: string): void => {
    r(x, y, ww, hh, base);
    for (let yy = y; yy < y + hh; yy += 6) for (let xx = x + ((yy / 6) % 2) * 5; xx < x + ww; xx += 10) { r(xx, yy, 1, 6, dark(base, 0.18)); }
    for (let yy = y + 5; yy < y + hh; yy += 6) r(x, yy, ww, 1, dark(base, 0.18));
    r(x, y, ww, 1, light(base, 0.25));
  };
  const towerW = 34;
  const keepTop = top + 22;
  stone(towerW - 6, keepTop, W - towerW * 2 + 12, H - keepTop - 2, "#c7c2d6");
  for (let x = towerW - 6; x < W - towerW + 6; x += 10) stone(x, keepTop - 8, 6, 8, "#c7c2d6");
  for (const tx of [0, W - towerW]) {
    stone(tx, top, towerW, H - top - 2, "#b9b4c9");
    for (let x = tx; x < tx + towerW; x += 9) stone(x, top - 7, 5, 7, "#b9b4c9");
    for (let y = 0; y < top - 7; y += 1) { const inset = Math.round(((top - 7 - y) / (top - 7)) * (towerW / 2 - 1)); r(tx + inset, y + 4, towerW - inset * 2, 1, y % 4 < 2 ? roof : dark(roof, 0.12)); }
    r(tx + towerW / 2 - 4, top + 18, 8, 12, lit ? "#ffd866" : "#3a3550"); r(tx + towerW / 2 - 4, top + 16, 8, 2, "#3a3550");
    r(tx + towerW / 2 - 3, top + 42, 6, 9, lit ? "#ffd866" : "#3a3550");
  }
  // Gate with a portcullis.
  const gx = Math.floor(W / 2) - 14;
  r(gx, H - 40, 28, 38, "#2b2438"); r(gx + 3, H - 44, 22, 4, "#2b2438"); r(gx + 7, H - 47, 14, 3, "#2b2438");
  for (let x = gx + 3; x < gx + 28; x += 5) r(x, H - 44, 1, 26, "#6d687c");
  for (let y = H - 40; y < H - 18; y += 5) r(gx + 1, y, 26, 1, "#6d687c");
  r(gx - 4, H - 2, 36, 2, "#9a95a8");
  // Banners.
  for (const bx of [gx - 22, gx + 36]) { r(bx, keepTop + 10, 12, 26, roof); r(bx + 4, keepTop + 18, 4, 6, GOLD); r(bx, keepTop + 36, 4, 3, roof); r(bx + 8, keepTop + 36, 4, 3, roof); r(bx - 1, keepTop + 9, 14, 2, "#553419"); }
  r(Math.floor(W / 2) - 5, keepTop + 6, 10, 10, lit ? "#ffd866" : "#3a3550");
  outline(ctx, 0, 0, W, H);
  return { image: c, windows: [{ x: towerW / 2, y: top + 24 }, { x: W - towerW / 2, y: top + 24 }, { x: W / 2, y: keepTop + 11 }], flags: [{ x: towerW / 2, y: 4 }, { x: W - towerW / 2, y: 4 }] };
}

const props = new Map<string, HTMLCanvasElement>();
/** A piece of scenery, painted once; its base is the bottom of the canvas. */
export function paintProp(prop: Prop): HTMLCanvasElement {
  const key = `${prop.kind}|${prop.seed % 4}`;
  const cached = props.get(key);
  if (cached) return cached;
  const random = seeded(prop.seed % 4 + 11);
  let c: HTMLCanvasElement;
  const draw = (w: number, h: number, paint: (r: (x: number, y: number, ww: number, hh: number, color: string) => void) => void, line = true): HTMLCanvasElement => {
    const cv = canvas(w, h);
    const ctx = ctxOf(cv);
    paint((x, y, ww, hh, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, ww, hh); });
    if (line) outline(ctx, 0, 0, w, h);
    return cv;
  };
  switch (prop.kind) {
    case "tree": {
      const leaf = ["#3f8f3f", "#4a9a45", "#2f7f3a", "#579c3c"][prop.seed % 4] as string;
      c = draw(32, 44, (r) => {
        r(13, 30, 6, 12, "#7a4f2c"); r(13, 30, 2, 12, "#9c6b3f"); r(10, 40, 12, 2, "#6b4426");
        const blob = (cx: number, cy: number, rad: number, color: string): void => { for (let y = -rad; y <= rad; y += 1) { const half = Math.round(Math.sqrt(rad * rad - y * y)); r(cx - half, cy + y, half * 2, 1, color); } };
        blob(16, 20, 13, dark(leaf, 0.2)); blob(14, 17, 11, leaf); blob(11, 13, 6, light(leaf, 0.2));
        for (let n = 0; n < 14; n += 1) r(4 + Math.floor(random() * 24), 6 + Math.floor(random() * 24), 2, 1, n % 2 ? light(leaf, 0.35) : dark(leaf, 0.3));
        if (prop.seed % 3 === 0) for (let n = 0; n < 4; n += 1) r(6 + Math.floor(random() * 20), 10 + Math.floor(random() * 16), 2, 2, "#e74c3c");
      });
      break;
    }
    case "bush": c = draw(16, 14, (r) => { r(1, 4, 14, 9, "#3f8f3f"); r(3, 2, 10, 4, "#4fa64a"); r(4, 3, 4, 2, "#6cc05a"); r(5, 7, 2, 2, "#f1c40f"); r(10, 6, 2, 2, "#ff7eb6"); }); break;
    case "rock": c = draw(16, 12, (r) => { r(2, 3, 12, 8, "#8f8a9e"); r(4, 1, 8, 3, "#a5a0b4"); r(4, 2, 4, 2, "#c5c0d4"); r(2, 9, 12, 2, "#6d687c"); }); break;
    case "stump": c = draw(16, 12, (r) => { r(3, 3, 10, 8, "#7a4f2c"); r(3, 2, 10, 3, "#c9a46a"); r(6, 3, 4, 1, "#9c6b3f"); }); break;
    case "flowers": c = draw(16, 10, (r) => { for (let n = 0; n < 5; n += 1) { const x = 2 + n * 3; r(x, 4, 1, 5, "#3f8f3f"); r(x - 1, 2 + (n % 2), 3, 2, ["#e74c3c", "#f1c40f", "#ff7eb6", "#9b59b6", "#ffffff"][n] as string); } }, false); break;
    case "lamp": c = draw(10, 34, (r) => { r(4, 8, 2, 24, "#2b2b38"); r(2, 31, 6, 3, "#2b2b38"); r(1, 2, 8, 7, "#2b2b38"); r(2, 3, 6, 5, "#ffd866"); r(3, 0, 4, 2, "#2b2b38"); }); break;
    case "board": c = draw(32, 30, (r) => { r(3, 10, 3, 20, "#6b4426"); r(26, 10, 3, 20, "#6b4426"); r(1, 2, 30, 18, "#9c6b3f"); r(1, 2, 30, 2, "#b07d4c"); r(3, 5, 26, 13, "#7a4f2c"); r(0, 0, 32, 3, "#c0453b"); }); break;
    case "bench": c = draw(32, 14, (r) => { r(0, 2, 32, 3, "#9c6b3f"); r(0, 6, 32, 3, "#b07d4c"); r(2, 9, 2, 5, "#2b2b38"); r(28, 9, 2, 5, "#2b2b38"); }); break;
    case "well": c = draw(32, 34, (r) => { r(2, 18, 28, 14, "#9a95a8"); for (let x = 2; x < 30; x += 7) r(x, 18, 1, 14, "#6d687c"); r(2, 24, 28, 1, "#6d687c"); r(5, 18, 22, 3, "#2d4a7a"); r(4, 4, 2, 15, "#6b4426"); r(26, 4, 2, 15, "#6b4426"); r(1, 1, 30, 4, "#c0453b"); r(14, 6, 4, 6, "#7a4f2c"); }); break;
    case "fountain": c = draw(64, 52, (r) => {
      const ring = (rx: number, ry: number, color: string, cy = 30): void => { for (let y = -ry; y <= ry; y += 1) { const half = Math.round(rx * Math.sqrt(1 - (y * y) / (ry * ry))); r(32 - half, cy + y, half * 2, 1, color); } };
      ring(31, 16, "#9a95a8"); ring(28, 13, "#bdb7cc", 29); ring(25, 11, "#3d7fc4", 30); ring(20, 8, "#5aa0e0", 30);
      r(28, 12, 8, 20, "#bdb7cc"); r(28, 12, 2, 20, "#d6d1e3"); ring(10, 4, "#bdb7cc", 12); ring(8, 3, "#5aa0e0", 12);
      r(31, 2, 2, 8, "#a9d6ff");
    }); break;
    case "pond": c = draw(112, 64, (r) => {
      for (let y = 0; y < 64; y += 1) { const half = Math.round(54 * Math.sqrt(Math.max(0, 1 - ((y - 32) ** 2) / (31 * 31)))); r(56 - half, y, half * 2, 1, y < 3 || y > 60 ? "#6bb04a" : "#3d7fc4"); }
      for (let y = 6; y < 58; y += 1) { const half = Math.round(48 * Math.sqrt(Math.max(0, 1 - ((y - 32) ** 2) / (26 * 26)))); r(56 - half, y, half * 2, 1, "#4f93d6"); }
      for (let n = 0; n < 6; n += 1) { const x = 20 + Math.floor(random() * 70); const y = 14 + Math.floor(random() * 34); r(x, y, 6, 4, "#3f8f3f"); r(x + 2, y + 1, 2, 2, "#ff7eb6"); }
      for (let n = 0; n < 8; n += 1) { const x = 6 + Math.floor(random() * 100); r(x, 2 + Math.floor(random() * 6), 1, 8, "#2f7f3a"); r(x, 1, 1, 3, "#7a4f2c"); }
    }, false); break;
  }
  props.set(key, c);
  return c;
}

/** A small speech bubble with a pixel glyph, above a character's head. */
export function paintEmote(kind: Emote): HTMLCanvasElement {
  const key = `emote|${kind}`;
  const cached = props.get(key);
  if (cached) return cached;
  const c = canvas(13, 14);
  const ctx = ctxOf(c);
  const r = (x: number, y: number, w: number, h: number, color: string): void => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  r(1, 1, 11, 10, "#ffffff"); r(5, 11, 3, 1, "#ffffff"); r(6, 12, 1, 1, "#ffffff");
  const ink = kind === "!" ? "#e67e22" : kind === "ok" ? "#2e9a4a" : kind === "no" ? "#d63a3a" : kind === "heart" ? "#e5484d" : "#3a3550";
  const glyph: Record<Emote, string[]> = {
    "!": ["..X..", "..X..", "..X..", "..X..", ".....", "..X.."],
    ok: ["....X", "...XX", "X.XX.", "XXX..", ".X..."],
    no: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
    note: ["..XXX", "..X.X", "..X.X", "XXX.X", "XX..."],
    zz: ["XXXX.", "..X..", ".X...", "XXXX."],
    dots: [".....", ".....", "X.X.X"],
    heart: [".X.X.", "XXXXX", "XXXXX", ".XXX.", "..X.."],
    "?": [".XXX.", "X...X", "...X.", "..X..", ".....", "..X.."],
  };
  const rows = glyph[kind];
  const oy = Math.floor((10 - rows.length) / 2) + 1;
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === "X") r(4 + x, oy + y, 1, 1, ink); }));
  outline(ctx, 0, 0, 13, 14);
  props.set(key, c);
  return c;
}
