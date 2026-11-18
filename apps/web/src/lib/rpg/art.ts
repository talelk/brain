import { hashOf, seeded, TILE, type Dir, type Emote, type Ground, type Layout, type Prop } from "./world";

/**
 * The art of the village, drawn in code with smooth shapes (no image, no pixel grid): characters drawn live every frame so they
 * breathe, blink, swing their arms and tools and change their face; buildings, trees and the ground painted once at a high
 * resolution and drawn smoothly at any zoom. Coordinates are world pixels (a tile is 16).
 */

type Ctx = CanvasRenderingContext2D;
/** Scenery is painted at this many canvas pixels per world pixel, so it stays sharp when zoomed in. */
export const RES = 4;
const GROUND_RES = 2;
const canvas = (w: number, h: number): HTMLCanvasElement => { const c = document.createElement("canvas"); c.width = Math.ceil(w); c.height = Math.ceil(h); return c; };
const ctxOf = (c: HTMLCanvasElement): Ctx => c.getContext("2d") as Ctx;

/** Mixes two colours, `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const p = (hex: string, i: number): number => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}
const dark = (c: string, t = 0.25): string => mix(c, "#1b1630", t);
const light = (c: string, t = 0.25): string => mix(c, "#ffffff", t);
const INK = "#2a2236";

// ——— Shapes ———
const rr = (ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
const ell = (ctx: Ctx, x: number, y: number, rx: number, ry: number): void => { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2); };
function fillLine(ctx: Ctx, fill: string | CanvasGradient, line = INK, width = 0.7): void { ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = line; ctx.lineWidth = width; ctx.stroke(); }
function vgrad(ctx: Ctx, y0: number, y1: number, top: string, bottom: string): CanvasGradient { const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, top); g.addColorStop(1, bottom); return g; }
function hgrad(ctx: Ctx, x0: number, x1: number, left: string, right: string): CanvasGradient { const g = ctx.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, left); g.addColorStop(1, right); return g; }
function limb(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, width: number, color: string): void {
  ctx.lineCap = "round";
  ctx.strokeStyle = INK; ctx.lineWidth = width + 1.2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
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

/** How tall a character stands, in world pixels, and how wide it is for a click. */
export const HERO_H = 36;
export const HERO_W = 18;
const SKINS = ["#f6d3b3", "#eab98f", "#d39a6c", "#a8714a", "#7a4e33"] as const;
const HAIRS = ["#3b2a20", "#7a4a26", "#c9883a", "#ecd27a", "#2b3550", "#a63d3d", "#e5e1ee", "#5b3d7a"] as const;
const EYES = ["#3a6ea5", "#4f8a3c", "#6b4426", "#5b3d7a", "#2b2b38"] as const;
const TUNICS = ["#3f7fd1", "#c0453b", "#2e9a6a", "#8e5bd1", "#d68f1a", "#1f9fb4", "#5a6fd6", "#b8478a"] as const;
export const CAPES = ["#c0392b", "#2e86c1", "#27ae60", "#8e44ad", "#e67e22", "#16a085"] as const;
type Hair = "short" | "long" | "spiky" | "bun" | "bald" | "tail";
const HAIR_STYLES: readonly Hair[] = ["short", "long", "spiky", "bun", "bald", "tail"];

export interface Look { skin: string; hair: string; hairStyle: Hair; eye: string; tunic: string; pants: string; boots: string; cape: string; accent: string; kind: Class; beard: boolean }
const pick = <T,>(list: readonly T[], seed: number, salt: number): T => list[((seed >>> 0) + salt * 7919) % list.length] as T;
const looks = new Map<string, Look>();
export function lookOf(agent: string, variant: number): Look {
  const key = `${agent}|${variant}`;
  const known = looks.get(key);
  if (known) return known;
  const seed = hashOf(agent);
  const kind = classOf(agent);
  const look: Look = {
    skin: pick(SKINS, seed, 1), hair: pick(HAIRS, seed, 2), hairStyle: pick(HAIR_STYLES, seed, 3), eye: pick(EYES, seed, 8), tunic: pick(TUNICS, seed, 4),
    pants: pick(["#3a3f58", "#5a4632", "#2f4a3a", "#3d2f4f"], seed, 5), boots: pick(["#6b4426", "#3b2a20", "#2b2b38"], seed, 6),
    cape: CAPES[variant % CAPES.length] as string, accent: pick(["#c0392b", "#2e86c1", "#d4ac0d", "#8e44ad", "#16a085"], seed, 7), kind,
    beard: (kind === "mage" || kind === "scribe") && seed % 3 === 0,
  };
  looks.set(key, look);
  return look;
}

export type Mood = "neutral" | "happy" | "sad" | "focus";
export interface Pose {
  readonly dir: Dir;
  /** The phase of the walk, in radians, or null when standing. */
  readonly walk: number | null;
  /** The phase of the work, in radians, or null when not working. */
  readonly work: number | null;
  /** Seconds, for breathing, blinking and the cape. */
  readonly t: number;
  readonly mood: Mood;
  /** A number of the character, so two of them do not blink together. */
  readonly seed: number;
}

/** Draws a character with its feet at (0, 0). Right is left mirrored. */
export function drawHero(ctx: Ctx, look: Look, pose: Pose): void {
  ctx.save();
  if (pose.dir === 2) ctx.scale(-1, 1);
  const dir = pose.dir === 2 ? 1 : pose.dir;
  const walk = pose.walk;
  const swing = walk === null ? 0 : Math.sin(walk);
  const bob = walk === null ? Math.sin(pose.t * 2.2 + pose.seed) * 0.25 : -Math.abs(Math.cos(walk)) * 0.9;
  const breathe = 1 + Math.sin(pose.t * 2.2 + pose.seed) * 0.018;
  const robe = look.kind === "mage" || look.kind === "cleric";
  const body = look.kind === "cleric" ? "#f3eee2" : look.kind === "knight" ? "#c9cfdb" : look.kind === "ranger" ? "#4d7a3f" : look.tunic;
  const blink = (pose.t + (pose.seed % 7)) % 4.2 < 0.13;

  // Legs, hidden under a robe except the feet.
  const leg = (x: number, lift: number, angle: number, back: boolean): void => {
    const hipY = -10;
    const footX = x + Math.sin(angle) * 6;
    const footY = -1.2 - lift;
    if (!robe) limb(ctx, x, hipY, footX, footY, 3.4, back ? dark(look.pants, 0.18) : look.pants);
    ell(ctx, footX + (dir === 1 ? -0.8 : 0), footY + 0.6, 2.3, 1.5); fillLine(ctx, back ? dark(look.boots, 0.2) : look.boots);
  };
  const cape = (): void => {
    if (look.kind === "cleric") return;
    const flutter = Math.sin(pose.t * 3 + pose.seed) * 0.8 + (walk === null ? 0 : 1.5);
    ctx.beginPath();
    if (dir === 1) { ctx.moveTo(1, -18); ctx.quadraticCurveTo(6 + flutter, -10, 5 + flutter * 1.6, -2.5); ctx.lineTo(0, -3.5); ctx.closePath(); }
    else { ctx.moveTo(-5.5, -18); ctx.lineTo(5.5, -18); ctx.quadraticCurveTo(7 + flutter * 0.5, -10, 6.5 + flutter * 0.3, -2.5); ctx.quadraticCurveTo(0, -1 + flutter * 0.4, -6.5 - flutter * 0.3, -2.5); ctx.quadraticCurveTo(-7 - flutter * 0.5, -10, -5.5, -18); }
    fillLine(ctx, vgrad(ctx, -18, -2, look.cape, dark(look.cape, 0.3)));
  };

  if (dir === 0 || dir === 3) {
    if (dir === 0) cape();
    leg(-2.6, walk === null ? 0 : Math.max(0, swing) * 1.6, 0, false);
    leg(2.6, walk === null ? 0 : Math.max(0, -swing) * 1.6, 0, false);
  } else {
    leg(0.6, 0, -swing * 0.5, true);
    cape();
    leg(-0.6, 0, swing * 0.5, false);
  }

  // The upper body breathes around the hips.
  ctx.save();
  ctx.translate(0, -10 + bob);
  ctx.scale(1, breathe);
  ctx.translate(0, 10);
  const torso = (): void => {
    if (robe) { ctx.beginPath(); ctx.moveTo(-5, -18); ctx.lineTo(5, -18); ctx.quadraticCurveTo(7.2, -9, 7, -1.6 - bob); ctx.lineTo(-7, -1.6 - bob); ctx.quadraticCurveTo(-7.2, -9, -5, -18); }
    else rr(ctx, dir === 1 ? -4.5 : -5.5, -18.5, dir === 1 ? 9 : 11, 10, 3.2);
    fillLine(ctx, hgrad(ctx, -6, 6, light(body, 0.12), dark(body, 0.18)));
    if (robe) { ctx.fillStyle = look.kind === "cleric" ? "#e2b84a" : dark(body, 0.35); ctx.fillRect(-7, -3.2 - bob, 14, 1.4); }
    if (!robe) { ctx.fillStyle = "#5a3a22"; ctx.fillRect(dir === 1 ? -4.5 : -5.5, -10.8, dir === 1 ? 9 : 11, 1.5); if (dir === 0) { ctx.fillStyle = "#e2b84a"; ctx.fillRect(-1, -11, 2, 1.9); } }
    if (dir === 0) {
      if (look.kind === "knight") { ell(ctx, 0, -15, 3, 2.4); ctx.fillStyle = light(body, 0.35); ctx.fill(); ctx.fillStyle = look.accent; ctx.fillRect(-0.6, -17.5, 1.2, 5); ctx.fillRect(-2.2, -16, 4.4, 1.2); }
      if (look.kind === "cleric") { ctx.fillStyle = look.accent; ctx.fillRect(-0.8, -16.5, 1.6, 6); ctx.fillRect(-2.6, -14.6, 5.2, 1.6); }
      if (look.kind === "builder") { rr(ctx, -3.6, -15.5, 7.2, 7, 1.2); fillLine(ctx, "#8b5a2b", INK, 0.5); ctx.fillStyle = "#c9a46a"; ctx.fillRect(-3.2, -14.8, 6.4, 0.8); }
      if (look.kind === "scribe") { ctx.beginPath(); ctx.moveTo(-5, -18); ctx.lineTo(-1.2, -11); ctx.lineTo(-5, -9); ctx.closePath(); fillLine(ctx, dark(look.accent, 0.1), INK, 0.4); ctx.beginPath(); ctx.moveTo(5, -18); ctx.lineTo(1.2, -11); ctx.lineTo(5, -9); ctx.closePath(); fillLine(ctx, dark(look.accent, 0.1), INK, 0.4); }
      if (look.kind === "ranger") { ctx.strokeStyle = "#6b4426"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(-5, -18); ctx.lineTo(5, -10); ctx.stroke(); }
      if (look.kind === "mage") { ctx.strokeStyle = "#e2b84a"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(0, -2.5); ctx.stroke(); }
    }
  };

  // Arms: swing while walking, act while working.
  const work = pose.work;
  const arm = (side: -1 | 1, front: boolean): { x: number; y: number } => {
    const sx = dir === 1 ? (front ? -1 : 1.5) : side * 5.4;
    const sy = -16.5;
    let angle = walk === null ? 0.08 * side : swing * 0.6 * side * (dir === 1 ? (front ? 1 : -1) : 1);
    if (work !== null && (side === 1 || dir === 1) && front) angle = workAngle(look.kind, work);
    if (dir === 1 && !front && work !== null) angle = 0.4;
    const length = 7;
    const hx = sx + Math.sin(angle) * length * (dir === 1 ? -1 : side === 1 ? 1 : -1) * (dir === 1 ? 1 : 0.55);
    const hy = sy + Math.cos(angle) * length;
    const sleeve = look.kind === "knight" ? "#b9c0cf" : robe ? dark(body, 0.08) : dark(body, 0.1);
    limb(ctx, sx, sy, hx, hy, 2.9, sleeve);
    ell(ctx, hx, hy, 1.5, 1.5); fillLine(ctx, look.kind === "knight" ? "#8a93a6" : look.skin, INK, 0.5);
    return { x: hx, y: hy };
  };

  let hand = { x: 5.4, y: -9.5 };
  let off = { x: -5.4, y: -9.5 };
  if (dir === 0) { torso(); off = arm(-1, true); hand = arm(1, true); }
  else if (dir === 3) { torso(); off = arm(-1, true); hand = arm(1, true); }
  else { arm(1, false); torso(); }

  // Head.
  ctx.save();
  ctx.translate(0, -25.5);
  const tilt = work !== null ? Math.sin(work) * 0.05 : walk !== null ? swing * 0.03 : Math.sin(pose.t * 0.7 + pose.seed) * 0.03;
  ctx.rotate(tilt);
  if (dir !== 3 && look.hairStyle === "long" && look.kind !== "knight" && look.kind !== "cleric" && look.kind !== "ranger") { if (dir === 1) rr(ctx, -0.5, -3, 8.6, 12, 4); else rr(ctx, -7.6, -3, 15.2, 12, 4); fillLine(ctx, dark(look.hair, 0.15)); }
  if (look.hairStyle === "tail" && dir === 1 && look.kind !== "knight") { ctx.beginPath(); ctx.moveTo(5, -3); ctx.quadraticCurveTo(10, 1, 7 + Math.sin(pose.t * 3) * 0.6, 7); ctx.quadraticCurveTo(6, 2, 4, 0); fillLine(ctx, look.hair); }
  ell(ctx, 0, 0, 7.6, 7.1);
  const skin = ctx.createRadialGradient(-2.5, -2.5, 1, 0, 0, 8.5); skin.addColorStop(0, light(look.skin, 0.15)); skin.addColorStop(1, dark(look.skin, 0.12));
  fillLine(ctx, skin, INK, 0.8);
  if (dir === 0) face(ctx, look, pose.mood, blink);
  else if (dir === 1) {
    if (!blink) { ell(ctx, -3.6, 0.6, 1.1, 1.5); ctx.fillStyle = INK; ctx.fill(); ell(ctx, -3.9, 0.1, 0.35, 0.35); ctx.fillStyle = "#fff"; ctx.fill(); }
    else { ctx.strokeStyle = INK; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(-4.6, 0.8); ctx.lineTo(-2.6, 0.8); ctx.stroke(); }
    ell(ctx, -7.3, 1.8, 0.9, 0.8); ctx.fillStyle = dark(look.skin, 0.08); ctx.fill();
    ctx.strokeStyle = dark(look.skin, 0.45); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.arc(-4.4, 3.7, 1, pose.mood === "sad" ? -Math.PI * 0.9 : 0.2, pose.mood === "sad" ? -Math.PI * 0.1 : Math.PI * 0.8); ctx.stroke();
    ell(ctx, 1.4, 1, 1.4, 1.8); fillLine(ctx, look.skin, INK, 0.5);
    ell(ctx, -4.6, 3.1, 1.2, 0.7); ctx.fillStyle = "rgba(232,106,106,0.35)"; ctx.fill();
  }
  headwear(ctx, look, dir, pose);
  ctx.restore();

  if (dir === 1) { hand = arm(-1, true); off = hand; }
  gear(ctx, look, dir, hand, off, pose);
  if (dir === 3) cape();
  ctx.restore();
  ctx.restore();
}

/** The angle of the working arm: a hammer that strikes, a staff raised, a quill that writes, a bow drawn. */
function workAngle(kind: Class, phase: number): number {
  const s = Math.sin(phase);
  switch (kind) {
    case "builder": return 2.4 - Math.max(0, s) * 2.2;
    case "knight": return 2.2 - (s + 1) * 0.9;
    case "mage": case "cleric": return 2.6 + s * 0.15;
    case "scribe": return 1.2 + s * 0.25;
    case "ranger": return 1.57 + s * 0.1;
  }
}

function face(ctx: Ctx, look: Look, mood: Mood, blink: boolean): void {
  const eye = (x: number): void => {
    if (blink || mood === "happy") {
      ctx.strokeStyle = INK; ctx.lineWidth = 0.7; ctx.beginPath();
      if (mood === "happy") ctx.arc(x, 1.4, 1.3, Math.PI * 1.1, Math.PI * 1.9); else { ctx.moveTo(x - 1.3, 0.8); ctx.lineTo(x + 1.3, 0.8); }
      ctx.stroke();
      return;
    }
    ell(ctx, x, 0.6, 1.5, 1.9); ctx.fillStyle = "#ffffff"; ctx.fill();
    ell(ctx, x, 0.9, 1.15, 1.45); ctx.fillStyle = look.eye; ctx.fill();
    ell(ctx, x, 1, 0.6, 0.75); ctx.fillStyle = INK; ctx.fill();
    ell(ctx, x - 0.45, 0.3, 0.38, 0.38); ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 0.55; ell(ctx, x, 0.6, 1.5, 1.9); ctx.stroke();
  };
  eye(-2.8); eye(2.8);
  // Brows show the mood.
  ctx.strokeStyle = dark(look.hair, 0.2); ctx.lineWidth = 0.7; ctx.lineCap = "round";
  const brow = mood === "sad" ? 0.35 : mood === "focus" ? -0.3 : 0;
  for (const side of [-1, 1] as const) { ctx.beginPath(); ctx.moveTo(side * 1.6, -2.1 - brow * side * -1); ctx.lineTo(side * 4, -2.1 + brow * side * -1 - (mood === "focus" ? 0 : 0.2)); ctx.stroke(); }
  ell(ctx, -4.4, 3, 1.3, 0.8); ctx.fillStyle = "rgba(232,106,106,0.35)"; ctx.fill(); ell(ctx, 4.4, 3, 1.3, 0.8); ctx.fill();
  ctx.strokeStyle = dark(look.skin, 0.5); ctx.lineWidth = 0.65;
  ctx.beginPath();
  if (mood === "happy") { ctx.arc(0, 3.4, 1.6, 0.1, Math.PI - 0.1); ctx.fillStyle = "#9b3b3b"; ctx.fill(); }
  else if (mood === "sad") ctx.arc(0, 5.3, 1.3, Math.PI * 1.15, Math.PI * 1.85);
  else if (mood === "focus") { ctx.moveTo(-0.9, 4.2); ctx.lineTo(0.9, 4.2); }
  else ctx.arc(0, 3.4, 1.2, 0.25, Math.PI - 0.25);
  ctx.stroke();
  if (look.beard) { ctx.beginPath(); ctx.moveTo(-5, 2.6); ctx.quadraticCurveTo(0, 11, 5, 2.6); ctx.quadraticCurveTo(0, 5.4, -5, 2.6); fillLine(ctx, look.kind === "mage" ? "#ece8f2" : look.hair, INK, 0.5); }
}

function headwear(ctx: Ctx, look: Look, dir: 0 | 1 | 3, pose: Pose): void {
  const { kind, hair } = look;
  const side = dir === 1;
  if (kind === "knight") {
    ctx.beginPath(); ctx.arc(0, 0.5, 8.2, Math.PI, 0); ctx.lineTo(8.2, dir === 3 ? 6 : 3); ctx.lineTo(side ? 2 : 6, dir === 3 ? 6 : 3); ctx.lineTo(side ? 2 : 6, -1); ctx.lineTo(side ? -8.2 : -6, -1); ctx.lineTo(-8.2, 3); ctx.closePath();
    if (dir === 3) { ell(ctx, 0, 0, 8.2, 7.8); }
    fillLine(ctx, hgrad(ctx, -8, 8, "#e8ecf3", "#8a93a6"));
    ctx.fillStyle = "#ffffff"; ctx.globalAlpha = 0.5; ell(ctx, -3, -5, 2.2, 1.1); ctx.fill(); ctx.globalAlpha = 1;
    const sway = Math.sin(pose.t * 3 + pose.seed) * 1.2;
    ctx.beginPath(); ctx.moveTo(0, -7.5); ctx.quadraticCurveTo(3 + sway, -14, 9 + sway, -10); ctx.quadraticCurveTo(4, -10, 1.5, -7); fillLine(ctx, look.accent, INK, 0.6);
    return;
  }
  if (kind === "mage") {
    hairCap(ctx, look, dir);
    const bend = Math.sin(pose.t * 1.5 + pose.seed) * 1.2;
    const hat = dark(look.tunic, 0.1);
    ctx.beginPath(); ctx.moveTo(-6.5, -4.5); ctx.quadraticCurveTo(-2, -13, 3 + bend, -19); ctx.quadraticCurveTo(1, -11, 6.5, -4.5); ctx.closePath(); fillLine(ctx, hgrad(ctx, -6, 6, light(hat, 0.15), dark(hat, 0.25)));
    ell(ctx, 0, -4.2, 11, 2.7); fillLine(ctx, dark(hat, 0.15));
    ctx.fillStyle = "#f2c14e"; star(ctx, -1, -9, 1.3); star(ctx, 2.5, -13, 0.9);
    ctx.fillStyle = "#e2b84a"; ctx.fillRect(-6, -6, 12, 1.2);
    return;
  }
  if (kind === "cleric" || kind === "ranger") {
    const hood = kind === "cleric" ? "#f6f2e8" : "#3f6e3a";
    ctx.beginPath();
    if (dir === 3) ell(ctx, 0, 0, 8.6, 8.2);
    else if (side) { ctx.moveTo(-7.6, -2); ctx.quadraticCurveTo(-6, -9.5, 1, -9); ctx.quadraticCurveTo(9.5, -7, 8.6, 3); ctx.quadraticCurveTo(8, 9, 2, 8.5); ctx.lineTo(2, 0); ctx.quadraticCurveTo(-3, -5, -7.6, -2); }
    else { ctx.moveTo(-8.6, 6); ctx.quadraticCurveTo(-10, -9, 0, -9.5); ctx.quadraticCurveTo(10, -9, 8.6, 6); ctx.lineTo(6.6, 6); ctx.quadraticCurveTo(7, -4, 0, -4.5); ctx.quadraticCurveTo(-7, -4, -6.6, 6); ctx.closePath(); }
    fillLine(ctx, hgrad(ctx, -8, 8, light(hood, 0.1), dark(hood, 0.2)));
    if (kind === "cleric" && dir !== 3) { ctx.strokeStyle = "#e2b84a"; ctx.lineWidth = 0.8; ctx.beginPath(); if (side) { ctx.moveTo(-7.6, -2); ctx.quadraticCurveTo(-3, -5, 2, 0); } else { ctx.moveTo(-6.6, 6); ctx.quadraticCurveTo(-7, -4, 0, -4.5); ctx.quadraticCurveTo(7, -4, 6.6, 6); } ctx.stroke(); }
    if (dir !== 3 && !side) { ctx.fillStyle = look.hair; ctx.beginPath(); ctx.moveTo(-5, -3.2); ctx.quadraticCurveTo(0, -5.2, 5, -3.2); ctx.quadraticCurveTo(0, -1.8, -5, -3.2); ctx.fill(); }
    return;
  }
  hairCap(ctx, look, dir);
  if (kind === "scribe") {
    ctx.save(); ctx.rotate(-0.15);
    ell(ctx, 0.5, -6, 8.4, 3.2); fillLine(ctx, hgrad(ctx, -8, 8, look.accent, dark(look.accent, 0.3)));
    ell(ctx, 0.5, -8.4, 0.9, 0.9); fillLine(ctx, dark(look.accent, 0.4), INK, 0.4);
    ctx.beginPath(); ctx.moveTo(6, -6); ctx.quadraticCurveTo(13, -12, 10, -16); ctx.quadraticCurveTo(9, -10, 5, -6.5); fillLine(ctx, "#f4ecd8", INK, 0.5);
    ctx.restore();
    if (dir === 0) { ctx.strokeStyle = "#4a3a2a"; ctx.lineWidth = 0.6; ell(ctx, -2.8, 0.7, 2, 2); ctx.stroke(); ell(ctx, 2.8, 0.7, 2, 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-0.8, 0.4); ctx.lineTo(0.8, 0.4); ctx.stroke(); }
    if (side) { ctx.strokeStyle = "#4a3a2a"; ctx.lineWidth = 0.6; ell(ctx, -3.8, 0.7, 1.8, 2); ctx.stroke(); }
  }
  if (kind === "builder") {
    ctx.beginPath(); ctx.arc(0, -2.2, 7.8, Math.PI, 0); ctx.closePath(); fillLine(ctx, hgrad(ctx, -8, 8, "#ffd84a", "#d9a400"));
    ctx.beginPath(); ctx.moveTo(side ? -11 : -9.4, -2.2); ctx.lineTo(side ? 4 : 9.4, -2.2); ctx.lineTo(side ? 4 : 9.4, -0.8); ctx.lineTo(side ? -11 : -9.4, -0.8); ctx.closePath(); fillLine(ctx, "#e0ad10");
    ctx.fillStyle = "#fff3b0"; ctx.fillRect(-1, -9.6, 2, 7);
  }
  void hair;
}

function hairCap(ctx: Ctx, look: Look, dir: 0 | 1 | 3): void {
  const { hair, hairStyle } = look;
  if (hairStyle === "bald") { if (dir !== 0) { ctx.beginPath(); ctx.arc(0, 0.5, 7.6, Math.PI * 0.15, Math.PI * 0.85); ctx.lineTo(-6, 2); fillLine(ctx, hair, INK, 0.5); } return; }
  const g = vgrad(ctx, -8, 2, light(hair, 0.2), dark(hair, 0.15));
  ctx.beginPath();
  if (dir === 3) { ctx.arc(0, 0, 7.9, Math.PI * 0.95, Math.PI * 2.05); ctx.lineTo(7.4, 4); ctx.quadraticCurveTo(0, 7.5, -7.4, 4); ctx.closePath(); }
  else if (dir === 1) { ctx.moveTo(-7.4, -1.2); ctx.quadraticCurveTo(-7, -8.5, 0, -8.2); ctx.quadraticCurveTo(8.5, -7.5, 7.9, 1.5); ctx.quadraticCurveTo(7.4, 5.6, 3.2, 5); ctx.quadraticCurveTo(3, -1.2, -1.5, -2.2); ctx.quadraticCurveTo(-4.2, -3.6, -7.4, -1.2); }
  else { ctx.moveTo(-7.8, 2); ctx.quadraticCurveTo(-8.6, -8.2, 0, -8.2); ctx.quadraticCurveTo(8.6, -8.2, 7.8, 2); ctx.quadraticCurveTo(6, -2.8, 3, -2.6); ctx.quadraticCurveTo(1.5, -1.4, 0, -3); ctx.quadraticCurveTo(-1.5, -1.4, -3, -2.6); ctx.quadraticCurveTo(-6, -2.8, -7.8, 2); }
  fillLine(ctx, g, INK, 0.7);
  ctx.fillStyle = light(hair, 0.4); ctx.globalAlpha = 0.55; ell(ctx, -2.6, -6, 2.6, 0.9); ctx.fill(); ctx.globalAlpha = 1;
  if (hairStyle === "spiky") { ctx.beginPath(); for (const x of [-5, -1.5, 2, 5.5]) { ctx.moveTo(x - 2, -6.5); ctx.lineTo(x + 0.5, -11); ctx.lineTo(x + 2, -6.5); } fillLine(ctx, g, INK, 0.6); }
  if (hairStyle === "bun") { ell(ctx, 0, -9.2, 3, 2.6); fillLine(ctx, g); }
  if (hairStyle === "tail" && dir === 3) { ctx.beginPath(); ctx.moveTo(-1.5, 3); ctx.quadraticCurveTo(0, 9, 1.5, 3); fillLine(ctx, g, INK, 0.5); }
}

function star(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2; const d = i % 2 === 0 ? r : r * 0.45; ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d); }
  ctx.closePath(); ctx.fill();
}

function gear(ctx: Ctx, look: Look, dir: 0 | 1 | 3, hand: { x: number; y: number }, off: { x: number; y: number }, pose: Pose): void {
  const working = pose.work !== null;
  const side = dir === 1;
  const angleOf = (h: { x: number; y: number }): number => Math.atan2(h.y + 16.5, h.x - (side ? -1 : 5.4));
  switch (look.kind) {
    case "knight": {
      // Sword in the hand, along the arm; a kite shield on the other arm.
      const a = angleOf(hand) - Math.PI / 2 + (working ? 0 : 0.2);
      ctx.save(); ctx.translate(hand.x, hand.y); ctx.rotate(a + Math.PI);
      rr(ctx, -0.9, 1.4, 1.8, 11, 0.8); fillLine(ctx, hgrad(ctx, -1, 1, "#ffffff", "#9aa3b5"), INK, 0.5);
      ctx.fillStyle = "#e2b84a"; rr(ctx, -2.6, 0.4, 5.2, 1.3, 0.6); fillLine(ctx, "#e2b84a", INK, 0.4);
      ctx.restore();
      if (dir !== 3) {
        ctx.save(); ctx.translate(side ? off.x - 1 : off.x - 0.5, (side ? off.y : off.y) - 2 - (working ? 2 : 0));
        ctx.beginPath(); ctx.moveTo(-4, -4); ctx.lineTo(4, -4); ctx.quadraticCurveTo(4.4, 2, 0, 6); ctx.quadraticCurveTo(-4.4, 2, -4, -4);
        fillLine(ctx, hgrad(ctx, -4, 4, light(look.accent, 0.15), dark(look.accent, 0.25)), INK, 0.7);
        ctx.strokeStyle = "#e2b84a"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(-3.4, -3.4); ctx.lineTo(3.4, -3.4); ctx.quadraticCurveTo(3.8, 1.8, 0, 5.2); ctx.quadraticCurveTo(-3.8, 1.8, -3.4, -3.4); ctx.stroke();
        ctx.fillStyle = "#f2c14e"; star(ctx, 0, 0, 1.8);
        ctx.restore();
      }
      break;
    }
    case "mage": case "cleric": {
      const x = hand.x + (side ? -0.5 : 0.6);
      const top = working ? hand.y - 15 : hand.y - 12;
      limb(ctx, x, top, x + (side ? 0.5 : 0), hand.y + 9, 1.3, "#8a5a34");
      if (look.kind === "mage") {
        const glow = 0.5 + 0.5 * Math.sin(pose.t * 4 + pose.seed);
        const g = ctx.createRadialGradient(x, top - 2, 0, x, top - 2, working ? 7 : 4.5);
        g.addColorStop(0, `rgba(160,230,255,${0.55 + glow * 0.3})`); g.addColorStop(1, "rgba(160,230,255,0)");
        ctx.fillStyle = g; ell(ctx, x, top - 2, working ? 7 : 4.5, working ? 7 : 4.5); ctx.fill();
        ell(ctx, x, top - 2, 2.2, 2.2); fillLine(ctx, (() => { const o = ctx.createRadialGradient(x - 0.7, top - 2.7, 0.2, x, top - 2, 2.4); o.addColorStop(0, "#ffffff"); o.addColorStop(1, "#5cc8f0"); return o; })(), INK, 0.6);
        ctx.strokeStyle = "#8a5a34"; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.arc(x, top - 2, 2.8, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      } else {
        ctx.fillStyle = "#e2b84a"; ctx.strokeStyle = INK; ctx.lineWidth = 0.5;
        rr(ctx, x - 0.8, top - 6, 1.6, 6.5, 0.5); ctx.fill(); ctx.stroke(); rr(ctx, x - 2.8, top - 4.4, 5.6, 1.6, 0.5); ctx.fill(); ctx.stroke();
        if (working) { ctx.strokeStyle = "rgba(255,230,140,0.8)"; ctx.lineWidth = 0.7; ell(ctx, x, top - 3.5, 4.5 + Math.sin(pose.t * 4) * 0.4, 1.5); ctx.stroke(); }
      }
      break;
    }
    case "scribe": {
      if (dir === 3) break;
      const open = working;
      ctx.save(); ctx.translate(side ? hand.x - 2 : off.x + 1, (side ? hand.y : off.y) - 1);
      if (open) { ctx.beginPath(); ctx.moveTo(-4.5, -1); ctx.quadraticCurveTo(-2, -2.4, 0, -1); ctx.quadraticCurveTo(2, -2.4, 4.5, -1); ctx.lineTo(4.5, 3); ctx.quadraticCurveTo(2, 1.8, 0, 3); ctx.quadraticCurveTo(-2, 1.8, -4.5, 3); ctx.closePath(); fillLine(ctx, "#fbf5e6"); ctx.strokeStyle = "#b9ad90"; ctx.lineWidth = 0.4; for (let i = 0; i < 3; i += 1) { ctx.beginPath(); ctx.moveTo(-3.6, 0.2 + i); ctx.lineTo(-1, 0.2 + i); ctx.moveTo(1, 0.2 + i); ctx.lineTo(3.6, 0.2 + i); ctx.stroke(); } }
      else { rr(ctx, -2.6, -3.4, 5.2, 6.4, 0.8); fillLine(ctx, "#8e2f3a"); ctx.fillStyle = "#e2b84a"; ctx.fillRect(-0.4, -3.4, 0.8, 6.4); }
      ctx.restore();
      if (!side) { ctx.save(); ctx.translate(hand.x, hand.y); ctx.rotate(-0.6); ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(2.4, -5, 1, -9); ctx.quadraticCurveTo(-0.6, -4, 0, 0); fillLine(ctx, "#f4ecd8", INK, 0.4); ctx.restore(); }
      break;
    }
    case "builder": {
      const a = angleOf(hand);
      ctx.save(); ctx.translate(hand.x, hand.y); ctx.rotate(a - Math.PI / 2 + (side ? Math.PI : 0) * 0);
      limb(ctx, 0, -1.5, 0, 6.5, 1.3, "#9c6b3f");
      rr(ctx, -3.2, 5.4, 6.4, 2.8, 0.6); fillLine(ctx, hgrad(ctx, -3, 3, "#d6dbe5", "#7d869a"), INK, 0.5);
      ctx.restore();
      break;
    }
    case "ranger": {
      ctx.save(); ctx.translate(side ? hand.x - 0.5 : off.x - 0.5, side ? hand.y : off.y);
      const draw = working ? 1.6 + Math.sin(pose.t * 3) * 0.6 : 0;
      ctx.strokeStyle = "#7a4f2c"; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(1.5, 0, 6.5, Math.PI * 0.62, Math.PI * 1.38); ctx.stroke();
      ctx.strokeStyle = "#efe7d2"; ctx.lineWidth = 0.4; ctx.beginPath(); ctx.moveTo(-3.2, -4.9); ctx.lineTo(-3.2 + draw * 1.4, 0); ctx.lineTo(-3.2, 4.9); ctx.stroke();
      ctx.restore();
      if (dir !== 0) { ctx.save(); ctx.translate(side ? 3.5 : 2.5, -16); ctx.rotate(0.3); rr(ctx, -1.4, -2, 2.8, 8, 0.8); fillLine(ctx, "#6b4426"); ctx.fillStyle = "#c0392b"; for (const x of [-0.8, 0.8]) { ctx.beginPath(); ctx.moveTo(x, -2); ctx.lineTo(x - 0.8, -4); ctx.lineTo(x + 0.8, -4); ctx.fill(); } ctx.restore(); }
      break;
    }
  }
}

// ——— Scenery ———

const GRASS = "#7cc45a";
/** The ground: soft grass, dirt roads with grassy edges, the plaza's cobbles and the fences, painted once. */
export function paintGround(map: Layout): HTMLCanvasElement {
  const c = canvas(map.w * TILE * GROUND_RES, map.h * TILE * GROUND_RES);
  const ctx = ctxOf(c);
  ctx.scale(GROUND_RES, GROUND_RES);
  const random = seeded(7);
  const g = (x: number, y: number): Ground | undefined => (x < 0 || y < 0 || x >= map.w || y >= map.h ? undefined : map.ground[y * map.w + x]);
  ctx.fillStyle = GRASS; ctx.fillRect(0, 0, map.w * TILE, map.h * TILE);
  // Large soft patches of light and shade in the grass.
  for (let n = 0; n < map.w * map.h * 0.08; n += 1) {
    const x = random() * map.w * TILE; const y = random() * map.h * TILE; const r = 10 + random() * 26;
    const grd = ctx.createRadialGradient(x, y, 0, x, y, r); const tone = random() < 0.5 ? "rgba(70,140,50,0.22)" : "rgba(170,225,120,0.2)";
    grd.addColorStop(0, tone); grd.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = grd; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Roads and paths, with rounded, soft edges.
  for (let ty = 0; ty < map.h; ty += 1) for (let tx = 0; tx < map.w; tx += 1) {
    const kind = g(tx, ty);
    if (kind !== "road" && kind !== "path") continue;
    ctx.fillStyle = kind === "road" ? "#d6b37a" : "#e2c693";
    ctx.fillRect(tx * TILE - 0.5, ty * TILE - 0.5, TILE + 1, TILE + 1);
  }
  for (let ty = 0; ty < map.h; ty += 1) for (let tx = 0; tx < map.w; tx += 1) {
    const kind = g(tx, ty);
    if (kind === "road" || kind === "path") {
      for (let n = 0; n < 4; n += 1) { ell(ctx, tx * TILE + random() * 16, ty * TILE + random() * 16, 0.6 + random() * 1.2, 0.5 + random() * 0.8); ctx.fillStyle = random() < 0.5 ? "rgba(140,105,60,0.35)" : "rgba(255,240,210,0.35)"; ctx.fill(); }
      // Grass creeping over the edge.
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        if (g(tx + dx, ty + dy) !== "grass") continue;
        for (let i = 0; i < 6; i += 1) {
          const along = random() * 16;
          const x = dx === 0 ? tx * TILE + along : tx * TILE + (dx < 0 ? 0 : 16);
          const y = dy === 0 ? ty * TILE + along : ty * TILE + (dy < 0 ? 0 : 16);
          ell(ctx, x, y, 1.6 + random() * 1.6, 1.2 + random() * 1.4); ctx.fillStyle = random() < 0.5 ? "#6fb74e" : GRASS; ctx.fill();
        }
      }
    } else if (kind === "stone") {
      ctx.fillStyle = "#b4aec3"; ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      for (let sy = 0; sy < 3; sy += 1) for (let sx = 0; sx < 3; sx += 1) {
        const x = tx * TILE + sx * 5.4 + (sy % 2) * 2.4 + random() * 0.6;
        const y = ty * TILE + sy * 5.4 + random() * 0.6;
        rr(ctx, x + 0.4, y + 0.4, 4.6, 4.6, 1.6);
        const shade = ["#cbc6d8", "#c2bdd1", "#d4cfe0", "#bdb8cc"][Math.floor(random() * 4)] as string;
        ctx.fillStyle = vgrad(ctx, y, y + 5, light(shade, 0.15), dark(shade, 0.08)); ctx.fill();
      }
    } else {
      for (let n = 0; n < 7; n += 1) {
        const x = tx * TILE + random() * 16; const y = ty * TILE + random() * 16;
        ctx.strokeStyle = random() < 0.5 ? "#5fa646" : "#9ad574"; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 0.6, y - 1.5, x + (random() - 0.5) * 2, y - 2.6); ctx.stroke();
      }
      if (random() < 0.05) { const x = tx * TILE + 4 + random() * 8; const y = ty * TILE + 4 + random() * 8; ctx.fillStyle = ["#ffffff", "#ffe066", "#ff9ec7", "#b3a1ff"][Math.floor(random() * 4)] as string; for (let i = 0; i < 5; i += 1) { ell(ctx, x + Math.cos(i * 1.256) * 0.9, y + Math.sin(i * 1.256) * 0.9, 0.7, 0.7); ctx.fill(); } ell(ctx, x, y, 0.5, 0.5); ctx.fillStyle = "#f5b400"; ctx.fill(); }
    }
  }
  // Fences: posts with rounded tops, two rails.
  for (const fence of map.fences) {
    const x0 = fence.x * TILE;
    const y0 = fence.y * TILE;
    ctx.fillStyle = "rgba(0,0,0,0.13)"; ell(ctx, x0 + 8, y0 + 13, 8, 1.6); ctx.fill();
    if (fence.side === "h") {
      for (const y of [5.5, 9.5]) { rr(ctx, x0 - 0.5, y0 + y, TILE + 1, 1.8, 0.8); fillLine(ctx, vgrad(ctx, y0 + y, y0 + y + 2, "#c08a55", "#8a5a34"), "#5a3a22", 0.4); }
      rr(ctx, x0 + 1.5, y0 + 2, 3, 11.5, 1.4); fillLine(ctx, hgrad(ctx, x0 + 1.5, x0 + 4.5, "#c79a68", "#7a4f2c"), "#4a2f1c", 0.5);
    } else {
      rr(ctx, x0 + 6.4, y0 - 0.5, 2.2, TILE + 1, 1); fillLine(ctx, hgrad(ctx, x0 + 6.4, x0 + 8.6, "#c08a55", "#8a5a34"), "#5a3a22", 0.4);
      rr(ctx, x0 + 5.5, y0 + 2, 4, 4, 1.6); fillLine(ctx, "#a7744a", "#4a2f1c", 0.5);
    }
  }
  return c;
}
export const GROUND_SCALE = GROUND_RES;

const ROOFS = ["#c0453b", "#2e7fc1", "#8e4fb8", "#d68910", "#2e8a4e", "#17a589", "#b8478a"] as const;
export const roofOf = (name: string): string => ROOFS[hashOf(name) % ROOFS.length] as string;

export interface Art { readonly image: HTMLCanvasElement; readonly width: number; readonly height: number; readonly windows: ReadonlyArray<{ x: number; y: number }>; readonly flags: ReadonlyArray<{ x: number; y: number }>; readonly chimney: { x: number; y: number } | null }
const paint = (w: number, h: number, draw: (ctx: Ctx) => void): HTMLCanvasElement => { const c = canvas(w * RES, h * RES); const ctx = ctxOf(c); ctx.scale(RES, RES); ctx.lineJoin = "round"; draw(ctx); return c; };

function window_(ctx: Ctx, x: number, y: number, w: number, h: number, lit: boolean, shutter: string): void {
  rr(ctx, x - 3, y, 3, h, 0.6); fillLine(ctx, shutter, INK, 0.5); rr(ctx, x + w, y, 3, h, 0.6); fillLine(ctx, shutter, INK, 0.5);
  rr(ctx, x - 0.8, y - 0.8, w + 1.6, h + 1.6, 1.2); fillLine(ctx, "#5a3a22");
  const glass = lit ? (() => { const gg = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, w); gg.addColorStop(0, "#fff3b8"); gg.addColorStop(1, "#ffc94a"); return gg; })() : vgrad(ctx, y, y + h, "#a9c3ea", "#4f6797");
  rr(ctx, x, y, w, h, 0.8); ctx.fillStyle = glass; ctx.fill();
  if (!lit) { ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath(); ctx.moveTo(x + 1, y + h - 2); ctx.lineTo(x + 4, y + 1); ctx.lineTo(x + 6, y + 1); ctx.lineTo(x + 3, y + h - 2); ctx.fill(); }
  ctx.fillStyle = "#5a3a22"; ctx.fillRect(x + w / 2 - 0.6, y, 1.2, h); ctx.fillRect(x, y + h / 2 - 0.6, w, 1.2);
  rr(ctx, x - 2, y + h + 0.8, w + 4, 3, 0.8); fillLine(ctx, "#8a5a34", INK, 0.5);
  for (let i = 0; i < 6; i += 1) { ell(ctx, x - 0.8 + i * ((w + 1.6) / 5), y + h + 0.6 - (i % 2) * 0.8, 1.2, 1.2); ctx.fillStyle = ["#e74c3c", "#ffd23f", "#ff8fc0", "#ffffff"][i % 4] as string; ctx.fill(); }
}

const arts = new Map<string, Art>();
/** A timber-framed cottage `w` tiles wide, its roof two tiles above the footprint. */
export function paintCottage(name: string, w: number, h: number, lit: boolean): Art {
  const key = `c|${name}|${w}|${h}|${lit}`;
  const known = arts.get(key);
  if (known) return known;
  const W = w * TILE;
  const top = 2.5 * TILE;
  const H = h * TILE + top;
  const roof = roofOf(name);
  const wallTop = top + 18;
  const wallBottom = H - 7;
  const windows: Array<{ x: number; y: number }> = [];
  const image = paint(W, H, (ctx) => {
    // Walls: plaster with timber, lit from the left.
    rr(ctx, 6, wallTop, W - 12, wallBottom - wallTop + 2, 1); fillLine(ctx, hgrad(ctx, 6, W - 6, "#f6ead0", "#dccaa3"));
    ctx.fillStyle = "#7a4f2c";
    for (const x of [6, W * 0.32, W * 0.68 - 3, W - 9]) ctx.fillRect(x, wallTop, 3, wallBottom - wallTop);
    ctx.fillRect(6, wallTop + 21, W - 12, 2.4);
    ctx.save(); ctx.strokeStyle = "#7a4f2c"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(9, wallTop + 2); ctx.lineTo(W * 0.32, wallTop + 20); ctx.moveTo(W - 9, wallTop + 2); ctx.lineTo(W * 0.68, wallTop + 20); ctx.stroke(); ctx.restore();
    // Stone footing.
    for (let x = 3; x < W - 3; x += 7) { rr(ctx, x, wallBottom - 1, 6.6, 4.4, 1.6); fillLine(ctx, vgrad(ctx, wallBottom, wallBottom + 4, "#c9c4d6", "#8f8aa0"), "#5d5870", 0.4); rr(ctx, x + 3.5, wallBottom + 3.2, 6.6, 3.6, 1.6); fillLine(ctx, vgrad(ctx, wallBottom + 3, wallBottom + 7, "#bab5c8", "#827d93"), "#5d5870", 0.4); }
    // Roof: a gable of rounded shingles, light at the ridge.
    const eaves = wallTop + 6;
    ctx.beginPath(); ctx.moveTo(W * 0.2, 6); ctx.lineTo(W * 0.8, 6); ctx.lineTo(W + 1, eaves); ctx.lineTo(-1, eaves); ctx.closePath();
    fillLine(ctx, vgrad(ctx, 6, eaves, light(roof, 0.12), dark(roof, 0.18)), INK, 0.8);
    ctx.save(); ctx.clip();
    for (let y = 9, row = 0; y < eaves + 4; y += 4.2, row += 1) {
      for (let x = (row % 2) * 3.5 - 4; x < W + 4; x += 7) { ctx.beginPath(); ctx.arc(x + 3.5, y, 3.5, 0, Math.PI); ctx.strokeStyle = dark(roof, 0.28); ctx.lineWidth = 0.6; ctx.stroke(); }
    }
    ctx.restore();
    rr(ctx, W * 0.2 - 1, 4, W * 0.6 + 2, 3.4, 1.6); fillLine(ctx, dark(roof, 0.3));
    rr(ctx, -2, eaves - 1, W + 4, 3, 1.4); fillLine(ctx, dark(roof, 0.35));
    // Chimney.
    rr(ctx, W - 30, -1, 9, 18, 1); fillLine(ctx, hgrad(ctx, W - 30, W - 21, "#b6b1c4", "#7d7890"));
    rr(ctx, W - 31.5, -2, 12, 3.4, 1); fillLine(ctx, "#6d687c");
    // Door with an arch, iron hinges and a lantern.
    const dx = W / 2 - 8;
    const dTop = wallBottom - 28;
    ctx.beginPath(); ctx.moveTo(dx - 2, wallBottom); ctx.lineTo(dx - 2, dTop + 6); ctx.arc(dx + 8, dTop + 6, 10, Math.PI, 0); ctx.lineTo(dx + 18, wallBottom); ctx.closePath(); fillLine(ctx, "#8e8aa0");
    ctx.beginPath(); ctx.moveTo(dx, wallBottom); ctx.lineTo(dx, dTop + 6); ctx.arc(dx + 8, dTop + 6, 8, Math.PI, 0); ctx.lineTo(dx + 16, wallBottom); ctx.closePath(); fillLine(ctx, hgrad(ctx, dx, dx + 16, "#8a5a34", "#5e3a1f"));
    ctx.strokeStyle = "#4a2f1c"; ctx.lineWidth = 0.6; for (const x of [dx + 4, dx + 8, dx + 12]) { ctx.beginPath(); ctx.moveTo(x, dTop + 1); ctx.lineTo(x, wallBottom); ctx.stroke(); }
    ctx.fillStyle = "#3b2a20"; ctx.fillRect(dx + 1, dTop + 9, 6, 1.2); ctx.fillRect(dx + 1, wallBottom - 7, 6, 1.2);
    ell(ctx, dx + 13, wallBottom - 13, 1, 1); fillLine(ctx, "#f2c14e", INK, 0.4);
    rr(ctx, dx - 4, wallBottom - 0.5, 24, 4, 1.6); fillLine(ctx, "#b5b0c4", "#5d5870", 0.4);
    rr(ctx, dx + 20, dTop + 3, 4, 6, 1.2); fillLine(ctx, lit ? "#ffd866" : "#5a5470"); ctx.fillStyle = "#2b2b38"; ctx.fillRect(dx + 21.4, dTop, 1.2, 3);
    for (const wx of [W * 0.13, W * 0.87 - 15]) { window_(ctx, wx, wallTop + 4, 15, 13, lit, roof); windows.push({ x: wx + 7.5, y: wallTop + 10 }); }
    // A little ivy by the door.
    ctx.fillStyle = "#3f8f3f"; for (let i = 0; i < 9; i += 1) { ell(ctx, dx - 4 + Math.sin(i) * 1.5, wallBottom - 4 - i * 2.4, 1.6, 1.2); ctx.fill(); }
  });
  const art: Art = { image, width: W, height: H, windows, flags: [], chimney: { x: W - 25.5, y: -2 } };
  arts.set(key, art);
  return art;
}

/** A castle for a platform workspace: two round towers with pointed roofs, battlements, a gate and banners. */
export function paintCastle(name: string, w: number, h: number, lit: boolean): Art {
  const key = `k|${name}|${w}|${h}|${lit}`;
  const known = arts.get(key);
  if (known) return known;
  const W = w * TILE;
  const top = 3.5 * TILE;
  const H = h * TILE + top;
  const roof = roofOf(name);
  const towerW = 34;
  const keepTop = top + 18;
  const windows: Array<{ x: number; y: number }> = [];
  const stone = (ctx: Ctx, x: number, y: number, ww: number, hh: number, base: string): void => {
    rr(ctx, x, y, ww, hh, 1.5); fillLine(ctx, hgrad(ctx, x, x + ww, light(base, 0.12), dark(base, 0.15)));
    ctx.save(); rr(ctx, x, y, ww, hh, 1.5); ctx.clip();
    ctx.strokeStyle = dark(base, 0.22); ctx.lineWidth = 0.5;
    for (let yy = y + 5, row = 0; yy < y + hh; yy += 5, row += 1) { ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + ww, yy); ctx.stroke(); for (let xx = x + (row % 2) * 4.5; xx < x + ww; xx += 9) { ctx.beginPath(); ctx.moveTo(xx, yy - 5); ctx.lineTo(xx, yy); ctx.stroke(); } }
    ctx.restore();
  };
  const image = paint(W, H, (ctx) => {
    stone(ctx, towerW - 6, keepTop, W - towerW * 2 + 12, H - keepTop - 1, "#cdc8db");
    for (let x = towerW - 6; x < W - towerW + 4; x += 9) stone(ctx, x, keepTop - 6, 6, 7, "#cdc8db");
    for (const tx of [0, W - towerW]) {
      stone(ctx, tx, top, towerW, H - top - 1, "#bdb8cd");
      for (let x = tx; x < tx + towerW - 2; x += 8.5) stone(ctx, x, top - 6, 5.5, 7, "#bdb8cd");
      ctx.beginPath(); ctx.moveTo(tx - 2, top - 5); ctx.quadraticCurveTo(tx + towerW / 2, top - 14, tx + towerW / 2, 4); ctx.quadraticCurveTo(tx + towerW / 2, top - 14, tx + towerW + 2, top - 5); ctx.closePath();
      fillLine(ctx, hgrad(ctx, tx, tx + towerW, light(roof, 0.18), dark(roof, 0.28)), INK, 0.8);
      ctx.save(); ctx.clip(); ctx.strokeStyle = dark(roof, 0.3); ctx.lineWidth = 0.5; for (let y = 10; y < top; y += 4) { ctx.beginPath(); ctx.moveTo(tx - 4, y); ctx.lineTo(tx + towerW + 4, y); ctx.stroke(); } ctx.restore();
      for (const wy of [top + 14, top + 38]) {
        ctx.beginPath(); ctx.moveTo(tx + towerW / 2 - 3.5, wy + 10); ctx.lineTo(tx + towerW / 2 - 3.5, wy + 3); ctx.arc(tx + towerW / 2, wy + 3, 3.5, Math.PI, 0); ctx.lineTo(tx + towerW / 2 + 3.5, wy + 10); ctx.closePath();
        fillLine(ctx, lit ? "#ffd866" : "#3a3550"); windows.push({ x: tx + towerW / 2, y: wy + 6 });
      }
    }
    // Gate with a portcullis.
    const gx = W / 2 - 14;
    ctx.beginPath(); ctx.moveTo(gx - 3, H); ctx.lineTo(gx - 3, H - 28); ctx.arc(W / 2, H - 28, 17, Math.PI, 0); ctx.lineTo(gx + 31, H); ctx.closePath(); fillLine(ctx, "#a29db4");
    ctx.beginPath(); ctx.moveTo(gx, H); ctx.lineTo(gx, H - 28); ctx.arc(W / 2, H - 28, 14, Math.PI, 0); ctx.lineTo(gx + 28, H); ctx.closePath(); fillLine(ctx, "#241e33");
    ctx.save(); ctx.clip(); ctx.strokeStyle = "#7d7890"; ctx.lineWidth = 1; for (let x = gx + 3; x < gx + 28; x += 5) { ctx.beginPath(); ctx.moveTo(x, H - 44); ctx.lineTo(x, H - 12); ctx.stroke(); } for (let y = H - 40; y < H - 12; y += 5) { ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + 28, y); ctx.stroke(); } ctx.restore();
    // Banners.
    for (const bx of [gx - 22, gx + 38]) {
      rr(ctx, bx - 1.5, keepTop + 7, 15, 2.4, 1); fillLine(ctx, "#5a3a22");
      ctx.beginPath(); ctx.moveTo(bx, keepTop + 9); ctx.lineTo(bx + 12, keepTop + 9); ctx.lineTo(bx + 12, keepTop + 36); ctx.lineTo(bx + 6, keepTop + 32); ctx.lineTo(bx, keepTop + 36); ctx.closePath();
      fillLine(ctx, hgrad(ctx, bx, bx + 12, light(roof, 0.1), dark(roof, 0.2)));
      ctx.fillStyle = "#f2c14e"; star(ctx, bx + 6, keepTop + 18, 3.2);
    }
    ell(ctx, W / 2, keepTop + 11, 5, 5); fillLine(ctx, lit ? "#ffd866" : "#3a3550"); windows.push({ x: W / 2, y: keepTop + 11 });
    ctx.strokeStyle = "#5a3a22"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(W / 2 - 5, keepTop + 11); ctx.lineTo(W / 2 + 5, keepTop + 11); ctx.moveTo(W / 2, keepTop + 6); ctx.lineTo(W / 2, keepTop + 16); ctx.stroke();
  });
  const art: Art = { image, width: W, height: H, windows, flags: [{ x: towerW / 2, y: 4 }, { x: W - towerW / 2, y: 4 }], chimney: null };
  arts.set(key, art);
  return art;
}

interface PropArt { readonly image: HTMLCanvasElement; readonly width: number; readonly height: number }
const propArts = new Map<string, PropArt>();
/** A piece of scenery, painted once; it stands on the bottom of its picture. */
export function paintProp(prop: Prop): PropArt {
  const key = `${prop.kind}|${prop.seed % 5}`;
  const known = propArts.get(key);
  if (known) return known;
  const random = seeded(prop.seed % 5 + 11);
  const make = (w: number, h: number, draw: (ctx: Ctx) => void): PropArt => ({ image: paint(w, h, draw), width: w, height: h });
  let art: PropArt;
  switch (prop.kind) {
    case "tree": {
      const leaf = ["#3f8f3f", "#4a9a45", "#2f7f3a", "#579c3c", "#3d8a55"][prop.seed % 5] as string;
      const fruit = prop.seed % 3 === 0;
      art = make(36, 48, (ctx) => {
        ctx.fillStyle = "rgba(0,0,0,0.18)"; ell(ctx, 18, 45, 13, 3); ctx.fill();
        ctx.beginPath(); ctx.moveTo(14, 46); ctx.quadraticCurveTo(16, 36, 15.5, 28); ctx.lineTo(20.5, 28); ctx.quadraticCurveTo(20, 36, 22, 46); ctx.closePath(); fillLine(ctx, hgrad(ctx, 14, 22, "#a7744a", "#6b4426"));
        const blobs: Array<[number, number, number]> = [[18, 22, 13], [10, 20, 8.5], [26, 20, 8.5], [14, 12, 9], [23, 12, 8.5], [18, 7, 7.5]];
        for (const [x, y, r] of blobs) { ell(ctx, x, y, r, r * 0.92); ctx.fillStyle = dark(leaf, 0.25); ctx.fill(); }
        for (const [x, y, r] of blobs) { ell(ctx, x - 1, y - 1, r * 0.92, r * 0.85); const gr = ctx.createRadialGradient(x - r * 0.4, y - r * 0.5, 0, x, y, r); gr.addColorStop(0, light(leaf, 0.3)); gr.addColorStop(1, leaf); ctx.fillStyle = gr; ctx.fill(); }
        ctx.strokeStyle = dark(leaf, 0.45); ctx.lineWidth = 0.8; ell(ctx, 18, 20, 16.5, 16); ctx.globalAlpha = 0.0; ctx.stroke(); ctx.globalAlpha = 1;
        for (let n = 0; n < 16; n += 1) { ell(ctx, 6 + random() * 24, 4 + random() * 26, 1.2, 0.8); ctx.fillStyle = n % 2 ? light(leaf, 0.4) : dark(leaf, 0.3); ctx.fill(); }
        if (fruit) for (let n = 0; n < 5; n += 1) { ell(ctx, 8 + random() * 20, 10 + random() * 18, 1.4, 1.4); fillLine(ctx, "#e74c3c", "#8e1d1d", 0.4); }
      });
      break;
    }
    case "bush": art = make(18, 14, (ctx) => { ctx.fillStyle = "rgba(0,0,0,0.15)"; ell(ctx, 9, 12.5, 8, 1.6); ctx.fill(); for (const [x, y, r] of [[6, 8, 5], [12, 8, 5], [9, 5, 5]] as const) { ell(ctx, x, y, r, r * 0.85); const gr = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, r); gr.addColorStop(0, "#7cc45a"); gr.addColorStop(1, "#3f8f3f"); ctx.fillStyle = gr; ctx.fill(); } for (const [x, y, c] of [[5, 7, "#ffd23f"], [11, 5, "#ff8fc0"], [13, 9, "#ffffff"]] as const) { ell(ctx, x, y, 1.1, 1.1); ctx.fillStyle = c; ctx.fill(); } }); break;
    case "rock": art = make(16, 12, (ctx) => { ctx.fillStyle = "rgba(0,0,0,0.15)"; ell(ctx, 8, 10.5, 7, 1.5); ctx.fill(); ctx.beginPath(); ctx.moveTo(2, 10); ctx.quadraticCurveTo(1, 4, 6, 2.5); ctx.quadraticCurveTo(12, 1.5, 14, 6); ctx.quadraticCurveTo(15, 10, 12, 10.5); ctx.closePath(); fillLine(ctx, vgrad(ctx, 2, 10, "#cbc6d8", "#7d7890")); ctx.fillStyle = "rgba(255,255,255,0.5)"; ell(ctx, 6, 4.5, 2, 0.8); ctx.fill(); ctx.fillStyle = "#6bb04a"; ell(ctx, 11, 9.5, 2.5, 1); ctx.fill(); }); break;
    case "stump": art = make(16, 12, (ctx) => { ctx.fillStyle = "rgba(0,0,0,0.15)"; ell(ctx, 8, 10.5, 7, 1.5); ctx.fill(); rr(ctx, 3, 4, 10, 6.5, 2); fillLine(ctx, hgrad(ctx, 3, 13, "#9c6b3f", "#5e3a1f")); ell(ctx, 8, 4, 5, 2); fillLine(ctx, "#d9b27a"); ctx.strokeStyle = "#a7744a"; ctx.lineWidth = 0.4; ell(ctx, 8, 4, 3, 1.1); ctx.stroke(); }); break;
    case "flowers": art = make(16, 10, (ctx) => { for (let n = 0; n < 5; n += 1) { const x = 2 + n * 3; ctx.strokeStyle = "#3f8f3f"; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(x, 9.5); ctx.quadraticCurveTo(x + 0.5, 6, x, 3.5); ctx.stroke(); ctx.fillStyle = ["#e74c3c", "#ffd23f", "#ff8fc0", "#a98bff", "#ffffff"][n] as string; for (let i = 0; i < 5; i += 1) { ell(ctx, x + Math.cos(i * 1.256) * 1, 3 + (n % 2) + Math.sin(i * 1.256) * 1, 0.8, 0.8); ctx.fill(); } ell(ctx, x, 3 + (n % 2), 0.5, 0.5); ctx.fillStyle = "#f5b400"; ctx.fill(); } }); break;
    case "lamp": art = make(12, 36, (ctx) => { ctx.fillStyle = "rgba(0,0,0,0.18)"; ell(ctx, 6, 34.5, 4.5, 1.2); ctx.fill(); rr(ctx, 5, 9, 2, 25, 0.8); fillLine(ctx, "#2b2b38", "#15121e", 0.4); rr(ctx, 3, 32, 6, 3, 1); fillLine(ctx, "#2b2b38"); ctx.beginPath(); ctx.moveTo(2, 9); ctx.lineTo(10, 9); ctx.lineTo(9, 2.5); ctx.lineTo(3, 2.5); ctx.closePath(); fillLine(ctx, "#2b2b38"); rr(ctx, 3.6, 3.5, 4.8, 4.8, 0.6); const gg = ctx.createRadialGradient(6, 6, 0, 6, 6, 3.5); gg.addColorStop(0, "#fff6c4"); gg.addColorStop(1, "#ffc94a"); ctx.fillStyle = gg; ctx.fill(); ctx.beginPath(); ctx.moveTo(2, 2.5); ctx.lineTo(6, -0.5); ctx.lineTo(10, 2.5); ctx.closePath(); fillLine(ctx, "#2b2b38"); }); break;
    case "board": art = make(34, 32, (ctx) => { ctx.fillStyle = "rgba(0,0,0,0.18)"; ell(ctx, 17, 30.5, 14, 2); ctx.fill(); for (const x of [4, 27]) { rr(ctx, x, 10, 3, 21, 1); fillLine(ctx, hgrad(ctx, x, x + 3, "#a7744a", "#6b4426")); } rr(ctx, 1, 4, 32, 18, 2); fillLine(ctx, hgrad(ctx, 1, 33, "#b98552", "#8a5a34")); rr(ctx, 3, 6, 28, 14, 1.4); fillLine(ctx, "#7a4f2c", "#4a2f1c", 0.5); ctx.beginPath(); ctx.moveTo(-1, 5); ctx.lineTo(17, -0.5); ctx.lineTo(35, 5); ctx.closePath(); fillLine(ctx, "#c0453b"); }); break;
    case "bench": art = make(32, 14, (ctx) => { ctx.fillStyle = "rgba(0,0,0,0.15)"; ell(ctx, 16, 13, 15, 1.5); ctx.fill(); rr(ctx, 1, 1.5, 30, 3, 1.2); fillLine(ctx, "#b98552"); rr(ctx, 0, 6, 32, 3.4, 1.2); fillLine(ctx, "#c99560"); for (const x of [3, 27]) { rr(ctx, x, 9, 2, 4.5, 0.6); fillLine(ctx, "#2b2b38"); } }); break;
    case "well": art = make(32, 36, (ctx) => { ctx.fillStyle = "rgba(0,0,0,0.18)"; ell(ctx, 16, 33.5, 15, 2.4); ctx.fill(); rr(ctx, 2, 20, 28, 13, 3); fillLine(ctx, hgrad(ctx, 2, 30, "#cbc6d8", "#8f8aa0")); ell(ctx, 16, 20.5, 13, 3.2); fillLine(ctx, "#a29db4"); ell(ctx, 16, 20.8, 10, 2.2); ctx.fillStyle = "#2d4a7a"; ctx.fill(); for (const x of [4, 26]) { rr(ctx, x, 5, 2.4, 16, 0.8); fillLine(ctx, "#7a4f2c"); } ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(16, -0.5); ctx.lineTo(32, 6); ctx.lineTo(29, 7.5); ctx.lineTo(3, 7.5); ctx.closePath(); fillLine(ctx, "#c0453b"); rr(ctx, 14.5, 9, 3, 5, 1); fillLine(ctx, "#8a5a34"); }); break;
    case "fountain": art = make(64, 52, (ctx) => {
      ctx.fillStyle = "rgba(0,0,0,0.15)"; ell(ctx, 32, 46, 31, 5); ctx.fill();
      ell(ctx, 32, 32, 31, 15); fillLine(ctx, hgrad(ctx, 1, 63, "#d9d4e6", "#8f8aa0"));
      ell(ctx, 32, 30, 27, 11.5); const water = ctx.createRadialGradient(28, 26, 2, 32, 30, 28); water.addColorStop(0, "#9ed4ff"); water.addColorStop(1, "#3d7fc4"); ctx.fillStyle = water; ctx.fill();
      rr(ctx, 28.5, 12, 7, 19, 2); fillLine(ctx, hgrad(ctx, 28, 36, "#e6e1f0", "#a29db4"));
      ell(ctx, 32, 12, 10, 3.6); fillLine(ctx, hgrad(ctx, 22, 42, "#e6e1f0", "#a29db4")); ell(ctx, 32, 11.6, 8, 2.4); ctx.fillStyle = "#7fc0f5"; ctx.fill();
    }); break;
    case "pond": art = make(112, 64, (ctx) => {
      ell(ctx, 56, 32, 55, 31); ctx.fillStyle = "#6bb04a"; ctx.fill();
      ell(ctx, 56, 32, 51, 27); fillLine(ctx, "#8a7a5a", "#5a4a32", 0.6);
      ell(ctx, 56, 32, 48, 24); const w = ctx.createRadialGradient(46, 24, 4, 56, 32, 50); w.addColorStop(0, "#8fd0ff"); w.addColorStop(1, "#2f6fb4"); ctx.fillStyle = w; ctx.fill();
      for (let n = 0; n < 6; n += 1) { const x = 22 + random() * 66; const y = 16 + random() * 30; ctx.beginPath(); ctx.arc(x, y, 3.2, 0.3, Math.PI * 2 - 0.3); ctx.lineTo(x, y); ctx.closePath(); ctx.fillStyle = "#4fa64a"; ctx.fill(); if (n % 2 === 0) { ell(ctx, x + 1, y - 1, 1.2, 1.2); ctx.fillStyle = "#ffb3d1"; ctx.fill(); } }
      for (let n = 0; n < 10; n += 1) { const x = 8 + random() * 96; const y = n % 2 ? 8 + random() * 6 : 50 + random() * 6; ctx.strokeStyle = "#2f7f3a"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.quadraticCurveTo(x + 1, y + 2, x - 0.5, y - 3); ctx.stroke(); rr(ctx, x - 1, y - 4, 2, 4, 1); ctx.fillStyle = "#7a4f2c"; ctx.fill(); }
    }); break;
  }
  propArts.set(key, art);
  return art;
}

/** A speech bubble with a sign in it, above a character's head; drawn at world size, about 13 by 14. */
export function drawEmote(ctx: Ctx, kind: Emote, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  rr(ctx, -6.5, -12, 13, 11, 4); fillLine(ctx, "#ffffff", INK, 0.8);
  ctx.beginPath(); ctx.moveTo(-1.8, -1.4); ctx.lineTo(0, 1.6); ctx.lineTo(1.8, -1.4); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(-1.8, -1); ctx.lineTo(0, 1.6); ctx.lineTo(1.8, -1); ctx.stroke();
  const ink = kind === "!" ? "#e67e22" : kind === "ok" ? "#2e9a4a" : kind === "no" ? "#d63a3a" : kind === "heart" ? "#e5484d" : kind === "scroll" ? "#8a5a34" : "#3a3550";
  ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineWidth = 1.3; ctx.lineCap = "round";
  switch (kind) {
    case "!": rr(ctx, -0.9, -10, 1.8, 5.4, 0.9); ctx.fill(); ell(ctx, 0, -3.4, 1, 1); ctx.fill(); break;
    case "?": ctx.beginPath(); ctx.arc(0, -7.6, 2, Math.PI * 1.1, Math.PI * 0.4); ctx.lineTo(0, -4.8); ctx.stroke(); ell(ctx, 0, -3, 0.8, 0.8); ctx.fill(); break;
    case "ok": ctx.beginPath(); ctx.moveTo(-3, -6.4); ctx.lineTo(-0.8, -4); ctx.lineTo(3.2, -9); ctx.stroke(); break;
    case "no": ctx.beginPath(); ctx.moveTo(-2.6, -9); ctx.lineTo(2.6, -3.8); ctx.moveTo(2.6, -9); ctx.lineTo(-2.6, -3.8); ctx.stroke(); break;
    case "heart": ctx.beginPath(); ctx.moveTo(0, -3.4); ctx.bezierCurveTo(-5, -6.5, -2.6, -11, 0, -8.2); ctx.bezierCurveTo(2.6, -11, 5, -6.5, 0, -3.4); ctx.fill(); break;
    case "note": ell(ctx, -1.8, -4.4, 1.5, 1.1); ctx.fill(); ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(-0.4, -4.4); ctx.lineTo(-0.4, -10); ctx.quadraticCurveTo(2, -9, 3, -7); ctx.stroke(); break;
    case "zz": ctx.font = "bold 7px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("z", -1.8, -3.6); ctx.font = "bold 5px system-ui, sans-serif"; ctx.fillText("z", 2.4, -6.6); break;
    case "dots": for (const dx of [-3, 0, 3]) { ell(ctx, dx, -6.4, 0.9, 0.9); ctx.fill(); } break;
    case "scroll": rr(ctx, -3.4, -9.6, 6.8, 6.4, 1); ctx.fillStyle = "#f4ecd8"; ctx.fill(); ctx.strokeStyle = "#8a5a34"; ctx.lineWidth = 0.6; ctx.stroke(); ctx.fillStyle = "#c0453b"; ell(ctx, 0, -3.6, 1, 1); ctx.fill(); break;
  }
  ctx.restore();
}
