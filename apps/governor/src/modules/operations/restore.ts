import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256Digest } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { assertRegularFile } from "../../infrastructure/persistence/directory";
import type { BrainAuth } from "../identity/index";

const markerSchema = z.object({
  format: z.literal("brain.restore/v1"), restoreId: z.uuid(), backupId: z.uuid(),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), restoredAt: z.iso.datetime(),
  authorityWatermarks: z.array(z.object({
    id: z.string().min(1).max(256),
    revocationGeneration: z.number().int().min(1),
    activeReleaseDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
    primitiveVersions: z.number().int().min(0),
  }).strict()).max(10_000).optional(),
}).strict();

export function quarantineRestoredAuthority(s: Store, auth: Pick<BrainAuth, "revokeAllSessions">): void {
  const path = join(s.dataDir, "RESTORED-SUSPENDED.json");
  if (!existsSync(path)) return;
  assertRegularFile(path);
  const bytes = readFileSync(path);
  if (bytes.length > 4096) throw new BrainDomainError("INVALID_CONTRACT", "restore marker too large");
  const marker = markerSchema.parse(JSON.parse(bytes.toString("utf8")));
  const digest = sha256Digest(bytes);
  s.inTx(s.control, () => {
    const applied = s.control.prepare("SELECT payload_digest FROM inbox WHERE source_id='operations.restore' AND event_id=?").get(marker.restoreId) as { payload_digest: string } | undefined;
    if (applied) {
      if (applied.payload_digest !== digest) throw new BrainDomainError("CONFLICT", "restore identity reused with changed marker");
      return;
    }
    const now = s.now();
    if (marker.authorityWatermarks) {
      // A restored control.db whose authority generation is behind the
      // archive marker means mixed archive parts — refuse before quarantine.
      for (const watermark of marker.authorityWatermarks) {
        const row = s.control.prepare("SELECT revocation_generation FROM organizations WHERE id=?").get(watermark.id) as { revocation_generation: number } | undefined;
        if (!row || row.revocation_generation < watermark.revocationGeneration) {
          throw new BrainDomainError("CONFLICT", `restored authority watermark for ${watermark.id} is behind the archive; archive parts are inconsistent`);
        }
      }
    }
    auth.revokeAllSessions();
    for (const table of ["machine_sessions", "runner_sessions", "runner_identity_credentials", "delegated_grants", "step_up_evidence", "permit_credentials"]) {
      s.control.prepare(`UPDATE ${table} SET revoked_at_ms=? WHERE revoked_at_ms IS NULL`).run(now);
    }
    s.control.prepare("UPDATE enrollment_tokens SET consumed_at_ms=? WHERE consumed_at_ms IS NULL").run(now);
    s.control.prepare("UPDATE runner_challenges SET consumed_at_ms=? WHERE consumed_at_ms IS NULL").run(now);
    s.control.prepare("UPDATE step_up_challenges SET expires_at_ms=0").run();
    s.control.prepare("UPDATE approval_requests SET state='revoked', version=version+1 WHERE state IN ('pending','approved')").run();
    s.control.prepare("UPDATE effect_permits SET state='revoked' WHERE state='issued'").run();
    // Started or ambiguous effects keep their guards until independent reconciliation.
    s.control.prepare("UPDATE resource_leases SET unresolved_effect=1").run();
    s.control.prepare("UPDATE job_attempts SET state='outcome_unknown' WHERE state IN ('offered','running','uploading','cancelling','verifying')").run();
    s.control.prepare("UPDATE jobs SET state='outcome_unknown', version=version+1 WHERE state IN ('offered','running','verifying')").run();
    s.control.prepare("UPDATE jobs SET state='blocked', queue_reason='restore_pending', version=version+1 WHERE state='queued'").run();
    s.control.prepare("UPDATE runners SET admin_state='quarantined', session_epoch=session_epoch+1").run();
    s.control.prepare("UPDATE workspaces SET status='restore_pending', version=version+1 WHERE status<>'archived'").run();
    s.control.prepare("UPDATE outbox_deliveries SET state='parked' WHERE state IN ('pending','processing')").run();
    s.control.prepare("UPDATE wake_intents SET state='parked' WHERE state IN ('pending','resuming')").run();
    s.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1").run();
    for (const org of s.control.prepare("SELECT id FROM organizations").all() as Array<{ id: string }>) {
      s.emit(s.control, { organizationId: org.id, aggregateType: "operations", aggregateId: marker.restoreId, eventType: "operations.restored-authority-quarantined", payload: { restoreId: marker.restoreId, backupId: marker.backupId, quarantinedAt: s.nowIso() } });
    }
    // Same transaction as revocation: a crash cannot replay half of this operation.
    s.control.prepare("INSERT INTO inbox(source_id,event_id,payload_digest,applied_at_ms) VALUES ('operations.restore',?,?,?)").run(marker.restoreId, digest, now);
  });
}
