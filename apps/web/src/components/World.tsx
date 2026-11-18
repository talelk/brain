import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import type { QueueAction } from "@brain/contracts";
import { t, tn } from "../i18n";
import { count, duration } from "../lib/format";
import { classOf, drawEmote, drawHero, GROUND_SCALE, HERO_H, HERO_W, lookOf, paintCastle, paintCottage, paintGround, paintProp, roofOf, type Art, type Class, type Mood } from "../lib/rpg/art";
import { startMusic, type Music } from "../lib/rpg/music";
import { hashOf, layout, reconcile, seeded, step, TILE, walking, type Hero, type Lot } from "../lib/rpg/world";
import { Icon } from "./bits";
import { reduced, visible, watch } from "./LiveParts";

/**
 * The Live screen's village, drawn like a role-playing game seen from above: a cottage per workspace and a castle for a platform
 * workspace around a plaza, a hero for each attempt running now who walks from the notice board to the door and works there, agents
 * that acted lately wandering in their yard, day and night from the clock, weather from how the work goes, fireworks when a goal is
 * done. The canvas is decoration; every word is in the page (signs, speech bubbles, the party list and the panel), so a screen reader
 * and the keyboard reach all of it.
 */

export interface Station {
  readonly slug: string;
  readonly name: string;
  readonly platform: boolean;
  readonly needs: number;
  readonly waiting: number;
  readonly done: number;
  readonly failed: number;
  readonly running: number;
  readonly rate: number | null;
  readonly recent: readonly string[];
}
export interface WorldRun {
  readonly id: string;
  readonly agent: string;
  readonly kind: string;
  readonly slug: string;
  readonly workspace: string;
  readonly goal: string;
  readonly rootId: string;
  readonly href: string;
  readonly doing: readonly QueueAction[];
  readonly startedAt: number | null;
  readonly tokens: number;
}

type Time = "auto" | "day" | "dusk" | "night";
type Weather = "auto" | "clear" | "rain" | "snow";
/** How coarse the picture is: drawn at full resolution, or in pixels of two or three screen points, scaled up without smoothing. */
type Pixels = "smooth" | "soft" | "retro";
const PIXEL: Record<Pixels, number> = { smooth: 0, soft: 2, retro: 3 };
interface Options { time: Time; weather: Weather; names: boolean; bubbles: "all" | "selected"; sound: boolean; music: boolean; effects: boolean; tour: boolean; pixels: Pixels }
const DEFAULTS: Options = { time: "auto", weather: "auto", names: true, bubbles: "all", sound: false, music: false, effects: true, tour: true, pixels: "soft" };
const KEY = "brain.village";
function loadOptions(): Options {
  // Sound and music start off on every visit: a page may not play before the person asks.
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Options>), sound: false, music: false }; } catch { return DEFAULTS; }
}

const CLASS_ICON: Record<Class, string> = { knight: "lucide-shield", mage: "lucide-wand-sparkles", cleric: "lucide-heart-pulse", scribe: "lucide-feather", builder: "lucide-hammer", ranger: "lucide-binoculars" };
const ACTION_ICON = { tool: "lucide-wrench", native: "lucide-terminal", text: "lucide-message-circle", status: "lucide-loader" } as const;

/** The words of an action: a tool by the last part of its name ("git.open-pr" reads "open pr"), speech as it is, a phase as "getting ready". */
const actionWords = (action: QueueAction | undefined): string =>
  !action ? t("live.doing.thinking") : action.kind === "text" ? `“${action.label}”` : action.kind === "status" ? t("live.doing.status") : (action.label.split(".").at(-1) ?? action.label).replaceAll(/[-_]/gu, " ");

/** Small chiptune sounds, made only after the person turned sound on. */
function chiptune(): { play: (kind: "arrive" | "done" | "failed" | "needs") => void; close: () => void } {
  const audio = new AudioContext();
  const note = (frequency: number, at: number, length: number, type: OscillatorType = "square"): void => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, audio.currentTime + at);
    gain.gain.exponentialRampToValueAtTime(0.05, audio.currentTime + at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + length);
    osc.connect(gain).connect(audio.destination);
    osc.start(audio.currentTime + at);
    osc.stop(audio.currentTime + at + length + 0.02);
  };
  return {
    play: (kind) => {
      if (kind === "arrive") { note(660, 0, 0.08); note(880, 0.08, 0.1); }
      if (kind === "done") [523, 659, 784, 1046].forEach((f, i) => note(f, i * 0.09, 0.16));
      if (kind === "failed") [392, 330, 262].forEach((f, i) => note(f, i * 0.12, 0.2, "triangle"));
      if (kind === "needs") { note(988, 0, 0.1); note(988, 0.18, 0.1); }
    },
    close: () => { void audio.close(); },
  };
}

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; kind: "spark" | "smoke" | "confetti" | "firework" | "leaf" | "plus" | "page" }

/** How dark it is: 0 at day, more at dusk and most at night. */
function darkness(time: Time, now: number): number {
  if (time === "day") return 0;
  if (time === "dusk") return 0.32;
  if (time === "night") return 0.58;
  const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
  if (hour >= 7 && hour < 18) return 0;
  if (hour >= 18 && hour < 20.5) return ((hour - 18) / 2.5) * 0.58;
  if (hour >= 5.5 && hour < 7) return ((7 - hour) / 1.5) * 0.58;
  return 0.58;
}

export function World(props: {
  stations: readonly Station[];
  runs: readonly WorldRun[];
  leaving: ReadonlyArray<{ id: string; state: string }>;
  celebrations: ReadonlyArray<{ id: string; slug: string }>;
  queued: number;
  now: number;
  ambient: boolean;
  spent: string;
  progress: number;
  rate: number | null;
}): JSX.Element {
  let box!: HTMLDivElement;
  let view!: HTMLCanvasElement;
  let mini!: HTMLCanvasElement;
  const [options, setOptions] = createSignal<Options>(loadOptions());
  const set = <K extends keyof Options>(key: K, value: Options[K]): void => {
    setOptions((before) => ({ ...before, [key]: value }));
    try { localStorage.setItem(KEY, JSON.stringify(options())); } catch { /* a per-browser convenience */ }
  };
  let sound: ReturnType<typeof chiptune> | undefined;
  const toggleSound = (): void => {
    const on = !options().sound;
    set("sound", on);
    if (on && !sound) { try { sound = chiptune(); sound.play("arrive"); } catch { sound = undefined; } }
    if (!on) { sound?.close(); sound = undefined; }
  };
  let music: Music | undefined;
  const toggleMusic = (): void => {
    const on = !options().music;
    set("music", on);
    if (on && !music) { try { music = startMusic(); } catch { music = undefined; } }
    if (!on) { music?.close(); music = undefined; }
  };
  createEffect(() => music?.pause(!visible()));
  onCleanup(() => { sound?.close(); music?.close(); });
  const [menu, setMenu] = createSignal(false);
  const [selected, setSelected] = createSignal<{ kind: "hero"; id: string } | { kind: "lot"; slug: string } | null>(null);
  const [size, setSize] = createSignal({ w: 800, h: 480 });

  const places = createMemo(() => props.stations.map((station) => `${station.slug}:${station.platform ? 1 : 0}`).join(","));
  const map = createMemo(on(places, () => layout(props.stations.map((station) => ({ slug: station.slug, platform: station.platform })))));
  const ground = createMemo(() => paintGround(map()));
  const lotOf = createMemo(() => new Map(map().lots.filter((lot) => lot.slug !== null).map((lot) => [lot.slug as string, lot])));
  const stationOf = createMemo(() => new Map(props.stations.map((station) => [station.slug, station])));
  const runOf = createMemo(() => new Map(props.runs.map((run) => [run.id, run])));

  // The characters, the particles and the camera live outside Solid: they change sixty times a second.
  const heroes = new Map<string, Hero>();
  let particles: Particle[] = [];
  const random = seeded(hashOf("village"));
  const camera = { x: 0, y: 0, zoom: 2, tx: 0, ty: 0, tz: 2 };
  let placed = false;
  let firstRead = true;
  let tourAt = 0;
  let tourIndex = 0;
  let last = performance.now();

  const fitZoom = (): number => Math.max(0.5, Math.min(size().w / (map().w * TILE), size().h / (map().h * TILE)));
  const baseZoom = (): number => Math.max(fitZoom(), size().w < 640 ? 2 : 2.5);
  const center = (x: number, y: number, zoom?: number): void => { camera.tx = x; camera.ty = y; if (zoom !== undefined) camera.tz = zoom; };
  const lotCenter = (lot: Lot): { x: number; y: number } => ({ x: (lot.building.x + lot.building.w / 2) * TILE, y: (lot.building.y + lot.building.h) * TILE });

  // Sizes follow the box, never a fixed width, so a phone never scrolls sideways.
  onMount(() => {
    const observer = new ResizeObserver(() => {
      const rect = box.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(rect.width)), h: Math.max(200, Math.floor(rect.height)) });
    });
    observer.observe(box);
    onCleanup(() => observer.disconnect());
  });
  createEffect(on([size, map, () => options().pixels], () => {
    const pixel = PIXEL[options().pixels];
    const ratio = pixel === 0 ? window.devicePixelRatio || 1 : 1 / pixel;
    view.width = Math.floor(size().w * ratio);
    view.height = Math.floor(size().h * ratio);
    if (!placed) {
      const busy = props.stations.find((station) => station.running > 0) ?? props.stations[0];
      const lot = busy ? lotOf().get(busy.slug) : undefined;
      const spot = lot ? lotCenter(lot) : { x: (map().plaza.x + 7) * TILE, y: (map().plaza.y + 5) * TILE };
      camera.x = camera.tx = spot.x; camera.y = camera.ty = spot.y; camera.zoom = camera.tz = baseZoom();
      placed = true;
    }
    camera.tz = Math.max(fitZoom(), camera.tz);
    draw(performance.now());
  }));

  // Characters follow the answers; sounds say what changed.
  let knownNeeds = new Map<string, number>();
  createEffect(() => {
    const roster = {
      runs: props.runs.map((run) => ({ id: run.id, agent: run.agent, kind: run.kind, slug: run.slug, rootId: run.rootId })),
      leaving: props.leaving,
      idle: props.stations.flatMap((station) => station.recent.map((agent) => ({ slug: station.slug, agent }))),
    };
    const before = new Set(heroes.keys());
    reconcile(heroes, map(), roster, Date.now(), firstRead || reduced(), random);
    if (!firstRead && options().sound && sound) {
      if (roster.runs.some((run) => !before.has(run.id))) sound.play("arrive");
      if (props.leaving.some((entry) => entry.state === "done" && before.has(entry.id) && heroes.get(entry.id)?.mode === "done")) sound.play("done");
      if (props.leaving.some((entry) => (entry.state === "failed" || entry.state === "stopped") && before.has(entry.id))) sound.play("failed");
    }
    const needs = new Map(props.stations.map((station) => [station.slug, station.needs]));
    if (!firstRead && sound && [...needs].some(([slug, n]) => n > (knownNeeds.get(slug) ?? 0))) sound.play("needs");
    knownNeeds = needs;
    firstRead = false;
    if (reduced()) draw(performance.now());
  });

  // A goal that finishes sets off fireworks over its building.
  const celebrated = new Set<string>();
  createEffect(() => {
    for (const goal of props.celebrations) {
      if (celebrated.has(goal.id)) continue;
      celebrated.add(goal.id);
      const lot = lotOf().get(goal.slug);
      if (!lot || reduced() || !options().effects) continue;
      const c = lotCenter(lot);
      for (let burst = 0; burst < 3; burst += 1) firework(c.x + (burst - 1) * 30, c.y - 90 - burst * 12, ["#ffd23f", "#ff7eb6", "#7dd3fc", "#9be15d"][burst % 4] as string);
      if (sound) sound.play("done");
    }
  });

  function firework(x: number, y: number, color: string): void {
    for (let i = 0; i < 28; i += 1) {
      const angle = (i / 28) * Math.PI * 2;
      const speed = 40 + random() * 30;
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0, max: 1.4, color, size: 2, kind: "firework" });
    }
  }

  // ——— Drawing ———
  const artOf = (lot: Lot, name: string, lit: boolean): Art => (lot.platform ? paintCastle(name, lot.building.w, lot.building.h, lit) : paintCottage(name, lot.building.w, lot.building.h, lit));
  const feet = (hero: Hero): { x: number; y: number } => ({ x: (hero.x + 0.5) * TILE, y: (hero.y + 1) * TILE - 2 });
  const toScreen = (x: number, y: number): { x: number; y: number } => ({ x: (x - camera.x) * camera.zoom + size().w / 2, y: (y - camera.y) * camera.zoom + size().h / 2 });
  const toWorld = (x: number, y: number): { x: number; y: number } => ({ x: (x - size().w / 2) / camera.zoom + camera.x, y: (y - size().h / 2) / camera.zoom + camera.y });

  let light: HTMLCanvasElement | undefined;
  const tags = new Map<string, HTMLElement>();
  const signs = new Map<string, HTMLElement>();

  function draw(now: number): void {
    const ctx = view.getContext("2d");
    if (!ctx) return;
    const ratio = view.width / size().w;
    const wall = Date.now();
    const m = map();
    const z = camera.zoom;
    const opts = options();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#5f9e48";
    ctx.fillRect(0, 0, size().w, size().h);
    ctx.save();
    ctx.translate(size().w / 2, size().h / 2);
    ctx.scale(z, z);
    ctx.translate(-camera.x, -camera.y);
    ctx.drawImage(ground(), 0, 0, m.w * TILE, m.h * TILE);

    const t = now / 1000;
    const night = darkness(opts.time, wall);
    music?.setNight(night > 0.3);
    const still = reduced();
    // Ponds lie flat; their water glitters.
    for (const prop of m.props) {
      if (prop.kind !== "pond") continue;
      const art = paintProp(prop);
      ctx.drawImage(art.image, prop.x * TILE, prop.y * TILE, art.width, art.height);
    }
    for (const prop of m.props) {
      if (prop.kind !== "fountain" && prop.kind !== "pond") continue;
      const w = prop.kind === "fountain" ? 40 : 80;
      for (let i = 0; i < 7; i += 1) {
        const phase = (t * 0.6 + i * 0.37) % 1;
        ctx.fillStyle = `rgba(255,255,255,${(0.85 - phase) * 0.9})`;
        ctx.beginPath(); ctx.ellipse(prop.x * TILE + 14 + ((i * 53 + Math.floor(t * 0.5) * 17) % w), prop.y * TILE + 20 + ((i * 29) % (prop.kind === "fountain" ? 16 : 34)), 2 + phase * 2, 0.5 + phase * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Everything that stands, sorted by where it touches the ground.
    type Thing = { base: number; paint: () => void };
    const things: Thing[] = [];
    for (const lot of m.lots) {
      if (lot.slug === null) continue;
      const station = stationOf().get(lot.slug);
      if (!station) continue;
      const busy = station.running > 0;
      const art = artOf(lot, station.name, busy || night > 0.25);
      const base = (lot.building.y + lot.building.h) * TILE;
      const x0 = lot.building.x * TILE;
      const y0 = base - art.height;
      things.push({ base, paint: () => {
        ctx.fillStyle = "rgba(0,0,0,0.16)"; ctx.beginPath(); ctx.ellipse(x0 + art.width / 2, base, art.width / 2 + 2, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.drawImage(art.image, x0, y0, art.width, art.height);
        for (const flag of art.flags) {
          const fx = x0 + flag.x;
          const fy = y0 + flag.y - 16;
          ctx.strokeStyle = "#3b2a20"; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(fx, fy - 1); ctx.lineTo(fx, fy + 18); ctx.stroke();
          const wave = (k: number): number => (still ? 0 : Math.sin(t * 4 + k) * 1.4 * (k / 3));
          ctx.beginPath(); ctx.moveTo(fx, fy); ctx.bezierCurveTo(fx + 4, fy + wave(1), fx + 8, fy + wave(2), fx + 12, fy + 1 + wave(3)); ctx.lineTo(fx + 12, fy + 6 + wave(3)); ctx.bezierCurveTo(fx + 8, fy + 6 + wave(2), fx + 4, fy + 6 + wave(1), fx, fy + 6); ctx.closePath();
          ctx.fillStyle = roofOf(station.name); ctx.fill(); ctx.strokeStyle = "#2a2236"; ctx.lineWidth = 0.5; ctx.stroke();
        }
        // Smoke from the chimney while someone works inside.
        if (busy && opts.effects && art.chimney && !still && random() < 0.08) particles.push({ x: x0 + art.chimney.x, y: y0 + art.chimney.y, vx: 3 + random() * 4, vy: -9 - random() * 5, life: 0, max: 3, color: "#eeecf4", size: 2.5, kind: "smoke" });
        // The quest marker: a golden "!" over a building that needs the person.
        if (station.needs > 0) {
          const bob = still ? 0 : Math.abs(Math.sin(t * 3)) * 4;
          ctx.save(); ctx.translate(x0 + art.width / 2, y0 - 2 - bob); ctx.scale(2, 2); drawEmote(ctx, "!", 0, 0); ctx.restore();
        }
        // A rain cloud over a building whose work failed today.
        if (opts.weather === "auto" && station.failed > 0) {
          const cx = x0 + art.width / 2 + Math.sin(t * 0.5) * 6;
          const cy = y0 + 4;
          if (!still) for (let i = 0; i < 7; i += 1) { ctx.strokeStyle = "rgba(125,196,255,0.8)"; ctx.lineWidth = 0.8; const yy = cy + 4 + ((t * 40 + i * 9) % 22); ctx.beginPath(); ctx.moveTo(cx - 15 + i * 5, yy); ctx.lineTo(cx - 16 + i * 5, yy + 3); ctx.stroke(); }
          ctx.fillStyle = "#9895ad";
          for (const [dx, dy, r] of [[-10, 0, 7], [0, -4, 9], [11, 0, 7], [4, 2, 7], [-4, 2, 7]] as const) { ctx.beginPath(); ctx.ellipse(cx + dx, cy + dy, r, r * 0.8, 0, 0, Math.PI * 2); ctx.fill(); }
          ctx.fillStyle = "#b8b5ca"; ctx.beginPath(); ctx.ellipse(cx - 2, cy - 6, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
        }
      } });
    }
    for (const prop of m.props) {
      if (prop.kind === "pond") continue;
      const art = paintProp(prop);
      const place: Record<string, { x: number; base: number }> = {
        tree: { x: prop.x * TILE - 2, base: (prop.y + 2) * TILE - 2 },
        board: { x: prop.x * TILE - 1, base: (prop.y + 1) * TILE + 3 },
        bench: { x: prop.x * TILE, base: (prop.y + 1) * TILE },
        well: { x: prop.x * TILE, base: (prop.y + 1) * TILE + 2 },
        fountain: { x: prop.x * TILE, base: (prop.y + 3) * TILE + 1 },
        lamp: { x: prop.x * TILE + 2, base: (prop.y + 1) * TILE + 1 },
      };
      const at = place[prop.kind] ?? { x: prop.x * TILE + (TILE - art.width) / 2, base: (prop.y + 1) * TILE };
      const sway = prop.kind === "tree" && !still ? Math.sin(t * 0.9 + prop.seed) * 0.025 : 0;
      things.push({ base: at.base, paint: () => {
        ctx.save();
        ctx.translate(at.x + art.width / 2, at.base);
        if (sway) ctx.transform(1, 0, sway, 1, 0, 0);
        ctx.drawImage(art.image, -art.width / 2, -art.height, art.width, art.height);
        ctx.restore();
        if (prop.kind === "board") {
          // One paper for each quest waiting on the board.
          for (let i = 0; i < Math.min(12, props.queued); i += 1) {
            const px = at.x + 5 + (i % 6) * 4.2;
            const py = at.base - 30 + Math.floor(i / 6) * 6.5;
            ctx.save(); ctx.translate(px, py); ctx.rotate(((i * 37) % 7 - 3) * 0.04);
            ctx.fillStyle = "#fbf5e6"; ctx.fillRect(-1.6, 0, 3.2, 4.4); ctx.fillStyle = "#c0453b"; ctx.beginPath(); ctx.arc(0, 0.4, 0.6, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
          }
        }
        if (prop.kind === "fountain" && !still) {
          for (let i = 0; i < 10; i += 1) {
            const phase = (t * 1.2 + i / 10) % 1;
            const angle = (i / 10) * Math.PI * 2;
            ctx.fillStyle = `rgba(207,233,255,${1 - phase})`;
            ctx.beginPath(); ctx.ellipse(at.x + 32 + Math.cos(angle) * phase * 9, at.base - 41 + phase * phase * 14 - Math.sin(phase * Math.PI) * 6, 1, 1, 0, 0, Math.PI * 2); ctx.fill();
          }
        }
      } });
    }
    // The line of quests waiting at the board: pilgrims in hoods.
    const waiting = Math.min(6, props.queued);
    for (let i = 0; i < waiting; i += 1) {
      const fx = (m.plaza.x + 2.4 + i * 1.15) * TILE;
      const fy = (m.plaza.y + 3) * TILE + 2;
      const look = lookOf(`pilgrim ${i} watch`, i);
      things.push({ base: fy, paint: () => {
        ctx.fillStyle = "rgba(0,0,0,0.2)"; ctx.beginPath(); ctx.ellipse(fx, fy, 5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(fx, fy); ctx.scale(0.8, 0.8); drawHero(ctx, look, { dir: 3, walk: null, work: null, t: still ? 0 : t, mood: "neutral", seed: i * 13 }); ctx.restore();
      } });
    }
    const pick = selected();
    for (const hero of heroes.values()) {
      const at = feet(hero);
      things.push({ base: at.y, paint: () => {
        const hop = hero.hop * TILE;
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.beginPath(); ctx.ellipse(at.x, at.y, 6.5 - hop * 0.1, 2.2, 0, 0, Math.PI * 2); ctx.fill();
        if (pick?.kind === "hero" && pick.id === hero.id) { ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(at.x, at.y, 10, 3.8, 0, 0, Math.PI * 2); ctx.stroke(); }
        const seed = hashOf(hero.id) % 97;
        const mood: Mood = hero.mode === "done" || hero.emote?.kind === "heart" ? "happy" : hero.mode === "failed" ? "sad" : hero.mode === "work" ? "focus" : "neutral";
        ctx.save();
        ctx.translate(at.x, at.y - hop);
        if (hero.mode === "failed") ctx.globalAlpha = 0.85;
        drawHero(ctx, lookOf(hero.agent, hero.variant), { dir: hero.dir, walk: walking(hero) && !still ? hero.walked * Math.PI : null, work: hero.mode === "work" && !still ? t * 5 + seed : null, t: still ? 0 : t, mood, seed });
        ctx.restore();
        if (hero.emote) drawEmote(ctx, hero.emote.kind, at.x, at.y - HERO_H - 3 - hop);
        // What each class leaves in the air while it works.
        if (hero.mode === "work" && opts.effects && !still && random() < 0.12) {
          const kind = classOf(hero.agent);
          const colors: Record<Class, string> = { knight: "#ffffff", mage: random() < 0.5 ? "#c4a6ff" : "#8fe3ff", cleric: "#7cf09a", scribe: "#fbf5e6", builder: "#ffd23f", ranger: "#9ee07a" };
          particles.push({ x: at.x + (random() - 0.5) * 16, y: at.y - 18, vx: (random() - 0.5) * 16, vy: -14 - random() * 14, life: 0, max: 1, color: colors[kind], size: kind === "scribe" ? 2 : 1.4, kind: kind === "cleric" ? "plus" : kind === "ranger" ? "leaf" : kind === "scribe" ? "page" : "spark" });
        }
        if (hero.mode === "done" && hero.partner === null && opts.effects && !still && random() < 0.4) particles.push({ x: at.x + (random() - 0.5) * 10, y: at.y - 30, vx: (random() - 0.5) * 40, vy: -30 - random() * 20, life: 0, max: 1.2, color: ["#ffd23f", "#ff7eb6", "#7dd3fc", "#9be15d"][Math.floor(random() * 4)] as string, size: 1.8, kind: "confetti" });
      } });
    }
    things.sort((a, b) => a.base - b.base);
    for (const thing of things) thing.paint();

    // Particles.
    const dt = Math.min(0.1, (now - last) / 1000);
    particles = particles.filter((p) => (p.life += dt) < p.max);
    for (const p of particles) {
      if (p.kind === "firework" || p.kind === "confetti") p.vy += 60 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const fade = 1 - p.life / p.max;
      ctx.globalAlpha = p.kind === "smoke" ? fade * 0.7 : fade;
      ctx.fillStyle = p.color;
      const s = p.kind === "smoke" ? p.size + p.life * 2.4 : p.size;
      if (p.kind === "plus") { ctx.fillRect(p.x - 1.5, p.y - 0.5, 3, 1); ctx.fillRect(p.x - 0.5, p.y - 1.5, 1, 3); }
      else if (p.kind === "confetti" || p.kind === "page") { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.life * 6); ctx.fillRect(-s / 2, -s / 4, s, s / 2); ctx.restore(); }
      else { ctx.beginPath(); ctx.ellipse(p.x, p.y, s, s, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    // Birds by day, fireflies by night.
    if (opts.effects && !reduced()) {
      if (night < 0.2) for (let i = 0; i < 3; i += 1) {
        const span = m.w * TILE + 200;
        const bx = ((t * 30 + i * 400) % span) - 100;
        const by = 30 + i * 70 + Math.sin(t + i) * 10;
        ctx.fillStyle = "#2b2b38"; const flap = Math.floor(t * 6 + i) % 2;
        ctx.fillRect(bx, by, 1, 1); ctx.fillRect(bx - 2, by - 1 + flap, 2, 1); ctx.fillRect(bx + 1, by - 1 + flap, 2, 1);
      } else for (let i = 0; i < 24; i += 1) {
        const fx = (hashOf(`f${i}`) % (m.w * TILE)) + Math.sin(t * 0.7 + i) * 12;
        const fy = (hashOf(`g${i}`) % (m.h * TILE)) + Math.cos(t * 0.9 + i) * 8;
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 3 + i);
        ctx.fillStyle = "#e8ff8a"; ctx.fillRect(fx, fy, 1, 1);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // Weather over everything, in screen space.
    const weather = opts.weather;
    if ((weather === "rain" || weather === "snow") && !reduced()) {
      ctx.fillStyle = weather === "rain" ? "rgba(170,200,255,0.7)" : "rgba(255,255,255,0.9)";
      for (let i = 0; i < 120; i += 1) {
        const speed = weather === "rain" ? 420 : 40;
        const x = ((hashOf(`r${i}`) % 1000) / 1000) * size().w + (weather === "snow" ? Math.sin(t + i) * 8 : -((t * 80) % 40));
        const y = (((hashOf(`s${i}`) % 1000) / 1000) * size().h + t * speed) % size().h;
        if (weather === "rain") ctx.fillRect(x, y, 1, 6); else ctx.fillRect(x, y, 2, 2);
      }
      if (weather === "rain") { ctx.fillStyle = "rgba(40,50,80,0.12)"; ctx.fillRect(0, 0, size().w, size().h); }
    }

    // Night: a dark veil with holes where there is light (lamps, lit windows, mages' orbs).
    if (night > 0.01) {
      light ??= document.createElement("canvas");
      if (light.width !== view.width || light.height !== view.height) { light.width = view.width; light.height = view.height; }
      const l = light.getContext("2d") as CanvasRenderingContext2D;
      l.setTransform(ratio, 0, 0, ratio, 0, 0);
      l.globalCompositeOperation = "source-over";
      l.clearRect(0, 0, size().w, size().h);
      l.fillStyle = `rgba(14,18,52,${night})`;
      l.fillRect(0, 0, size().w, size().h);
      l.globalCompositeOperation = "destination-out";
      const hole = (wx: number, wy: number, radius: number, strength: number): void => {
        const s = toScreen(wx, wy);
        const r = radius * z;
        const g = l.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
        g.addColorStop(0, `rgba(0,0,0,${strength})`); g.addColorStop(1, "rgba(0,0,0,0)");
        l.fillStyle = g; l.fillRect(s.x - r, s.y - r, r * 2, r * 2);
      };
      for (const prop of m.props) if (prop.kind === "lamp") hole(prop.x * TILE + 8, prop.y * TILE - 6, 46, 0.95);
      for (const lot of m.lots) {
        if (lot.slug === null) continue;
        const station = stationOf().get(lot.slug);
        if (!station) continue;
        const art = artOf(lot, station.name, true);
        const x0 = lot.building.x * TILE;
        const y0 = (lot.building.y + lot.building.h) * TILE - art.height;
        for (const w of art.windows) hole(x0 + w.x, y0 + w.y + 6, station.running > 0 ? 40 : 26, station.running > 0 ? 0.9 : 0.6);
      }
      for (const hero of heroes.values()) { const at = feet(hero); hole(at.x, at.y - 10, classOf(hero.agent) === "mage" ? 34 : 18, 0.6); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(light, 0, 0);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    last = now;
    place();
    drawMini();
  }

  /** Puts the words where the drawing is: signs over the buildings, names and speech bubbles over the heroes. */
  function place(): void {
    for (const [slug, element] of signs) {
      const lot = lotOf().get(slug);
      if (!lot) continue;
      const s = toScreen(lot.door.x * TILE, (lot.y + 10) * TILE + 4);
      const off = s.x < -150 || s.y < -60 || s.x > size().w + 150 || s.y > size().h + 60;
      element.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, 0)`;
      element.style.visibility = off ? "hidden" : "visible";
    }
    for (const [id, element] of tags) {
      const hero = heroes.get(id);
      if (!hero) { element.style.visibility = "hidden"; continue; }
      const at = feet(hero);
      const s = toScreen(at.x, at.y - HERO_H - 1 - hero.hop * TILE);
      element.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      element.style.visibility = s.x < -100 || s.y < -20 || s.x > size().w + 100 || s.y > size().h + 120 || (hero.mode === "wander" && camera.zoom < 1.6) ? "hidden" : "visible";
    }
  }

  function drawMini(): void {
    const ctx = mini?.getContext("2d");
    if (!ctx) return;
    const m = map();
    const scale = 2;
    if (mini.width !== m.w * scale) { mini.width = m.w * scale; mini.height = m.h * scale; }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(ground(), 0, 0, m.w * TILE * GROUND_SCALE, m.h * TILE * GROUND_SCALE, 0, 0, m.w * scale, m.h * scale);
    for (const lot of m.lots) {
      if (lot.slug === null) continue;
      const station = stationOf().get(lot.slug);
      ctx.fillStyle = station ? roofOf(station.name) : "#888";
      ctx.fillRect(lot.building.x * scale, lot.building.y * scale, lot.building.w * scale, lot.building.h * scale);
      if (station && station.needs > 0) { ctx.fillStyle = "#ffd23f"; ctx.fillRect((lot.building.x + lot.building.w / 2) * scale - 2, (lot.building.y - 2) * scale, 4, 4); }
    }
    for (const hero of heroes.values()) { ctx.fillStyle = hero.mode === "wander" ? "#ffffff" : "#ffd23f"; ctx.fillRect(Math.round(hero.x * scale), Math.round(hero.y * scale), 3, 3); }
    const tl = toWorld(0, 0);
    const br = toWorld(size().w, size().h);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1;
    ctx.strokeRect((tl.x / TILE) * scale + 0.5, (tl.y / TILE) * scale + 0.5, ((br.x - tl.x) / TILE) * scale, ((br.y - tl.y) / TILE) * scale);
  }

  // ——— The loop: about thirty frames a second while the village is on screen; one still frame under reduced motion. ———
  let frame = 0;
  let offscreen = false;
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    if (!visible() || offscreen || reduced()) return;
    const dt = now - last;
    if (dt < 30) return;
    step(heroes, map(), Math.min(dt, 120), Date.now(), random);
    tour(now);
    const ease = 1 - Math.pow(0.002, Math.min(dt, 100) / 1000);
    camera.x += (camera.tx - camera.x) * ease;
    camera.y += (camera.ty - camera.y) * ease;
    camera.zoom += (camera.tz - camera.zoom) * ease;
    draw(now);
  };
  onMount(() => {
    const observer = new IntersectionObserver((entries) => { offscreen = !(entries.at(-1)?.isIntersecting ?? true); });
    observer.observe(box);
    frame = requestAnimationFrame(loop);
    onCleanup(() => { observer.disconnect(); cancelAnimationFrame(frame); });
  });
  const still = (): void => { if (reduced() || !visible()) { camera.x = camera.tx; camera.y = camera.ty; camera.zoom = camera.tz; draw(performance.now()); } };

  /** The camera follows the action: the next building where someone works or something waits, every few seconds. */
  function tour(now: number): void {
    if (!options().tour || selected() !== null || now - tourAt < 7000) return;
    tourAt = now;
    const spots = props.stations.filter((station) => station.running > 0 || station.needs > 0).map((station) => lotOf().get(station.slug)).filter((lot): lot is Lot => lot !== undefined);
    const arriving = [...heroes.values()].filter((hero) => hero.mode === "arrive");
    if (arriving[0]) { const at = feet(arriving[0]); center(at.x, at.y); return; }
    if (spots.length === 0) { center((map().plaza.x + 7) * TILE, (map().plaza.y + 5) * TILE); return; }
    const lot = spots[tourIndex++ % spots.length] as Lot;
    const c = lotCenter(lot);
    center(c.x, c.y);
  }

  // Following the selection.
  createEffect(on(selected, (pick) => {
    if (!pick) return;
    if (pick.kind === "lot") { const lot = lotOf().get(pick.slug); if (lot) { const c = lotCenter(lot); center(c.x, c.y, Math.max(camera.tz, baseZoom())); } }
    else { const hero = heroes.get(pick.id); if (hero) { const at = feet(hero); center(at.x, at.y, Math.max(camera.tz, baseZoom())); } }
    still();
  }, { defer: true }));

  // ——— Input: drag with a mouse to look around, a click or a tap selects, the wheel zooms with Ctrl (or always in ambient). ———
  let drag: { x: number; y: number; moved: boolean; id: number } | null = null;
  const down = (event: PointerEvent): void => { drag = { x: event.clientX, y: event.clientY, moved: false, id: event.pointerId }; if (event.pointerType === "mouse") view.setPointerCapture(event.pointerId); };
  const move = (event: PointerEvent): void => {
    if (!drag || event.pointerType !== "mouse") return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    camera.tx = camera.x -= dx / camera.zoom; camera.ty = camera.y -= dy / camera.zoom;
    drag.x = event.clientX; drag.y = event.clientY;
    if (options().tour) set("tour", false);
    still();
  };
  const up = (event: PointerEvent): void => {
    const was = drag;
    drag = null;
    if (!was || was.moved) return;
    const rect = view.getBoundingClientRect();
    const at = toWorld(event.clientX - rect.left, event.clientY - rect.top);
    const hit = [...heroes.values()].filter((hero) => { const f = feet(hero); return Math.abs(at.x - f.x) <= HERO_W / 2 + 1 && at.y <= f.y + 3 && at.y >= f.y - HERO_H - 2; }).sort((a, b) => b.y - a.y)[0];
    if (hit) { setSelected({ kind: "hero", id: hit.id }); return; }
    const lot = map().lots.find((l) => l.slug !== null && at.x >= l.building.x * TILE && at.x <= (l.building.x + l.building.w) * TILE && at.y >= (l.building.y - 2) * TILE && at.y <= (l.building.y + l.building.h) * TILE);
    setSelected(lot?.slug ? { kind: "lot", slug: lot.slug } : null);
  };
  const wheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !props.ambient) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
  };
  const zoomBy = (factor: number): void => { camera.tz = Math.min(5, Math.max(fitZoom(), camera.tz * factor)); still(); };
  const pan = (dx: number, dy: number): void => { camera.tx += dx / camera.zoom; camera.ty += dy / camera.zoom; if (options().tour) set("tour", false); still(); };
  const keys = (event: KeyboardEvent): void => {
    if (event.target !== box) return;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] };
    const by = moves[event.key];
    if (by) { event.preventDefault(); pan(by[0], by[1]); }
    if (event.key === "+" || event.key === "=") zoomBy(1.2);
    if (event.key === "-") zoomBy(1 / 1.2);
    if (event.key === "Escape") setSelected(null);
  };
  const overview = (): void => { if (options().tour) set("tour", false); center((map().w * TILE) / 2, (map().h * TILE) / 2, fitZoom()); setSelected(null); still(); };
  const miniClick = (event: MouseEvent): void => {
    const rect = mini.getBoundingClientRect();
    center(((event.clientX - rect.left) / rect.width) * map().w * TILE, ((event.clientY - rect.top) / rect.height) * map().h * TILE);
    if (options().tour) set("tour", false);
    still();
  };
  createEffect(on(() => [props.ambient, options()], () => queueMicrotask(() => draw(performance.now())), { defer: true }));

  // ——— Words in the page ———
  const chosenHero = (): WorldRun | undefined => { const pick = selected(); return pick?.kind === "hero" ? runOf().get(pick.id) : undefined; };
  const chosenWanderer = (): { agent: string; slug: string } | undefined => { const pick = selected(); const hero = pick?.kind === "hero" ? heroes.get(pick.id) : undefined; return hero && !runOf().has(hero.id) ? { agent: hero.agent, slug: hero.slug } : undefined; };
  const chosenLot = (): Station | undefined => { const pick = selected(); return pick?.kind === "lot" ? stationOf().get(pick.slug) : undefined; };
  const twins = createMemo(() => { const seen = new Map<string, number>(); return new Map(props.runs.map((run) => { const n = (seen.get(run.agent) ?? 0) + 1; seen.set(run.agent, n); return [run.id, props.runs.filter((other) => other.agent === run.agent).length > 1 ? n : 0]; })); });
  const wanderers = createMemo(() => props.stations.flatMap((station) => station.recent.filter((agent) => !props.runs.some((run) => run.slug === station.slug && run.agent === agent)).map((agent) => ({ id: `w:${station.slug}:${agent}`, agent, slug: station.slug }))));
  const showBubble = (id: string): boolean => options().bubbles === "all" || (selected()?.kind === "hero" && (selected() as { id: string }).id === id);

  return (
    <section class={`flex flex-col gap-3 ${props.ambient ? "min-h-0 flex-1" : ""}`} aria-labelledby="live-village" data-testid="live-world">
      <div class="rpg-panel flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2">
        <h2 id="live-village" class="t-head text-ink">{t("live.rpg.title")}</h2>
        <span class="flex items-center gap-1.5 t-small text-ink-2"><Hearts rate={props.rate} /><span>{props.rate === null ? t("live.tile.rate.none") : t("live.tile.rate", { n: Math.round(props.rate * 100) })}</span></span>
        <span class="flex items-center gap-1.5 t-small text-ink-2"><span class="grid size-4 place-items-center rounded-full bg-[#ffd23f] text-[0.55rem] font-bold text-[#3a2a00]" aria-hidden="true">$</span>{t("live.rpg.gold", { n: props.spent })}</span>
        <span class="flex items-center gap-1.5 t-small text-ink-2"><Icon name="lucide-users" class="size-4" />{tn("live.team.working", props.runs.length)}</span>
        <span class="flex items-center gap-1.5 t-small text-ink-2"><Icon name="lucide-scroll" class="size-4" />{tn("live.rpg.scrolls", props.queued)}</span>
        <span class="ms-auto flex min-w-[8rem] flex-1 items-center gap-2 sm:max-w-[16rem]">
          <span class="t-small text-ink-2">{t("live.rpg.progress")}</span>
          <span class="rpg-xp h-2.5 flex-1" role="progressbar" aria-label={t("live.rpg.progress")} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(props.progress * 100)}><span style={{ width: `${Math.round(props.progress * 100)}%` }} /></span>
        </span>
      </div>

      <div class={`flex flex-col gap-3 lg:flex-row ${props.ambient ? "min-h-0 flex-1" : ""}`}>
        <div ref={(element) => { box = element; watch(element); }} tabindex="0" role="region" aria-label={t("live.world.map", { n: props.stations.length, m: props.runs.length })} onKeyDown={keys}
          class={`rpg-world relative w-full min-w-0 overflow-hidden lg:w-auto lg:flex-1 focus-visible:focus-ring ${props.ambient ? "min-h-[16rem] flex-1 lg:h-auto" : "h-[clamp(22rem,64vh,42rem)]"}`}>
          <canvas ref={view} class="absolute inset-0 size-full" aria-hidden="true" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag = null; }} onWheel={wheel} style={{ "image-rendering": options().pixels === "smooth" ? "auto" : "pixelated", cursor: "grab" }} />
          <div class="pointer-events-none absolute inset-0 overflow-hidden">
            <For each={props.stations}>{(station) => (
              <button type="button" ref={(element) => { signs.set(station.slug, element); onCleanup(() => signs.delete(station.slug)); }} class="rpg-sign pointer-events-auto absolute left-0 top-0 flex max-w-[12rem] items-center gap-1.5 whitespace-nowrap px-2 py-0.5 t-small font-semibold"
                onClick={() => setSelected({ kind: "lot", slug: station.slug })} onFocus={() => setSelected({ kind: "lot", slug: station.slug })} aria-label={t("live.world.sign", { name: station.name })}>
                <Show when={station.platform}><Icon name="lucide-castle" class="size-3.5" /></Show>
                <bdi class="truncate">{station.name}</bdi>
                <Show when={station.needs > 0}><span class="rounded-[2px] bg-[#ffd23f] px-1 text-[#3a2a00]">!{station.needs}</span></Show>
              </button>
            )}</For>
            <For each={props.runs}>{(run) => (
              <div ref={(element) => { tags.set(run.id, element); onCleanup(() => tags.delete(run.id)); }} class="absolute left-0 top-0 flex flex-col items-center gap-0.5" style={{ visibility: "hidden" }} aria-hidden="true">
                <Show when={showBubble(run.id)}>
                  <p class="rpg-dialog relative max-w-[13rem] px-2 py-1 text-[0.75rem] leading-tight"><span class="flex items-center gap-1"><Icon name={ACTION_ICON[run.doing.at(-1)?.kind ?? "status"]} class="size-3" /><span class="line-clamp-2" dir="auto">{actionWords(run.doing.at(-1))}</span></span></p>
                </Show>
                <Show when={options().names}><span class="rpg-name whitespace-nowrap px-1.5 text-[0.7rem] font-semibold"><bdi>{run.agent}</bdi>{twins().get(run.id) ? ` ${twins().get(run.id)}` : ""}</span></Show>
              </div>
            )}</For>
            <For each={options().names ? wanderers() : []}>{(entry) => (
              <div ref={(element) => { tags.set(entry.id, element); onCleanup(() => tags.delete(entry.id)); }} class="absolute left-0 top-0" style={{ visibility: "hidden" }} aria-hidden="true">
                <span class="rpg-name whitespace-nowrap px-1.5 text-[0.7rem] font-medium opacity-80"><bdi>{entry.agent}</bdi></span>
              </div>
            )}</For>
          </div>
          {/* Controls. */}
          <div class="absolute end-2 top-2 flex flex-col gap-1.5" role="toolbar" aria-label={t("live.world.controls")}>
            <WorldButton icon="lucide-zoom-in" label={t("live.world.zoomin")} onClick={() => zoomBy(1.25)} />
            <WorldButton icon="lucide-zoom-out" label={t("live.world.zoomout")} onClick={() => zoomBy(0.8)} />
            <WorldButton icon="lucide-map" label={t("live.world.fit")} onClick={overview} />
            <WorldButton icon="lucide-video" label={t("live.world.tour")} pressed={options().tour} onClick={() => { set("tour", !options().tour); tourAt = 0; }} />
            <WorldButton icon={options().sound ? "lucide-volume-2" : "lucide-volume-x"} label={t("live.world.opt.sound")} pressed={options().sound} onClick={toggleSound} />
            <WorldButton icon={options().music ? "lucide-music" : "lucide-music-2"} label={t("live.world.opt.music")} pressed={options().music} onClick={toggleMusic} />
            <WorldButton icon="lucide-settings-2" label={t("live.world.options")} pressed={menu()} onClick={() => setMenu(!menu())} />
          </div>
          <div class="absolute bottom-2 start-2 hidden flex-col gap-1 sm:flex">
            <div class="flex gap-1">
              <WorldButton icon="lucide-arrow-left" label={t("live.world.pan.left")} onClick={() => pan(-120, 0)} small />
              <WorldButton icon="lucide-arrow-up" label={t("live.world.pan.up")} onClick={() => pan(0, -120)} small />
              <WorldButton icon="lucide-arrow-down" label={t("live.world.pan.down")} onClick={() => pan(0, 120)} small />
              <WorldButton icon="lucide-arrow-right" label={t("live.world.pan.right")} onClick={() => pan(120, 0)} small />
            </div>
          </div>
          <canvas ref={mini} class="rpg-mini absolute bottom-2 end-2 hidden w-40 cursor-pointer sm:block" style={{ "image-rendering": "pixelated" }} role="img" aria-label={t("live.world.minimap")} onClick={miniClick} />
          <Show when={menu()}>
            <div class="rpg-dialog absolute end-12 top-2 z-10 flex w-64 flex-col gap-3 p-3 t-small" role="group" aria-label={t("live.world.options")}>
              <Choice label={t("live.world.opt.time")} value={options().time} onChange={(v) => set("time", v as Time)} options={[["auto", t("live.world.time.auto")], ["day", t("live.world.time.day")], ["dusk", t("live.world.time.dusk")], ["night", t("live.world.time.night")]]} />
              <Choice label={t("live.world.opt.weather")} value={options().weather} onChange={(v) => set("weather", v as Weather)} options={[["auto", t("live.world.weather.auto")], ["clear", t("live.world.weather.clear")], ["rain", t("live.world.weather.rain")], ["snow", t("live.world.weather.snow")]]} />
              <Choice label={t("live.world.opt.bubbles")} value={options().bubbles} onChange={(v) => set("bubbles", v as Options["bubbles"])} options={[["all", t("live.world.bubbles.all")], ["selected", t("live.world.bubbles.selected")]]} />
              <Choice label={t("live.world.opt.names")} value={options().names ? "on" : "off"} onChange={(v) => set("names", v === "on")} options={[["on", t("live.world.on")], ["off", t("live.world.off")]]} />
              <Choice label={t("live.world.opt.pixels")} value={options().pixels} onChange={(v) => set("pixels", v as Pixels)} options={[["smooth", t("live.world.pixels.smooth")], ["soft", t("live.world.pixels.soft")], ["retro", t("live.world.pixels.retro")]]} />
              <Choice label={t("live.world.opt.effects")} value={options().effects ? "on" : "off"} onChange={(v) => set("effects", v === "on")} options={[["on", t("live.world.on")], ["off", t("live.world.off")]]} />
            </div>
          </Show>
        </div>

        {/* The panel of what is selected. */}
        <Show when={chosenHero() || chosenWanderer() || chosenLot()}>
          <aside class="rpg-panel flex w-full shrink-0 flex-col gap-3 p-4 lg:w-80" data-testid="live-panel" aria-live="polite">
            <div class="flex items-start gap-3">
              <Show when={chosenHero() ?? chosenWanderer()} fallback={<span class="grid size-16 shrink-0 place-items-center rounded-[3px]" style={{ background: roofOf(chosenLot()?.name ?? "") }} aria-hidden="true"><Icon name={chosenLot()?.platform ? "lucide-castle" : "lucide-house"} class="size-7 text-white" /></span>}>
                {(who) => <Portrait agent={who().agent} variant={chosenHero() ? hashOf(chosenHero()?.id ?? "") % 6 : hashOf(who().agent) % 6} />}
              </Show>
              <div class="min-w-0 flex-1">
                <Show when={chosenHero() ?? chosenWanderer()} fallback={<h3 class="t-title truncate text-ink"><bdi>{chosenLot()?.name}</bdi></h3>}>
                  {(who) => (<>
                    <h3 class="t-title truncate text-ink"><bdi>{who().agent}</bdi></h3>
                    <p class="flex items-center gap-1 t-small text-ink-2"><Icon name={CLASS_ICON[classOf(who().agent)]} class="size-3.5" />{t(`live.world.class.${classOf(who().agent)}`)}</p>
                  </>)}
                </Show>
              </div>
              <button type="button" class="grid size-8 shrink-0 place-items-center rounded-control text-ink-2 hover:bg-surface-gray-2 focus-visible:focus-ring" aria-label={t("live.world.close")} onClick={() => setSelected(null)}><Icon name="lucide-x" /></button>
            </div>
            <Show when={chosenHero()}>{(run) => (<>
              <A href={run().href} class="flex items-start gap-1.5 t-text font-medium text-ink hover:underline" dir="auto"><Icon name="lucide-scroll-text" class="mt-0.5 size-4 text-ink-3" /><span class="line-clamp-3">{run().goal}</span></A>
              <p class="flex flex-wrap gap-x-3 gap-y-1 t-small text-ink-2">
                <span class="flex items-center gap-1"><Icon name="lucide-house" class="size-3.5" /><bdi>{run().workspace}</bdi></span>
                <span class="flex items-center gap-1 tabular-nums"><Icon name="lucide-hourglass" class="size-3.5" />{run().startedAt ? duration(Math.max(0, props.now - run().startedAt!)) : "…"}</span>
                <span class="flex items-center gap-1 tabular-nums"><Icon name="lucide-zap" class="size-3.5" />{t("queue.run.tokens", { n: count(run().tokens) })}</span>
              </p>
              <div>
                <p class="mb-1 t-small font-medium text-ink-3">{t("live.doing.trail")}</p>
                <Show when={run().doing.length > 0} fallback={<p class="t-small text-ink-3">{t("live.doing.thinking")}</p>}>
                  <ol class="flex flex-col gap-1">
                    <For each={[...run().doing].reverse().filter((action, i, all) => i === 0 || actionWords(action) !== actionWords(all[i - 1]))}>{(action, i) => (
                      <li class={`flex items-start gap-2 t-small ${i() === 0 ? "text-ink" : "text-ink-2"}`}><Icon name={ACTION_ICON[action.kind]} class="mt-0.5 size-3.5 shrink-0" /><span class="line-clamp-2 min-w-0" dir="auto">{actionWords(action)}</span></li>
                    )}</For>
                  </ol>
                </Show>
              </div>
              <A href={run().href} class="link t-small font-medium">{t("live.world.open")}</A>
            </>)}</Show>
            <Show when={chosenWanderer()}>{(who) => <p class="t-small text-ink-2">{t("live.world.resting", { workspace: stationOf().get(who().slug)?.name ?? who().slug })}</p>}</Show>
            <Show when={chosenLot()}>{(station) => (<>
              <p class="flex items-center gap-2 t-small text-ink-2"><Hearts rate={station().rate} />{station().rate === null ? t("live.tile.rate.none") : t("live.tile.rate", { n: Math.round((station().rate as number) * 100) })}</p>
              <ul class="grid grid-cols-2 gap-2 t-small">
                <Stat icon="lucide-swords" label={tn("live.team.working", station().running)} />
                <Stat icon="lucide-scroll" label={tn("live.rpg.scrolls", station().waiting)} />
                <Stat icon="lucide-trophy" label={`${t("live.rpg.won")}: ${station().done}`} />
                <Stat icon="lucide-skull" label={`${t("live.rpg.lost")}: ${station().failed}`} />
              </ul>
              <Show when={station().needs > 0}><A href={`/w/${station().slug}`} class="flex items-center gap-2 rounded-[3px] bg-needs-soft px-2 py-1.5 t-small font-medium text-needs-text"><Icon name="lucide-hand" class="size-4" />{tn("live.rpg.needs", station().needs)}</A></Show>
              <div class="flex flex-wrap gap-x-4 gap-y-1 t-small">
                <A href={`/w/${station().slug}`} class="font-medium text-violet-text hover:underline">{t("live.tile.open")}</A>
                <A href={`/w/${station().slug}/tasks`} class="text-ink-2 hover:underline">{t("nav.tasks")}</A>
                <A href={`/w/${station().slug}/live`} class="text-ink-2 hover:underline">{t("live.tile.live")}</A>
              </div>
            </>)}</Show>
          </aside>
        </Show>
      </div>

      {/* The party: everyone on a quest now, the way to reach each one with the keyboard. */}
      <div class="flex flex-col gap-2">
        <h3 class="t-small font-medium text-ink-3">{t("live.world.party")}</h3>
        <Show when={props.runs.length > 0} fallback={<p class="t-small text-ink-3">{t("live.world.party.empty")}</p>}>
          <ul class="flex flex-wrap gap-2" data-testid="live-party">
            <For each={props.runs}>{(run) => (
              <li>
                <button type="button" class={`rpg-chip flex items-center gap-2 py-1 pe-3 ps-1 text-start focus-visible:focus-ring ${selected()?.kind === "hero" && (selected() as { id: string }).id === run.id ? "rpg-chip-on" : ""}`} onClick={() => setSelected({ kind: "hero", id: run.id })} data-testid="live-hero">
                  <Portrait agent={run.agent} variant={hashOf(run.id) % 6} small />
                  <span class="min-w-0">
                    <span class="block t-small font-semibold text-ink"><bdi>{run.agent}</bdi>{twins().get(run.id) ? ` ${twins().get(run.id)}` : ""}</span>
                    <span class="block max-w-[14rem] truncate text-[0.75rem] text-ink-2"><bdi>{run.workspace}</bdi> · <span dir="auto">{actionWords(run.doing.at(-1))}</span></span>
                  </span>
                </button>
              </li>
            )}</For>
          </ul>
        </Show>
      </div>
    </section>
  );
}

function WorldButton(props: { icon: string; label: string; onClick: () => void; pressed?: boolean; small?: boolean }): JSX.Element {
  return (
    <button type="button" class={`rpg-button grid place-items-center focus-visible:focus-ring ${props.small ? "size-7" : "size-9"}`} aria-label={props.label} title={props.label} aria-pressed={props.pressed} onClick={(event) => { event.stopPropagation(); props.onClick(); }}>
      <Icon name={props.icon} class={props.small ? "size-3.5" : "size-4"} />
    </button>
  );
}

function Choice(props: { label: string; value: string; options: ReadonlyArray<readonly [string, string]>; onChange: (value: string) => void }): JSX.Element {
  return (
    <fieldset class="flex flex-col gap-1">
      <legend class="mb-1 font-semibold">{props.label}</legend>
      <div class="flex flex-wrap gap-1">
        <For each={props.options}>{([value, label]) => <button type="button" class={`rpg-pill px-2 py-0.5 focus-visible:focus-ring ${props.value === value ? "rpg-pill-on" : ""}`} aria-pressed={props.value === value} onClick={() => props.onChange(value)}>{label}</button>}</For>
      </div>
    </fieldset>
  );
}

function Stat(props: { icon: string; label: string }): JSX.Element {
  return <li class="flex items-center gap-1.5 rounded-[3px] bg-surface-gray-1 px-2 py-1.5 text-ink-2"><Icon name={props.icon} class="size-3.5" />{props.label}</li>;
}

/** A character drawn large, standing and facing the person, smiling. */
function Portrait(props: { agent: string; variant: number; small?: boolean }): JSX.Element {
  let element!: HTMLCanvasElement;
  createEffect(() => {
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const w = props.small ? 32 : 60;
    const h = props.small ? 38 : 72;
    element.width = w * ratio;
    element.height = h * ratio;
    const scale = (h / (HERO_H + 6)) * ratio;
    ctx.setTransform(scale, 0, 0, scale, (w * ratio) / 2, h * ratio - 2 * ratio);
    drawHero(ctx, lookOf(props.agent, props.variant), { dir: 0, walk: null, work: null, t: 0, mood: "happy", seed: 3 });
  });
  return <span class={`rpg-portrait grid shrink-0 place-items-end justify-center overflow-hidden ${props.small ? "h-10 w-9" : "h-[4.75rem] w-16"}`} aria-hidden="true"><canvas ref={element} class={props.small ? "h-[38px] w-8" : "h-[72px] w-[60px]"} /></span>;
}

const HEARTS = 5;
/** Hearts for the share of the day's work that finished well. */
function Hearts(props: { rate: number | null }): JSX.Element {
  const full = (): number => (props.rate === null ? HEARTS : Math.round(props.rate * HEARTS));
  return (
    <span class="inline-flex items-center gap-px" aria-hidden="true">
      <For each={Array.from({ length: HEARTS })}>{(_, i) => (
        <svg viewBox="0 0 7 6" class="h-3 w-3.5" shape-rendering="crispEdges"><path d="M1 0h2v1h1V0h2v1h1v2H6v1H5v1H4v1H3V5H2V4H1V3H0V1h1z" fill={i() < full() ? "#e5484d" : "transparent"} stroke={i() < full() ? "#8f1d22" : "currentColor"} stroke-width="0.6" /></svg>
      )}</For>
    </span>
  );
}

