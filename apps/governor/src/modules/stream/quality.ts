import type { ActorContext, QualitySummary } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

/** The trailing window every figure is computed over. */
export const QUALITY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

type Metric = QualitySummary["metrics"][number];

/**
 * The owner's Quality summary: five figures and the top failure reasons,
 * computed deterministically from existing records (events, work items,
 * handoffs, settled spend) across the organization's active workspaces. No
 * model summarises or tunes anything, and only an actor holding quality:read
 * (the organization owner) may ask.
 */
export function qualitySummary(store: Store, actor: ActorContext): QualitySummary {
  if (!actor.scopes.includes("quality:read")) throw new BrainDomainError("FORBIDDEN", "the Quality page requires quality:read");
  const to = store.now();
  const from = to - QUALITY_WINDOW_DAYS * DAY_MS;
  const workspaces = (store.control.prepare("SELECT id FROM workspaces WHERE organization_id=? AND status='active' ORDER BY id").all(actor.organizationId) as Array<{ id: string }>).map((row) => row.id);

  let verified = 0, verifiedAlone = 0, active = 0, stalled = 0, spend = 0;
  let verifiedMissions = 0, reopened = 0;
  const firstResultMs: number[] = [];
  const reasons = new Map<string, number>();
  for (const workspaceId of workspaces) {
    const db = store.workspaceDb(workspaceId, actor.organizationId);
    const doneIds = (db.prepare("SELECT DISTINCT aggregate_id AS id FROM events WHERE event_type='workItem.transitioned' AND json_extract(payload_json,'$.state')='done' AND created_at_ms>=?").all(from) as Array<{ id: string }>).map((row) => row.id);
    verified += doneIds.length;
    for (const id of doneIds) {
      const handoff = db.prepare("SELECT submitted_by FROM handoffs WHERE work_item_id=? AND superseded_by IS NULL ORDER BY version DESC LIMIT 1").get(id) as { submitted_by: string } | undefined;
      if (handoff?.submitted_by === "governor") verifiedAlone++;
    }
    active += (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE updated_at_ms>=? OR created_at_ms>=?").get(from, from) as { n: number }).n;
    stalled += (db.prepare("SELECT COUNT(DISTINCT aggregate_id) AS n FROM events WHERE event_type='workItem.parked' AND created_at_ms>=?").get(from) as { n: number }).n;
    spend += (db.prepare("SELECT COALESCE(SUM(settled_micro_usd),0) AS n FROM mission_spend WHERE settled_at_ms>=?").get(from) as { n: number }).n;
    for (const row of db.prepare(`SELECT m.created_at_ms AS mission_created, MIN(e.created_at_ms) AS first_done FROM events e JOIN work_items w ON w.id=e.aggregate_id JOIN missions m ON m.id=w.mission_id
      WHERE e.event_type='workItem.transitioned' AND json_extract(e.payload_json,'$.state')='done' GROUP BY w.mission_id HAVING first_done>=?`).all(from) as Array<{ mission_created: number; first_done: number }>) {
      firstResultMs.push(Math.max(0, row.first_done - row.mission_created));
    }
    const stateEvents = db.prepare("SELECT aggregate_id AS id, json_extract(payload_json,'$.missionState') AS state, created_at_ms FROM events WHERE event_type='mission.stateChanged' ORDER BY cursor").all() as Array<{ id: string; state: string; created_at_ms: number }>;
    const verifyingAt = new Map<string, number>();
    const returned = new Set<string>();
    for (const event of stateEvents) {
      if (event.state === "verifying" && event.created_at_ms >= from && !verifyingAt.has(event.id)) verifyingAt.set(event.id, event.created_at_ms);
      else if (event.state === "active" && verifyingAt.has(event.id)) returned.add(event.id);
    }
    verifiedMissions += verifyingAt.size;
    reopened += returned.size;
    for (const row of db.prepare("SELECT parked_diagnostic AS d FROM work_items WHERE parked_diagnostic IS NOT NULL AND updated_at_ms>=?").all(from) as Array<{ d: string }>) {
      const reason = (row.d.split("\n")[0] ?? "").replace(/\d+/g, "N").trim().slice(0, 120);
      if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  const ratio = (numerator: number, denominator: number): Pick<Metric, "value" | "numerator" | "denominator"> => ({ ...(denominator ? { value: numerator / denominator } : {}), numerator, denominator });
  firstResultMs.sort((a, b) => a - b);
  const middle = firstResultMs.length >> 1;
  const median = firstResultMs.length === 0 ? undefined : firstResultMs.length % 2 ? firstResultMs[middle]! : Math.round((firstResultMs[middle - 1]! + firstResultMs[middle]!) / 2);
  const metrics: Metric[] = [
    { id: "verified-unaided", label: "Verified without human help", unit: "ratio", ...ratio(verifiedAlone, verified),
      definition: "Tasks that reached Done in the window with the Governor writing the handoff from independently verified run evidence, divided by all tasks that reached Done in the window." },
    { id: "stall-rate", label: "Stall rate", unit: "ratio", ...ratio(stalled, active),
      definition: "Tasks parked after repeated failures in the window, divided by tasks created or changed in the window." },
    { id: "reopen-rate", label: "Re-open rate after Done", unit: "ratio", ...ratio(reopened, verifiedMissions),
      definition: "Missions that entered Verifying in the window and were later sent back to Active, divided by all missions that entered Verifying in the window." },
    { id: "cost-per-verified-task", label: "Cost per verified task", unit: "micro-usd", ...(verified ? { value: Math.round(spend / verified) } : {}), numerator: spend, denominator: verified,
      definition: "Model spend settled in the window across all missions, divided by tasks that reached Done in the window." },
    { id: "time-to-first-result", label: "Median time to first result", unit: "ms", ...(median !== undefined ? { value: median } : {}), denominator: firstResultMs.length,
      definition: "Median time from a mission being created to its first task reaching Done, over missions whose first result came in the window." },
  ];
  return {
    window: { from: iso(from), to: iso(to), days: QUALITY_WINDOW_DAYS },
    metrics,
    failureReasons: {
      definition: "Diagnostics of tasks parked in the window, grouped by their first line with numbers masked; raw codes until a failure taxonomy exists.",
      items: [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([reason, count]) => ({ reason, count })),
    },
  };
}
