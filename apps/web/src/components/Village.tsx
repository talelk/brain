import { For, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { t, tn } from "../i18n";
import { Icon } from "./bits";
import { watch } from "./LiveParts";

/**
 * The Live screen as a small role-playing game seen from above: a village with one building per workspace (a castle for a platform workspace),
 * agents as pixel characters with a class, a dialogue box for what each does now, a golden "!" over a building that needs the person, scrolls
 * piled at the door for the work that waits. Everything is drawn from the same answers as the rest of Live; the drawing is decoration, the
 * words beside it are the content. Pixel art is made here from small grids, so there is no image to load.
 */

export interface Member { readonly agent: string; readonly doing: string; readonly kind: "tool" | "native" | "text" | "status" | "none" }
export interface Station {
  readonly slug: string;
  readonly name: string;
  readonly platform: boolean;
  readonly working: readonly Member[];
  readonly recent: readonly string[];
  readonly needs: number;
  readonly waiting: number;
  readonly done: number;
  readonly failed: number;
  readonly rate: number | null;
}

const hash = (text: string): number => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
const pick = <T,>(list: readonly T[], text: string, salt = 0): T => list[(hash(text) + salt) % list.length] as T;

type Rect = { x: number; y: number; w: number; h: number; fill: string };
/** Draws rows of characters as pixels, merging horizontal runs; a dark outline is added around every filled pixel. */
function paint(rows: readonly string[], palette: Readonly<Record<string, string>>, outline = "#1b1630"): Rect[] {
  const filled = (x: number, y: number): boolean => { const ch = rows[y]?.[x]; return ch !== undefined && ch !== "." && palette[ch] !== undefined; };
  const out: Rect[] = [];
  const width = Math.max(...rows.map((row) => row.length));
  for (let y = -1; y <= rows.length; y += 1) {
    let x = -1;
    while (x <= width) {
      const ch = rows[y]?.[x];
      const fill = ch !== undefined && ch !== "." ? palette[ch] : !filled(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) ? outline : undefined;
      if (fill === undefined) { x += 1; continue; }
      let run = 1;
      const same = (at: number): string | undefined => { const c = rows[y]?.[at]; return c !== undefined && c !== "." ? palette[c] : !filled(at, y) && (filled(at - 1, y) || filled(at + 1, y) || filled(at, y - 1) || filled(at, y + 1)) ? outline : undefined; };
      while (x + run <= width && same(x + run) === fill) run += 1;
      out.push({ x, y, w: run, h: 1, fill });
      x += run;
    }
  }
  return out;
}

const BASE = [
  "....hhhh....", "...hhhhhh...", "...hssssh...", "..hsessesh..", "...ssssss...", "....ssss....",
  "..tttttttt..", ".stttttttts.", ".stttbbttts.", "..tttttttt..", "..pppppppp..", "..pppppppp..",
];
const LEGS_A = ["..ppp..ppp..", "..ppp..ppp..", "..bbb..bbb..", "..bbb..bbb.."];
const LEGS_B = ["...pppppp...", "...pppppp...", "...bbbbbb...", "...bbbbbb..."];
const SKIN = ["#f2c9a0", "#e0ac7e", "#c68a5c", "#8d5a3b"] as const;
const HAIR = ["#3b2a20", "#b5651d", "#e6c35c", "#2d3748", "#a33b3b"] as const;
const TUNIC = ["#3f7fd1", "#c0392b", "#2e9a6a", "#8e5bd1", "#d68910", "#17a2b8"] as const;
type Class = "knight" | "mage" | "cleric" | "scribe" | "builder";
/** An agent's class is read from its name: who checks is a knight, who plans a mage, who heals a cleric, who writes things down a scribe. */
export const classOf = (agent: string): Class => (/check|review|verif|test|audit/iu.test(agent) ? "knight" : /plan|architect|analy|research|design/iu.test(agent) ? "mage" : /heal|fix|repair|sre|operator|support|doctor/iu.test(agent) ? "cleric" : /capital|sync|librar|memory|doc|writ|scribe/iu.test(agent) ? "scribe" : "builder");
export const CLASS_ICON: Record<Class, string> = { knight: "lucide-shield", mage: "lucide-wand-sparkles", cleric: "lucide-heart-pulse", scribe: "lucide-book-open", builder: "lucide-hammer" };

function overlay(rows: string[][], kind: Class): void {
  const set = (x: number, y: number, ch: string): void => { if (rows[y]) rows[y][x] = ch; };
  const line = (y: number, text: string): void => { rows[y] = text.split(""); };
  if (kind === "mage") {
    line(0, ".....aa....."); line(1, "....aaaa...."); line(2, "..aaaaaaaa..");
    for (let y = 5; y < 16; y += 1) set(0, y, "w");
    set(0, 4, "o"); set(0, 3, "o");
  } else if (kind === "knight") {
    line(0, "....gggg...."); line(1, "...gggggg..."); line(2, "...gssssg...");
    for (let y = 7; y <= 10; y += 1) { set(0, y, "a"); set(1, y, "a"); }
    set(0, 11, "a");
  } else if (kind === "cleric") {
    line(0, "....WWWW...."); line(1, "...WWWWWW..."); line(2, "...WssssW...");
    set(5, 6, "x"); set(6, 6, "x"); for (const x of [4, 5, 6, 7]) { set(x, 7, "x"); set(x, 8, "x"); } set(5, 9, "x"); set(6, 9, "x");
  } else if (kind === "scribe") {
    line(0, "....cccc...."); line(1, "...cccccc..."); set(9, 8, "a"); set(10, 8, "a"); set(9, 9, "a"); set(10, 9, "a"); set(10, 7, "a");
  } else {
    line(0, "....cccc...."); line(1, "..cccccccc..");
  }
}

/** A character drawn from a name: always the same one for the same agent. */
export function Sprite(props: { agent: string; pose?: "work" | "idle" | "walk"; size?: number }): JSX.Element {
  const kind = classOf(props.agent);
  const tunic = pick(TUNIC, props.agent, 1);
  const palette = {
    h: pick(HAIR, props.agent, 2), s: pick(SKIN, props.agent, 3), e: "#1b1630", t: tunic, b: "#5a3b24", p: "#3a3f58", a: kind === "knight" ? "#b8bcc8" : kind === "mage" ? tunic : "#f2c14e",
    c: pick(TUNIC, props.agent, 4), g: "#aeb4c4", W: "#f4f1ea", w: "#8a5a3c", o: "#7dd3fc", x: "#2e9a6a",
  };
  const top = BASE.map((row) => row.split(""));
  overlay(top, kind);
  const upper = top.map((row) => row.join(""));
  const body = paint([...upper, ...LEGS_A], palette);
  const legsB = paint([...upper, ...LEGS_B], palette).filter((rect) => rect.y >= upper.length - 1);
  const legsA = body.filter((rect) => rect.y >= upper.length - 1);
  const head = body.filter((rect) => rect.y < upper.length - 1);
  const size = props.size ?? 3;
  return (
    <svg viewBox="-1 -1 14 18" width={14 * size} height={18 * size} shape-rendering="crispEdges" class={`rpg-art rpg-sprite ${props.pose === "work" ? "rpg-work" : props.pose === "walk" ? "rpg-patrol" : "rpg-idle"}`} aria-hidden="true">
      <ellipse cx="6" cy="16.2" rx="4.6" ry="1" fill="#000" fill-opacity="0.22" />
      <For each={head}>{(r) => <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />}</For>
      <g class={props.pose === "idle" ? "" : "rpg-legs-a"}><For each={legsA}>{(r) => <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />}</For></g>
      <Show when={props.pose !== "idle"}><g class="rpg-legs-b"><For each={legsB}>{(r) => <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />}</For></g></Show>
    </svg>
  );
}

const ROOF = ["#c0392b", "#2e86c1", "#8e44ad", "#d68910", "#1e8449", "#17a589"] as const;
const rect = (x: number, y: number, w: number, h: number, fill: string): JSX.Element => <rect x={x} y={y} width={w} height={h} fill={fill} />;

/** A workspace as a building: a cottage, or a castle when it belongs to the platform. Lit windows and a chimney's smoke when someone works in it. */
export function Building(props: { name: string; platform: boolean; busy: boolean }): JSX.Element {
  const roof = pick(ROOF, props.name);
  const light = props.busy ? "#ffd866" : "#56617f";
  return (
    <svg viewBox="0 0 64 46" class="rpg-art h-[5.75rem] w-auto" shape-rendering="crispEdges" aria-hidden="true">
      <ellipse cx="32" cy="44" rx="26" ry="2" fill="#000" fill-opacity="0.2" />
      <Show when={props.platform} fallback={<>
        <For each={[0, 1, 2, 3, 4, 5, 6]}>{(i) => rect(32 - (9 + i * 3.5), 6 + i * 2.4, 18 + i * 7, 2.4, i % 2 ? roof : `color-mix(in srgb, ${roof} 82%, white)`)}</For>
        {rect(14, 22, 36, 22, "#ead9b2")}{rect(14, 38, 36, 6, "#cdb98f")}
        {rect(40, 4, 6, 12, "#8a5a3c")}{rect(39, 3, 8, 2, "#6b4426")}
        {rect(27, 29, 10, 15, "#6b4426")}{rect(34, 36, 1.5, 1.5, "#f5c542")}
        {rect(17, 26, 7, 7, light)}{rect(40, 26, 7, 7, light)}{rect(20, 26, 1, 7, "#3a2a1c")}{rect(17, 29, 7, 1, "#3a2a1c")}{rect(43, 26, 1, 7, "#3a2a1c")}{rect(40, 29, 7, 1, "#3a2a1c")}
        <Show when={props.busy}><g class="rpg-smoke"><rect x="41" y="0" width="3" height="3" fill="#e8e6ef" /></g><g class="rpg-smoke rpg-smoke-2"><rect x="43" y="-3" width="3" height="3" fill="#d9d6e6" /></g></Show>
      </>}>
        {rect(4, 14, 12, 30, "#b9b4c9")}{rect(48, 14, 12, 30, "#b9b4c9")}{rect(16, 22, 32, 22, "#cfcadb")}
        <For each={[4, 8, 12, 48, 52, 56]}>{(x) => rect(x, 10, 4, 5, "#b9b4c9")}</For>
        <For each={[16, 22, 28, 34, 40]}>{(x) => rect(x, 18, 4, 5, "#cfcadb")}</For>
        {rect(4, 30, 12, 2, "#9a94ae")}{rect(48, 30, 12, 2, "#9a94ae")}{rect(16, 38, 32, 2, "#b0abc2")}
        {rect(27, 28, 10, 16, "#5a3b24")}{rect(27, 26, 10, 3, "#5a3b24")}{rect(34, 36, 1.5, 1.5, "#f5c542")}
        {rect(8, 20, 4, 6, light)}{rect(52, 20, 4, 6, light)}{rect(20, 28, 4, 5, light)}{rect(40, 28, 4, 5, light)}
        {rect(31.5, 0, 1, 10, "#5a3b24")}{rect(32.5, 1, 7, 4, roof)}{rect(9.5, 4, 1, 7, "#5a3b24")}{rect(10.5, 5, 5, 3, roof)}
      </Show>
    </svg>
  );
}

function Tree(props: { seed: string }): JSX.Element {
  const dark = pick(["#2f7a3e", "#3b8a47", "#27693a"], props.seed);
  return (
    <svg viewBox="0 0 12 16" class="rpg-art h-9 w-auto" shape-rendering="crispEdges" aria-hidden="true">
      {rect(5, 12, 2, 4, "#6b4426")}{rect(3, 8, 6, 4, dark)}{rect(2, 6, 8, 3, dark)}{rect(4, 3, 4, 4, dark)}{rect(5, 1, 2, 3, dark)}{rect(4, 7, 2, 1, "#5fb36a")}
    </svg>
  );
}

const HEARTS = 5;
/** Hearts for the share of the day's work that finished well. */
function Hearts(props: { rate: number | null }): JSX.Element {
  const full = (): number => (props.rate === null ? HEARTS : Math.round(props.rate * HEARTS));
  return (
    <span class="inline-flex items-center gap-px" aria-hidden="true">
      <For each={Array.from({ length: HEARTS })}>{(_, i) => <Icon name="lucide-heart" class={`size-3 ${i() < full() ? "fill-[#e5484d] text-[#e5484d]" : "text-ink-gray-4"}`} />}</For>
    </span>
  );
}

function Plot(props: { station: Station }): JSX.Element {
  const s = (): Station => props.station;
  const busy = (): boolean => s().working.length > 0;
  return (
    <li ref={watch} class="rpg-plot rpg-grass relative flex min-h-[15.5rem] flex-col items-center gap-2 overflow-hidden p-3 pb-4" data-testid="live-plot" data-busy={busy() || undefined}>
      <span class="absolute start-2 top-3 opacity-90"><Tree seed={s().slug} /></span>
      <span class="absolute end-2 top-5 opacity-90"><Tree seed={`${s().slug}x`} /></span>
      <div class="relative mt-1">
        <Building name={s().name} platform={s().platform} busy={busy()} />
        <Show when={s().needs > 0}>
          <A href={`/w/${s().slug}`} class="rpg-quest absolute -top-3 start-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border-2 border-[#7a5200] bg-[#ffd23f] font-display text-lg font-bold text-[#3a2a00]" aria-label={tn("live.rpg.needs", s().needs)}><span aria-hidden="true">!</span></A>
        </Show>
      </div>
      <A href={`/w/${s().slug}/live`} class="rpg-sign flex max-w-full items-center gap-2 px-2.5 py-1 t-small font-semibold">
        <Show when={s().platform}><Icon name="lucide-castle" class="size-3.5" /></Show>
        <bdi class="truncate">{s().name}</bdi>
      </A>
      <div class="flex min-h-[3.5rem] w-full flex-col gap-1.5">
        <For each={s().working.slice(0, 2)}>{(member) => (
          <div class="flex items-end gap-1.5" data-testid="live-hero">
            <span class="rpg-hero relative shrink-0"><Sprite agent={member.agent} pose="work" size={2.5} /><span class="rpg-spark" aria-hidden="true" /></span>
            <p class="rpg-dialog relative min-w-0 flex-1 px-2 py-1 t-small"><span class="flex items-center gap-1 font-semibold"><Icon name={CLASS_ICON[classOf(member.agent)]} class="size-3" /><bdi class="truncate">{member.agent}</bdi></span><span class="line-clamp-2 block" dir="auto">{member.kind === "text" ? `“${member.doing}”` : member.doing}</span></p>
          </div>
        )}</For>
        <Show when={s().working.length > 2}><p class="t-small font-semibold text-[#1b1630]">+{s().working.length - 2}</p></Show>
        <Show when={!busy() && s().recent.length > 0}>
          <div class="flex items-end gap-1" aria-label={t("live.team.quiet")}>
            <For each={s().recent.slice(0, 3)}>{(agent) => <span class="relative"><Sprite agent={agent} pose="walk" size={2} /></span>}</For>
          </div>
        </Show>
        <Show when={!busy() && s().recent.length === 0}><p class="t-small font-medium text-[#1b1630]/80">{t("live.team.quiet")}</p></Show>
      </div>
      <div class="mt-auto flex w-full items-center justify-between gap-2 rounded-[2px] bg-[#1b1630]/80 px-2 py-1 t-small text-white">
        <span class="flex items-center gap-1" title={t("live.rpg.hearts")}><Hearts rate={s().rate} /></span>
        <span class="flex items-center gap-2 tabular-nums">
          <Show when={s().waiting > 0}><span class="flex items-center gap-0.5" title={tn("live.rpg.scrolls", s().waiting)}><Icon name="lucide-scroll" class="size-3.5 text-[#ffd23f]" />{s().waiting}</span></Show>
          <span class="flex items-center gap-0.5" title={t("live.rpg.won")}><Icon name="lucide-trophy" class="size-3.5 text-[#ffd23f]" />{s().done}</span>
          <Show when={s().failed > 0}><span class="flex items-center gap-0.5" title={t("live.rpg.lost")}><Icon name="lucide-skull" class="size-3.5 text-[#ff8a8a]" />{s().failed}</span></Show>
        </span>
      </div>
      <span class="sr-only">{tn("live.team.working", s().working.length)}</span>
    </li>
  );
}

/** The village: a map of plots between dirt roads, a hud with hearts, gold and the progress of the quest. */
export function Village(props: { stations: readonly Station[]; spent: string; progress: number; rate: number | null; party: number }): JSX.Element {
  return (
    <section class="flex flex-col gap-3" aria-labelledby="live-village" data-testid="live-team">
      <div class="flex flex-wrap items-center gap-x-5 gap-y-2 rpg-panel px-3 py-2">
        <h2 id="live-village" class="t-head text-ink">{t("live.rpg.title")}</h2>
        <span class="flex items-center gap-1.5 t-small text-ink-2" title={t("live.rpg.hearts")}><Hearts rate={props.rate} /><span>{props.rate === null ? t("live.tile.rate.none") : t("live.tile.rate", { n: Math.round(props.rate * 100) })}</span></span>
        <span class="flex items-center gap-1.5 t-small text-ink-2"><span class="grid size-4 place-items-center rounded-full bg-[#ffd23f] text-[0.55rem] font-bold text-[#3a2a00]" aria-hidden="true">$</span>{t("live.rpg.gold", { n: props.spent })}</span>
        <span class="flex items-center gap-1.5 t-small text-ink-2"><Icon name="lucide-users" class="size-4" />{tn("live.team.working", props.party)}</span>
        <span class="ms-auto flex min-w-[8rem] flex-1 items-center gap-2 sm:max-w-[16rem]" title={t("live.rpg.progress")}>
          <span class="t-small text-ink-2">{t("live.rpg.progress")}</span>
          <span class="rpg-xp h-2.5 flex-1" role="progressbar" aria-label={t("live.rpg.progress")} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(props.progress * 100)}><span style={{ width: `${Math.round(props.progress * 100)}%` }} /></span>
        </span>
      </div>
      <ul class="rpg-map grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t("live.rpg.title")}>
        <For each={props.stations}>{(station) => <Plot station={station} />}</For>
      </ul>
    </section>
  );
}
