import { domainDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { cronFireId, dueCronFires, parseCron } from "../workflows/index";

/**
 * Durable cron dispatch (T19 runtime wiring): declared `Schedule` documents in
 * the active release are fired exactly once per scheduled minute. Deduplication
 * keys on (schedule_id, release_digest, scheduled_at_ms); the dispatch
 * execution key is the cron fire id, so a replayed start is idempotent even
 * across crash/restart. First sight of a schedule starts from *now* — there is
 * no historical catch-up, per the current-target policy.
 */
export function runScheduledDispatch(
  s: Store,
  deps: {
    activeRelease: (organizationId: string) => { digest: string; manifest: string } | undefined;
    resolveWorkflow: (organizationId: string, workflowId: string) => { workflow: unknown; configDigest: string };
    startRun: (input: { organizationId: string; workspaceId: string; actorId: string; workflowId: string; workflow: unknown; configDigest: string; runInput: JsonValue; executionKey: string }) => { runId: string };
  },
): { dispatched: number; skipped: number } {
  let dispatched = 0;
  let skipped = 0;
  const now = s.now();
  const orgs = s.control.prepare("SELECT organization_id FROM active_config").all() as Array<{ organization_id: string }>;
  for (const { organization_id: organizationId } of orgs) {
    const rel = deps.activeRelease(organizationId);
    if (!rel) continue;
    let parsed: { documents?: Array<Record<string, unknown>> };
    try { parsed = JSON.parse(rel.manifest) as typeof parsed; } catch { continue; }
    const workspaceId = firstWorkspace(s, organizationId);
    if (!workspaceId) continue;
    for (const doc of parsed.documents ?? []) {
      if (doc["kind"] !== "Schedule") continue;
      const spec = doc["spec"] as { workflow?: { id?: string }; cron?: string; timezone?: string; misfire?: string; enabled?: boolean } | undefined;
      if (!spec?.enabled || !spec.cron || !spec.workflow?.id) { skipped++; continue; }
      let specParsed;
      try { specParsed = parseCron(spec.cron); } catch { skipped++; continue; }
      const misfire = spec.misfire === "skip" ? "skip" as const : "once" as const;
      const prior = s.control.prepare("SELECT MAX(scheduled_at_ms) AS m FROM schedule_fires WHERE schedule_id=? AND release_digest=?")
        .get(String(doc["id"]), rel.digest) as { m: number | null };
      let lastFireMs: number;
      if (prior.m === null) {
        // First sight of this schedule in this release: anchor at now and
        // persist the anchor, or every pass would re-anchor and never fire.
        lastFireMs = now;
        s.control.prepare("INSERT OR IGNORE INTO schedule_fires(schedule_id, release_digest, scheduled_at_ms, dispatch_id) VALUES (?,?,?,'first-sight-anchor')")
          .run(String(doc["id"]), rel.digest, now);
      } else {
        lastFireMs = prior.m;
      }
      for (const fireMs of dueCronFires(specParsed, spec.timezone ?? "UTC", lastFireMs, now, misfire)) {
        const fireId = cronFireId(String(doc["id"]), fireMs);
        const ins = s.control.prepare("INSERT OR IGNORE INTO schedule_fires(schedule_id, release_digest, scheduled_at_ms, dispatch_id) VALUES (?,?,?,?)")
          .run(String(doc["id"]), rel.digest, fireMs, fireId);
        if (ins.changes === 0) continue;
        try {
          const wfRef = spec.workflow;
          const { workflow, configDigest } = deps.resolveWorkflow(organizationId, wfRef.id ?? "");
          const { runId } = deps.startRun({
            organizationId, workspaceId, actorId: `cron:${String(doc["id"])}`,
            workflowId: wfRef.id ?? "", workflow, configDigest,
            runInput: { scheduleId: doc["id"], fireId, scheduledAt: new Date(fireMs).toISOString() } as unknown as JsonValue,
            executionKey: domainDigest("brain:cron-fire:v1", { organizationId, fireId } as unknown as JsonValue),
          });
          s.control.prepare("UPDATE schedule_fires SET dispatch_id=? WHERE schedule_id=? AND release_digest=? AND scheduled_at_ms=?")
            .run(runId, String(doc["id"]), rel.digest, fireMs);
          dispatched++;
        } catch {
          // The fire stays recorded; the next pass sees it as consumed. A
          // dispatch failure is a workflow-authoring problem, not a reason to
          // spin: leave the marker so misfire policy governs retries.
          skipped++;
        }
      }
    }
  }
  return { dispatched, skipped };
}

function firstWorkspace(s: Store, organizationId: string): string {
  const row = s.control.prepare("SELECT id FROM workspaces WHERE organization_id=? AND status='active' ORDER BY id LIMIT 1").get(organizationId) as { id: string } | undefined;
  return row?.id ?? "";
}
