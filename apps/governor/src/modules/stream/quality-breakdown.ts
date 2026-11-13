import type { ActorContext } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { QUALITY_WINDOW_DAYS } from "./quality";

/**
 * The quality dashboard read model (Phase 4): the same figures as the Quality summary (parked work stays in the denominator), broken
 * down per workspace and per practice, with a daily trend. A workspace's practice is its `practice:<id>` tag; a workspace without one is
 * grouped as "untagged". Deterministic from stored records, no model, and only quality:read may ask.
 */
const DAY_MS = 86_400_000;

interface Figures {
  verified: number;
  verifiedUnaided: number;
  parkedOpen: number;
  stalled: number;
  activeTasks: number;
  missionsAchieved: number;
  missionsOpen: number;
  spendMicroUsd: number;
}
interface Day { readonly day: string; verified: number; parked: number }
export interface BreakdownRow {
  readonly figures: Figures;
  readonly rates: { readonly verifiedUnaided?: number; readonly stall?: number };
  readonly daily: readonly Day[];
}
export interface QualityBreakdown {
  readonly window: { readonly from: string; readonly to: string; readonly days: number };
  readonly definition: string;
  readonly total: BreakdownRow;
  readonly workspaces: ReadonlyArray<BreakdownRow & { readonly workspaceId: string; readonly name: string; readonly practice: string }>;
  readonly practices: ReadonlyArray<BreakdownRow & { readonly practice: string; readonly workspaces: number }>;
}

const empty = (): Figures => ({ verified: 0, verifiedUnaided: 0, parkedOpen: 0, stalled: 0, activeTasks: 0, missionsAchieved: 0, missionsOpen: 0, spendMicroUsd: 0 });
const add = (into: Figures, from: Figures): void => { for (const key of Object.keys(into) as Array<keyof Figures>) into[key] += from[key]; };
const rates = (f: Figures): BreakdownRow["rates"] => ({
  ...(f.verified + f.parkedOpen > 0 ? { verifiedUnaided: f.verifiedUnaided / (f.verified + f.parkedOpen) } : {}),
  ...(f.activeTasks > 0 ? { stall: f.stalled / f.activeTasks } : {}),
});
const dayKey = (ms: number): string => iso(ms).slice(0, 10);

/** The breakdown for an organization's active workspaces, over the trailing window. Pure reads. */
export function qualityBreakdownFor(store: Store, organizationId: string): QualityBreakdown {
  const to = store.now();
  const from = to - QUALITY_WINDOW_DAYS * DAY_MS;
  const days = Array.from({ length: QUALITY_WINDOW_DAYS }, (_, index) => dayKey(from + (index + 1) * DAY_MS));
  const trend = (): Map<string, Day> => new Map(days.map((day) => [day, { day, verified: 0, parked: 0 }]));
  const workspaces = store.control.prepare("SELECT id, slug, tags_json FROM workspaces WHERE organization_id=? AND status='active' ORDER BY id").all(organizationId) as Array<{ id: string; slug: string; tags_json: string }>;

  const totalFigures = empty(); const totalTrend = trend();
  const byPractice = new Map<string, { figures: Figures; trend: Map<string, Day>; workspaces: number }>();
  const rows: QualityBreakdown["workspaces"][number][] = [];
  for (const workspace of workspaces) {
    const tag = (JSON.parse(workspace.tags_json) as string[]).find((entry) => entry.startsWith("practice:"));
    const practice = tag ? tag.slice("practice:".length) : "untagged";
    const db = store.workspaceDb(workspace.id, organizationId);
    const figures = empty(); const daily = trend();
    const doneIds = (db.prepare("SELECT DISTINCT aggregate_id AS id FROM events WHERE event_type='workItem.transitioned' AND json_extract(payload_json,'$.state')='done' AND created_at_ms>=?").all(from) as Array<{ id: string }>).map((row) => row.id);
    figures.verified = doneIds.length;
    for (const id of doneIds) {
      const handoff = db.prepare("SELECT submitted_by FROM handoffs WHERE work_item_id=? AND superseded_by IS NULL ORDER BY version DESC LIMIT 1").get(id) as { submitted_by: string } | undefined;
      if (handoff?.submitted_by === "governor") figures.verifiedUnaided++;
    }
    figures.activeTasks = (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE updated_at_ms>=? OR created_at_ms>=?").get(from, from) as { n: number }).n;
    figures.stalled = (db.prepare("SELECT COUNT(DISTINCT aggregate_id) AS n FROM events WHERE event_type='workItem.parked' AND created_at_ms>=?").get(from) as { n: number }).n;
    figures.parkedOpen = (db.prepare("SELECT COUNT(DISTINCT e.aggregate_id) AS n FROM events e JOIN work_items w ON w.id=e.aggregate_id WHERE e.event_type='workItem.parked' AND e.created_at_ms>=? AND w.state NOT IN ('done','abandoned')").get(from) as { n: number }).n;
    figures.spendMicroUsd = (db.prepare("SELECT COALESCE(SUM(settled_micro_usd),0) AS n FROM mission_spend WHERE settled_at_ms>=?").get(from) as { n: number }).n;
    figures.missionsAchieved = (db.prepare("SELECT COUNT(*) AS n FROM missions WHERE state='closed' AND outcome='achieved' AND updated_at_ms>=?").get(from) as { n: number }).n;
    figures.missionsOpen = (db.prepare("SELECT COUNT(*) AS n FROM missions WHERE state NOT IN ('closed')").get() as { n: number }).n;
    for (const row of db.prepare("SELECT strftime('%Y-%m-%d', created_at_ms/1000, 'unixepoch') AS day, event_type AS type, COUNT(DISTINCT aggregate_id) AS n FROM events WHERE created_at_ms>=? AND ((event_type='workItem.transitioned' AND json_extract(payload_json,'$.state')='done') OR event_type='workItem.parked') GROUP BY day, type").all(from) as Array<{ day: string; type: string; n: number }>) {
      const bucket = daily.get(row.day);
      if (bucket) { if (row.type === "workItem.parked") bucket.parked = row.n; else bucket.verified = row.n; }
    }
    rows.push({ workspaceId: workspace.id, name: workspace.slug, practice, figures, rates: rates(figures), daily: [...daily.values()] });
    add(totalFigures, figures);
    const group = byPractice.get(practice) ?? { figures: empty(), trend: trend(), workspaces: 0 };
    add(group.figures, figures); group.workspaces++;
    for (const [day, bucket] of daily) {
      const g = group.trend.get(day)!; g.verified += bucket.verified; g.parked += bucket.parked;
      const t = totalTrend.get(day)!; t.verified += bucket.verified; t.parked += bucket.parked;
    }
    byPractice.set(practice, group);
  }
  return {
    window: { from: iso(from), to: iso(to), days: QUALITY_WINDOW_DAYS },
    definition: "Per workspace and per practice (the workspace's practice:<id> tag), over the trailing 30 days: tasks verified, how many the Governor verified alone, tasks that parked and never reached Done (they stay in the denominator of the unaided rate, so parking cannot raise it), the stall rate, and a daily trend of tasks done and tasks parked.",
    total: { figures: totalFigures, rates: rates(totalFigures), daily: [...totalTrend.values()] },
    workspaces: rows,
    practices: [...byPractice].sort(([a], [b]) => a.localeCompare(b)).map(([practice, group]) => ({ practice, workspaces: group.workspaces, figures: group.figures, rates: rates(group.figures), daily: [...group.trend.values()] })),
  };
}

/** quality.breakdown: only the organization owner (quality:read) may ask. */
export function qualityBreakdown(store: Store, actor: ActorContext): QualityBreakdown {
  if (!actor.scopes.includes("quality:read")) throw new BrainDomainError("FORBIDDEN", "the Quality page requires quality:read");
  return qualityBreakdownFor(store, actor.organizationId);
}
