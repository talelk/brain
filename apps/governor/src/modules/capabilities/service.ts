import { domainDigest } from "@brain/contracts";
import type {
  ActorContext, CapabilityCandidate, CapitalizationRun, EvidenceBundle, JsonValue,
  KnowledgeAsset, ReleaseRef, ToolCatalogEntry,
} from "@brain/contracts";
import type { Store } from "../../application/store";
import { activeReleaseRecord } from "../configuration/index";
import { requireWorkspaceRead, scopesForPrincipal } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { transitionState } from "../../domain/states";
import { iso } from "../../domain/clock";
import { looksLikeSecret, type MemoryStore, type ReuseService } from "../knowledge/index";
import { putBytes } from "../artifacts/index";
import { readableSources, toolAvailability } from "../resources/index";
import { buildWriteup, goalKey } from "./writeup";
import { workingMs } from "../missions/index";

interface ToolUsage { calls: number; failures: number; lastCallAt?: string; lastCallRunId?: string; lastFailureAt?: string; lastFailureRunId?: string; lastFailureMessage?: string }

export interface CapitalizationCommand {
  readonly commandId: string;
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OperationObservationInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly signature: string;
  readonly rootOperationId: string;
  readonly packageDigest: string;
  readonly evidenceDigest: string;
  readonly operationId: string;
  readonly parameterShape: Readonly<Record<string, string>>;
  readonly effectClass: "read" | "write" | "privileged";
  readonly verified: boolean;
}

/** Knowledge the Review inbox decides: a finished mission's write-up, or a document a person (or Brain) saved. */
const REVIEWABLE: readonly string[] = ["mission-knowledge", "saved-document"];
/** The most of a saved document's text that is proposed (and published) as knowledge. */
const SAVED_DOCUMENT_CHARS = 20_000;
const REMOVED_NOTE = "The document was removed";
/** Prefix of the note on a write-up the automatic path set aside for a person (a secret); the Library counts these as needing a person. */
const NEEDS_PERSON_NOTE = "Left for a person";

type AssetRow = {
  id: string; signature: string; operation_id: string; state: KnowledgeAsset["state"];
  classification: KnowledgeAsset["classification"]; content: string; source_count: number;
  title: string; mission_id: string | null; producer_id: string | null; provenance_json: string;
  reviewed_by: string | null; self_reviewed: number; reviewed_at_ms: number | null; rejection_reason: string | null; content_digest: string | null;
  superseded_by: string | null; auto_published: number;
  created_at_ms: number; updated_at_ms: number;
};
type CandidateRow = {
  id: string; signature: string; state: CapabilityCandidate["state"]; source_count: number;
  package_digest: string; operation_id: string; effect_class: CapabilityCandidate["effectClass"];
  test_status: CapabilityCandidate["testStatus"]; definition_json: string; created_by: string;
  reviewer_id: string | null; reviewed_at_ms: number | null; published_at_ms: number | null; created_at_ms: number;
};
type RunRow = {
  id: string; state: CapitalizationRun["state"]; requested_by: string; observed_count: number;
  extracted_count: number; candidate_count: number; error: string | null; created_at_ms: number;
  started_at_ms: number | null; completed_at_ms: number | null;
};
type CandidateDefinition = {
  inputSchema: JsonValue;
  testFixtures: string[];
  existingAlternatives: ReleaseRef[];
};

function digestId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/^sha256:/u, "").slice(0, 24)}`;
}

function parameterShape(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, Array.isArray(item) ? "array" : item === null ? "null" : typeof item]));
}

export interface CapitalizationPorts { readonly memory: MemoryStore; readonly reuse: ReuseService }

export class CapitalizationService {
  constructor(private readonly store: Store, private readonly ports: CapitalizationPorts) {}

  apply(actor: ActorContext, command: CapitalizationCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    requireWorkspaceRead(this.store, actor, workspaceId);
    switch (command.commandType) {
      case "capitalization.run": return this.requestRun(actor, workspaceId, command.commandId, command.payload["missionId"] ? String(command.payload["missionId"]) : undefined);
      case "capability.review": return this.review(actor, workspaceId, command.payload);
      case "tool.propose": return this.propose(actor, workspaceId, command.payload);
      case "tool.publish": return this.publish(actor, workspaceId, command.payload);
      case "knowledge.review": return this.reviewKnowledge(actor, workspaceId, command.payload);
      case "knowledge.approveVerified": return this.approveVerified(actor, workspaceId);
      case "library.settings.set": return this.setLibrarySettings(actor, workspaceId, command.payload);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported capitalization command ${command.commandType}`);
    }
  }

  capture(input: OperationObservationInput): JsonValue {
    const workspace = this.store.control.prepare("SELECT 1 FROM workspaces WHERE id=? AND organization_id=?").get(input.workspaceId, input.organizationId);
    if (!workspace) throw new BrainDomainError("NOT_FOUND", "workspace not found");
    if (!/^sha256:[0-9a-f]{64}$/u.test(input.signature) || !/^sha256:[0-9a-f]{64}$/u.test(input.packageDigest) || !/^sha256:[0-9a-f]{64}$/u.test(input.evidenceDigest)) {
      throw new BrainDomainError("INVALID_ARGUMENT", "operation signature, package and evidence must be SHA-256 digests");
    }
    if (!input.operationId || input.operationId.length > 256 || !input.rootOperationId || input.rootOperationId.length > 256 || looksLikeSecret(input.operationId)) {
      throw new BrainDomainError("INVALID_ARGUMENT", "operation identity is malformed or contains a secret");
    }
    if (input.verified) this.assertVerifiedEvidence(input.organizationId, input.workspaceId, input.evidenceDigest);
    const db = this.store.workspaceDb(input.workspaceId, input.organizationId);
    const runId = digestId("caprun", domainDigest("brain:capitalization-capture:v1", {
      workspaceId: input.workspaceId, rootRunId: input.rootOperationId, signature: input.signature,
    }));
    let distinctVerifiedRoots = 0;
    this.store.inTx(db, () => {
      const now = this.store.now();
      db.prepare(`INSERT OR IGNORE INTO operation_observations(
        root_run_id,signature,evidence_digest,operation_id,parameter_shape_json,effect_class,package_digest,verified_success,created_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        input.rootOperationId, input.signature, input.evidenceDigest, input.operationId,
        JSON.stringify(input.parameterShape), input.effectClass, input.packageDigest, input.verified ? 1 : 0, now,
      );
      db.prepare("INSERT OR IGNORE INTO capitalization_runs(id,state,requested_by,created_at_ms) VALUES (?,'queued','verified-evidence',?)").run(runId, now);
      distinctVerifiedRoots = (db.prepare("SELECT COUNT(*) AS count FROM operation_observations WHERE signature=? AND verified_success=1").get(input.signature) as { count: number }).count;
    });
    const candidate = db.prepare("SELECT id FROM tool_candidates WHERE signature=?").get(input.signature) as { id: string } | undefined;
    return { signature: input.signature, distinctVerifiedRoots, candidateId: candidate?.id ?? null, runId } as unknown as JsonValue;
  }

  captureVerifiedBundle(organizationId: string, workspaceId: string, evidenceDigest: string): JsonValue | null {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const evidence = db.prepare("SELECT manifest_json FROM evidence_bundles WHERE digest=? AND state='verified'").get(evidenceDigest) as { manifest_json: string } | undefined;
    if (!evidence) return null;
    const bundle = JSON.parse(evidence.manifest_json) as EvidenceBundle;
    const job = this.store.control.prepare(`SELECT j.effect_class,p.kind,p.payload_json FROM jobs j JOIN job_payloads p ON p.job_id=j.id
      WHERE j.id=? AND j.organization_id=? AND j.workspace_id=?`).get(bundle.jobId, organizationId, workspaceId) as
      | { effect_class: "read" | "write" | "privileged"; kind: string; payload_json: string } | undefined;
    if (!job || job.kind === "eval") return null;
    const step = (JSON.parse(job.payload_json) as { step?: { input?: unknown; uses?: { release?: ReleaseRef } } }).step;
    const release = step?.uses?.release;
    if (!release) return null;
    const shape = parameterShape(step?.input);
    const signature = domainDigest("brain:operation-signature:v1", {
      operationId: release.id, parameterShape: shape, effectClass: job.effect_class,
    });
    return this.capture({
      organizationId, workspaceId, signature, rootOperationId: bundle.workflowRunId,
      packageDigest: release.digest, evidenceDigest, operationId: release.id,
      parameterShape: shape, effectClass: job.effect_class, verified: true,
    });
  }

  private assertVerifiedEvidence(organizationId: string, workspaceId: string, digest: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const verified = db.prepare(`SELECT 1 FROM evidence_bundles b JOIN verification_verdicts v ON v.bundle_digest=b.digest
      WHERE b.digest=? AND b.state='verified' AND v.outcome='verified'`).get(digest);
    if (!verified) throw new BrainDomainError("EVIDENCE_MISSING", "capitalization requires a verified evidence bundle and verdict");
  }

  private requestRun(actor: ActorContext, workspaceId: string, commandId: string, missionId?: string): string {
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    if (missionId && !db.prepare("SELECT 1 FROM missions WHERE id=?").get(missionId)) throw new BrainDomainError("NOT_FOUND", "mission not found");
    const id = digestId("caprun", domainDigest("brain:capitalization-request:v1", { workspaceId, commandId }));
    this.store.inTx(db, () => {
      db.prepare("INSERT OR IGNORE INTO capitalization_runs(id,state,requested_by,mission_id,created_at_ms) VALUES (?,'queued',?,?,?)").run(id, actor.actorId, missionId ?? null, this.store.now());
    });
    return id;
  }

  /** One capitalization run per mission close, whatever the outcome (#42). */
  requestMissionRun(organizationId: string, workspaceId: string, missionId: string): string {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const id = digestId("caprun", domainDigest("brain:capitalization-mission-close:v1", { workspaceId, missionId }));
    db.prepare("INSERT OR IGNORE INTO capitalization_runs(id,state,requested_by,mission_id,created_at_ms) VALUES (?,'queued','mission-close',?,?)").run(id, missionId, this.store.now());
    return id;
  }

  /**
   * One readable knowledge asset per achieved mission (#67, row 48), built from verified
   * material with a fixed template and no model call: see `writeup.ts`. A mission below the
   * substance threshold is not written up. A newer write-up of the same goal supersedes the
   * older one (it leaves search and the Review inbox, and says what replaced it). Member
   * notes, handoff notes, messages and transcripts are never read (GLOSSARY: Capitalization
   * run). Provenance is the mission's evidence bundles.
   */
  private extractMissionKnowledge(organizationId: string, workspaceId: string, db: ReturnType<Store["workspaceDb"]>, missionId: string, now: number): number {
    const prepared = this.writeupOf(db, missionId);
    if (!prepared || prepared.writeup.skipped) return 0;
    const { mission, writeup, provenance, bundles } = prepared;
    const signature = domainDigest("brain:mission-knowledge:v1", { missionId });
    const id = digestId("knowledge", signature);
    const inserted = db.prepare(`INSERT OR IGNORE INTO knowledge_assets(id,signature,operation_id,state,classification,content,source_count,title,mission_id,producer_id,provenance_json,created_at_ms,updated_at_ms)
      VALUES (?,?, 'mission-knowledge', 'extracted', 'internal', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, signature, writeup.content, Math.max(1, bundles), writeup.title, missionId, mission.owner_id, JSON.stringify(provenance), now, now);
    if (Number(inserted.changes) > 0) this.supersedeSameGoal(organizationId, workspaceId, db, id, mission.intent, now);
    return Number(inserted.changes);
  }

  /** The write-up of an achieved, verified mission, or nothing when the mission is not closed as achieved. */
  private writeupOf(db: ReturnType<Store["workspaceDb"]>, missionId: string) {
    const mission = db.prepare("SELECT id, title, intent, success_criteria_json, owner_id, outcome, state FROM missions WHERE id=?").get(missionId) as
      | { id: string; title: string; intent: string; success_criteria_json: string; owner_id: string; outcome: string | null; state: string } | undefined;
    if (!mission || mission.state !== "closed" || mission.outcome !== "achieved") return undefined;
    const bundles = db.prepare("SELECT digest, state, findings_json, created_at_ms FROM mission_evidence_bundles WHERE mission_id=? AND state IN ('verified','rejected') ORDER BY created_at_ms, rowid").all(missionId) as Array<{ digest: string; state: "verified" | "rejected"; findings_json: string; created_at_ms: number }>;
    const verified = bundles.filter((bundle) => bundle.state === "verified").at(-1);
    if (!verified) return undefined;
    const writeup = buildWriteup(this.store, db, { ...mission, active_ms: workingMs(this.store, db, missionId, this.store.now()) }, verified, bundles.filter((bundle) => bundle.state === "rejected"));
    const evidence = (db.prepare("SELECT DISTINCT evidence_digest FROM mission_bundle_checks WHERE bundle_digest=? AND advisory=0 AND outcome='passed' ORDER BY evidence_digest").all(verified.digest) as Array<{ evidence_digest: string }>).map((row) => row.evidence_digest);
    const provenance = [verified.digest, ...evidence].slice(0, 20).map((evidenceDigest) => ({ rootRunId: missionId, evidenceDigest }));
    return { mission, writeup, provenance, bundles: bundles.length };
  }

  /**
   * A write-up supersedes the strictly older write-ups of the same goal (same words, ignoring case and punctuation), never a newer one.
   * A published older one leaves search and reuse at once; an unreviewed one leaves the Review inbox. Nothing is deleted.
   */
  private supersedeSameGoal(organizationId: string, workspaceId: string, db: ReturnType<Store["workspaceDb"]>, newId: string, intent: string, now: number): void {
    const key = goalKey(intent);
    const current = db.prepare("SELECT created_at_ms FROM knowledge_assets WHERE id=?").get(newId) as { created_at_ms: number } | undefined;
    if (!current) return;
    const older = db.prepare(`SELECT a.id, a.state, m.intent FROM knowledge_assets a JOIN missions m ON m.id=a.mission_id
      WHERE a.operation_id='mission-knowledge' AND a.superseded_by IS NULL AND a.state IN ('extracted','reviewed','published')
        AND (a.created_at_ms < ? OR (a.created_at_ms = ? AND a.id < ?)) ORDER BY a.created_at_ms LIMIT 500`).all(current.created_at_ms, current.created_at_ms, newId) as Array<{ id: string; state: string; intent: string }>;
    for (const row of older) {
      if (goalKey(row.intent) !== key) continue;
      if (row.state === "published") {
        this.ports.memory.revoke(organizationId, workspaceId, row.id);
        db.prepare("UPDATE knowledge_assets SET state='revoked',superseded_by=?,rejection_reason='Replaced by a newer write-up of the same goal',updated_at_ms=? WHERE id=?").run(newId, now, row.id);
        this.ports.reuse.unindex(organizationId, workspaceId, `knowledge:${row.id}`);
      } else {
        db.prepare("UPDATE knowledge_assets SET superseded_by=?,rejection_reason='Replaced by a newer write-up of the same goal',updated_at_ms=? WHERE id=?").run(newId, now, row.id);
      }
    }
  }

  /** The newer, still-live write-up of the same goal that replaces this one, if there is one. */
  private newerSameGoal(db: ReturnType<Store["workspaceDb"]>, asset: AssetRow): string | undefined {
    const intent = (db.prepare("SELECT intent FROM missions WHERE id=?").get(asset.mission_id) as { intent: string } | undefined)?.intent;
    if (intent === undefined) return undefined;
    const key = goalKey(intent);
    const newer = db.prepare(`SELECT a.id, m.intent FROM knowledge_assets a JOIN missions m ON m.id=a.mission_id
      WHERE a.operation_id='mission-knowledge' AND a.superseded_by IS NULL AND a.state IN ('extracted','reviewed','published')
        AND (a.created_at_ms > ? OR (a.created_at_ms = ? AND a.id > ?)) ORDER BY a.created_at_ms DESC LIMIT 500`).all(asset.created_at_ms, asset.created_at_ms, asset.id) as Array<{ id: string; intent: string }>;
    return newer.find((row) => goalKey(row.intent) === key)?.id;
  }

  processPending(): { processed: number; failed: number } {
    let processed = 0;
    let failed = 0;
    const workspaces = this.store.control.prepare("SELECT id,organization_id FROM workspaces ORDER BY id").all() as Array<{ id: string; organization_id: string }>;
    for (const workspace of workspaces) {
      const db = this.store.workspaceDb(workspace.id, workspace.organization_id);
      const runs = db.prepare("SELECT id FROM capitalization_runs WHERE state IN ('queued','running') ORDER BY created_at_ms,id LIMIT 10").all() as Array<{ id: string }>;
      for (const run of runs) {
        try {
          this.processRun(workspace.id, workspace.organization_id, run.id);
          processed++;
        } catch (error) {
          failed++;
          const current = db.prepare("SELECT state FROM capitalization_runs WHERE id=?").get(run.id) as { state: string } | undefined;
          if (current && current.state !== "succeeded") {
            transitionState(db, "capitalizationRun", run.id, "failed", { set: { error: error instanceof Error ? error.message.slice(0, 1000) : "capitalization failed", completed_at_ms: this.store.now() } });
          }
        }
      }
      // A finished run may have left a verified write-up that publishes itself (row 47); a crash between the two is repaired by the next pass.
      try { this.syncSavedDocuments(workspace.organization_id, workspace.id); } catch { /* the next pass tries again */ }
      try { this.autoPublishSweep(workspace.organization_id, workspace.id); } catch { /* the inbox keeps it */ }
    }
    return { processed, failed };
  }

  private processRun(workspaceId: string, organizationId: string, runId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    this.store.inTx(db, () => {
      const run = db.prepare("SELECT state, mission_id FROM capitalization_runs WHERE id=?").get(runId) as { state: string; mission_id: string | null } | undefined;
      if (!run || run.state === "succeeded" || run.state === "failed") return;
      const now = this.store.now();
      transitionState(db, "capitalizationRun", runId, "running", { rawSet: [`started_at_ms=COALESCE(started_at_ms,${now})`, "error=NULL"] });
      if (run.mission_id) {
        const extracted = this.extractMissionKnowledge(organizationId, workspaceId, db, run.mission_id, now);
        // An achieved mission is also offered for reuse (#66); the reuse index re-checks the live source on every read.
        this.ports.reuse.indexMission(organizationId, workspaceId, run.mission_id);
        transitionState(db, "capitalizationRun", runId, "succeeded", { set: { extracted_count: extracted, completed_at_ms: this.store.now() } });
        return;
      }
      const signatures = db.prepare(`SELECT signature,operation_id,parameter_shape_json,effect_class,package_digest,COUNT(*) AS source_count
        FROM operation_observations WHERE verified_success=1 GROUP BY signature,operation_id,parameter_shape_json,effect_class,package_digest ORDER BY signature`).all() as Array<{
        signature: string; operation_id: string; parameter_shape_json: string; effect_class: "read" | "write" | "privileged"; package_digest: string; source_count: number;
      }>;
      let extracted = 0;
      let candidates = 0;
      for (const group of signatures) {
        const provenance = db.prepare("SELECT root_run_id,evidence_digest FROM operation_observations WHERE signature=? AND verified_success=1 ORDER BY root_run_id").all(group.signature) as Array<{ root_run_id: string; evidence_digest: string }>;
        const assetId = digestId("knowledge", group.signature);
        const content = `Verified operation ${group.operation_id}; ${provenance.length} distinct successful runs; typed shape ${group.parameter_shape_json}. Advisory only; review and release are required before reuse.`;
        const inserted = db.prepare(`INSERT OR IGNORE INTO knowledge_assets(id,signature,operation_id,state,classification,content,source_count,created_at_ms,updated_at_ms)
          VALUES (?,?,?,'extracted','internal',?,?,?,?)`).run(assetId, group.signature, group.operation_id, content, provenance.length, now, now);
        db.prepare(`UPDATE knowledge_assets SET content=?,source_count=?,updated_at_ms=? WHERE signature=? AND state='extracted'`)
          .run(content, provenance.length, now, group.signature);
        if (inserted.changes === 1) {
          extracted++;
          this.store.emit(db, { workspaceId, aggregateType: "knowledge", aggregateId: assetId, eventType: "knowledge.extracted", payload: { resourceId: assetId, workspaceId, state: "extracted" } });
        }
        if (provenance.length < 3) continue;
        const candidateId = digestId("capability", group.signature);
        const existing = db.prepare("SELECT state FROM tool_candidates WHERE signature=?").get(group.signature) as { state: string } | undefined;
        const alternatives = this.activeTools(organizationId).filter((tool) => tool.id === group.operation_id).map((tool) => tool.release);
        const definition: CandidateDefinition = {
          inputSchema: { type: "object", properties: JSON.parse(group.parameter_shape_json) as JsonValue, additionalProperties: false },
          testFixtures: provenance.map((item) => item.evidence_digest), existingAlternatives: alternatives,
        };
        if (!existing) {
          db.prepare(`INSERT INTO tool_candidates(id,signature,state,source_count,package_digest,operation_id,effect_class,test_status,definition_json,created_by,created_at_ms)
            VALUES (?,?,'quarantined',?,?,?,?,'passed',?,'verified-evidence',?)`).run(
            candidateId, group.signature, provenance.length, group.package_digest, group.operation_id, group.effect_class, JSON.stringify(definition), now,
          );
        } else {
          db.prepare("UPDATE tool_candidates SET source_count=? WHERE signature=?").run(provenance.length, group.signature);
          if (existing.state === "quarantined") db.prepare("UPDATE tool_candidates SET definition_json=? WHERE signature=?").run(JSON.stringify(definition), group.signature);
        }
        candidates++;
      }
      const observed = (db.prepare("SELECT COUNT(*) AS count FROM operation_observations WHERE verified_success=1").get() as { count: number }).count;
      transitionState(db, "capitalizationRun", runId, "succeeded", { set: { observed_count: observed, extracted_count: extracted, candidate_count: candidates, completed_at_ms: now } });
      this.store.emit(db, { workspaceId, aggregateType: "capitalization", aggregateId: runId, eventType: "capitalization.completed", payload: { resourceId: runId, workspaceId, state: "succeeded" } });
    });
  }

  private propose(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const pkg = payload["package"] as { artifactId: string; digest: string };
    const evidence = payload["evidence"] as string[];
    if (!db.prepare("SELECT 1 FROM artifacts WHERE id=? AND digest=? AND state='verified'").get(pkg.artifactId, pkg.digest)) {
      throw new BrainDomainError("EVIDENCE_MISSING", "tool package artifact is not verified in this workspace");
    }
    const provenance = db.prepare(`SELECT DISTINCT evidence_digest FROM operation_observations
      WHERE package_digest=? AND verified_success=1 AND evidence_digest IN (${evidence.map(() => "?").join(",")})`).all(pkg.digest, ...evidence) as Array<{ evidence_digest: string }>;
    if (provenance.length < 3) throw new BrainDomainError("EVIDENCE_MISSING", "a proposal requires three distinct verified operation evidence bundles");
    const candidate = db.prepare("SELECT id FROM tool_candidates WHERE package_digest=? ORDER BY created_at_ms LIMIT 1").get(pkg.digest) as { id: string } | undefined;
    if (!candidate) throw new BrainDomainError("CONFLICT", "run capitalization to extract and test this candidate before review");
    return candidate.id;
  }

  private review(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const candidateId = String(payload["candidateId"]);
    const decision = String(payload["decision"]);
    this.store.inTx(db, () => {
      const candidate = db.prepare("SELECT state,test_status,created_by FROM tool_candidates WHERE id=?").get(candidateId) as { state: string; test_status: string; created_by: string } | undefined;
      if (!candidate) throw new BrainDomainError("NOT_FOUND", "capability candidate not found");
      if (candidate.state !== "quarantined") throw new BrainDomainError("CONFLICT", "capability candidate is not awaiting review");
      if (candidate.test_status !== "passed") throw new BrainDomainError("EVIDENCE_MISSING", "candidate tests have not passed");
      if (candidate.created_by === actor.actorId) throw new BrainDomainError("FORBIDDEN", "candidate author cannot review their own proposal");
      const state = decision === "approve" ? "reviewed" : "rejected";
      const now = this.store.now();
      transitionState(db, "capabilityCandidate", candidateId, state, { set: { reviewer_id: actor.actorId, reviewed_at_ms: now } });
      this.store.emit(db, { workspaceId, aggregateType: "capability", aggregateId: candidateId, eventType: "capability.reviewed", payload: { resourceId: candidateId, workspaceId, state } });
    });
    return candidateId;
  }

  private publish(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const release = payload["release"] as ReleaseRef;
    const evidence = new Set(payload["evidence"] as string[]);
    this.store.inTx(db, () => {
      const candidate = db.prepare("SELECT * FROM tool_candidates WHERE package_digest=? AND operation_id=?").get(release.digest, release.id) as CandidateRow | undefined;
      if (!candidate) throw new BrainDomainError("NOT_FOUND", "reviewed capability candidate not found for this exact release");
      if (candidate.state !== "reviewed") throw new BrainDomainError("CONFLICT", "capability candidate requires independent review before publication");
      const active = this.activeTools(actor.organizationId).find((tool) => tool.release.id === release.id && tool.release.digest === release.digest);
      if (!active) throw new BrainDomainError("CONFLICT", "the exact candidate release must be active in configuration before publication");
      const fixtures = (JSON.parse(candidate.definition_json) as CandidateDefinition).testFixtures;
      if (fixtures.length < 3 || fixtures.some((digest) => !evidence.has(digest))) throw new BrainDomainError("EVIDENCE_MISSING", "publication must bind all candidate test evidence");
      for (const digest of fixtures) this.assertVerifiedEvidence(actor.organizationId, workspaceId, digest);
      const now = this.store.now();
      transitionState(db, "capabilityCandidate", candidate.id, "published", { set: { published_at_ms: now } });
      this.store.emit(db, { workspaceId, aggregateType: "capability", aggregateId: candidate.id, eventType: "capability.published", payload: { resourceId: candidate.id, workspaceId, state: "published" } });
    });
    return release.id;
  }

  markKnowledgePublished(organizationId: string, workspaceId: string, sourceId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    db.prepare("UPDATE knowledge_assets SET state='published',updated_at_ms=? WHERE id=? AND state IN ('extracted','reviewed')").run(this.store.now(), sourceId);
    this.ports.reuse.indexKnowledge(organizationId, workspaceId, sourceId);
  }

  markKnowledgeRevoked(organizationId: string, workspaceId: string, sourceId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    db.prepare("UPDATE knowledge_assets SET state='revoked',updated_at_ms=? WHERE id=?").run(this.store.now(), sourceId);
    this.ports.reuse.unindex(organizationId, workspaceId, `knowledge:${sourceId}`);
  }

  /**
   * The Library review inbox decision (#71, ADR 0007). Approve reviews and publishes in one
   * action: secret scan, digest-pinned content artifact, memory publication as reviewed
   * knowledge, then the asset's own state, reviewer and reuse index. Every step is idempotent
   * on the asset id, so a crash between the control.db and workspace.db writes is repaired by
   * repeating the command. Producer is not approver unless nobody else can review (self-reviewed).
   */
  private reviewKnowledge(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person reviews knowledge");
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const assetId = String(payload["assetId"]);
    const decision = String(payload["decision"]);
    const reason = String(payload["reason"] ?? "").trim();
    const asset = db.prepare("SELECT * FROM knowledge_assets WHERE id=?").get(assetId) as AssetRow | undefined;
    if (!asset) throw new BrainDomainError("NOT_FOUND", "knowledge asset not found");
    if (!REVIEWABLE.includes(asset.operation_id)) throw new BrainDomainError("CONFLICT", "only proposed knowledge from a closed mission or a saved document is reviewed here");
    if (decision === "reject") {
      if (asset.state !== "extracted") throw new BrainDomainError("CONFLICT", `a ${asset.state} knowledge asset cannot be rejected`);
      db.prepare("UPDATE knowledge_assets SET rejection_reason=?,updated_at_ms=? WHERE id=?").run(reason.slice(0, 512), this.store.now(), assetId);
      return assetId;
    }
    if (asset.state === "published") return assetId;
    if (asset.state !== "extracted") throw new BrainDomainError("CONFLICT", `a ${asset.state} knowledge asset cannot be approved`);
    if (asset.superseded_by) throw new BrainDomainError("CONFLICT", "a newer write-up of the same goal replaced this one");
    const self = asset.producer_id === actor.actorId;
    if (self && this.otherReviewers(actor.organizationId, workspaceId, actor.actorId).length > 0) {
      throw new BrainDomainError("FORBIDDEN", "another reviewer in this workspace must approve knowledge you produced");
    }
    this.publishAsset(actor.organizationId, workspaceId, asset, actor.actorId, self, false);
    return assetId;
  }

  /** Publication itself, shared by a person's approval and the automatic path: secret scan, content artifact, memory publication, asset state, reuse index. */
  private publishAsset(organizationId: string, workspaceId: string, asset: AssetRow, reviewerId: string, selfReviewed: boolean, auto: boolean): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    if (looksLikeSecret(asset.content) || looksLikeSecret(asset.title)) {
      throw new BrainDomainError("INVALID_ARGUMENT", "this knowledge appears to contain a secret; it was not published");
    }
    const digest = putBytes(this.store, new TextEncoder().encode(asset.content));
    this.ports.memory.publish({ organizationId, workspaceId, sourceId: asset.id, text: asset.content, sourceType: "knowledge", status: "reviewed", title: asset.title, selfReviewed });
    const now = this.store.now();
    this.store.inTx(db, () => {
      db.prepare("UPDATE knowledge_assets SET state='published',reviewed_by=?,self_reviewed=?,auto_published=?,reviewed_at_ms=?,content_digest=?,rejection_reason=NULL,updated_at_ms=? WHERE id=? AND state='extracted'")
        .run(reviewerId, selfReviewed ? 1 : 0, auto ? 1 : 0, now, digest, now, asset.id);
    });
    this.ports.reuse.indexKnowledge(organizationId, workspaceId, asset.id);
  }

  /** Other active people who could review: when none exist, a producer may review their own knowledge (ADR 0007). */
  private otherReviewers(organizationId: string, workspaceId: string, producerId: string): string[] {
    return this.reviewers(organizationId, workspaceId).filter((id) => id !== producerId);
  }

  /** Every active person of the workspace who holds the review scope. */
  private reviewers(organizationId: string, workspaceId: string): string[] {
    const people = this.store.control.prepare(`SELECT p.id FROM principals p JOIN workspace_memberships m ON m.principal_id=p.id AND m.workspace_id=? AND m.revoked_at_ms IS NULL
      WHERE p.organization_id=? AND p.kind='human' AND p.disabled_at_ms IS NULL`).all(workspaceId, organizationId) as Array<{ id: string }>;
    return people.map((row) => row.id).filter((id) => scopesForPrincipal(this.store, id, organizationId, workspaceId).includes("memory:publish"));
  }

  /** Whether verified write-ups publish themselves. On unless the workspace turned it off (library_settings has no row until then). */
  private autoPublishOn(db: ReturnType<Store["workspaceDb"]>): boolean {
    const row = db.prepare("SELECT auto_publish_knowledge AS on_ FROM library_settings WHERE id=1").get() as { on_: number } | undefined;
    return row ? row.on_ === 1 : true;
  }

  private setLibrarySettings(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person changes the Library settings");
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const on = payload["autoPublishKnowledge"] === true ? 1 : 0;
    db.prepare(`INSERT INTO library_settings(id,auto_publish_knowledge,updated_by,updated_at_ms) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET auto_publish_knowledge=excluded.auto_publish_knowledge,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`).run(on, actor.actorId, this.store.now());
    // Turning it on also lets the waiting verified write-ups through, without a second click.
    if (on) this.autoPublishSweep(actor.organizationId, workspaceId);
    return workspaceId;
  }

  /** "Approve all verified": every waiting write-up this person may approve, in one action. Each follows the single-asset rules; the rest stay in the inbox. */
  private approveVerified(actor: ActorContext, workspaceId: string): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person reviews knowledge");
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const waiting = db.prepare("SELECT id FROM knowledge_assets WHERE operation_id IN ('mission-knowledge','saved-document') AND state='extracted' AND rejection_reason IS NULL AND superseded_by IS NULL ORDER BY created_at_ms, id").all() as Array<{ id: string }>;
    for (const row of waiting) {
      try { this.reviewKnowledge(actor, workspaceId, { assetId: row.id, decision: "approve", reason: "Approved with all verified write-ups" }); } catch { /* left in the inbox with its own reason on the next look */ }
    }
    return workspaceId;
  }

  /**
   * The hands-off path for a single-owner install (ADR 0007): a verified mission's write-up publishes itself as
   * self-reviewed by its producer, marked as automatic so the card says so, undoable with Withdraw. It only happens
   * while nobody else could review it, the producer is still an active person, the write-up has no secret, and the
   * workspace setting is on. Anything else stays in the Review inbox. Effects, approvals, capability candidates and
   * tool publication never come through here. A write-up still in the earlier, thinner shape is rebuilt from the
   * mission's stored results first (or set aside when the mission has too little substance).
   */
  autoPublishSweep(organizationId: string, workspaceId: string): number {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    // Notes from before write-ups had a mission and a title have nothing readable to review or publish: set them aside
    // (with the reason) instead of leaving them in the inbox and its count for ever. Nothing is deleted.
    db.prepare("UPDATE knowledge_assets SET rejection_reason='Not kept: an older note with no mission or title, nothing readable to review',updated_at_ms=? WHERE operation_id='mission-knowledge' AND state='extracted' AND mission_id IS NULL AND rejection_reason IS NULL AND superseded_by IS NULL").run(this.store.now());
    if (!this.autoPublishOn(db)) return 0;
    const waiting = db.prepare("SELECT * FROM knowledge_assets WHERE operation_id IN ('mission-knowledge','saved-document') AND state='extracted' AND rejection_reason IS NULL AND superseded_by IS NULL AND (mission_id IS NOT NULL OR operation_id='saved-document') ORDER BY created_at_ms, id").all() as AssetRow[];
    let published = 0;
    for (const listed of waiting) {
      try {
        // Earlier rows of this pass may have changed this one (superseded, set aside): read it again before acting.
        let asset = db.prepare("SELECT * FROM knowledge_assets WHERE id=?").get(listed.id) as AssetRow;
        if (asset.state !== "extracted" || asset.rejection_reason || asset.superseded_by) continue;
        const newer = asset.operation_id === "mission-knowledge" ? this.newerSameGoal(db, asset) : undefined;
        if (newer) {
          db.prepare("UPDATE knowledge_assets SET superseded_by=?,rejection_reason='Replaced by a newer write-up of the same goal',updated_at_ms=? WHERE id=?").run(newer, this.store.now(), asset.id);
          continue;
        }
        if (asset.operation_id === "mission-knowledge" && !asset.content.includes("Claim basis: [verified")) {
          const rebuilt = this.writeupOf(db, asset.mission_id!);
          if (!rebuilt || rebuilt.writeup.skipped) {
            db.prepare("UPDATE knowledge_assets SET rejection_reason=?,updated_at_ms=? WHERE id=?").run(`Not kept: ${rebuilt?.writeup.skipped ?? "the mission is no longer a verified, achieved one"}`.slice(0, 512), this.store.now(), asset.id);
            continue;
          }
          db.prepare("UPDATE knowledge_assets SET content=?,updated_at_ms=? WHERE id=?").run(rebuilt.writeup.content, this.store.now(), asset.id);
          asset = { ...asset, content: rebuilt.writeup.content };
          this.supersedeSameGoal(organizationId, workspaceId, db, asset.id, rebuilt.mission.intent, this.store.now());
        }
        // Whoever closed the mission (a person, or the Governor itself after independent verification) the write-up is the install's own
        // knowledge: it publishes under the one person who could review it. A mission write-up whose producer is not (or no longer) an
        // active reviewer (a departed owner) falls back to the sole reviewer; a saved document of Brain or an agent always waits for a
        // person; with two or more reviewers, or none, everything waits.
        const everyone = this.reviewers(organizationId, workspaceId);
        const producer = asset.producer_id;
        const reviewer = producer && everyone.includes(producer) ? (everyone.length === 1 ? producer : undefined)
          : (asset.operation_id === "mission-knowledge" && everyone.length === 1 ? everyone[0] : undefined);
        if (!reviewer) continue;
        if (looksLikeSecret(asset.content) || looksLikeSecret(asset.title)) {
          db.prepare("UPDATE knowledge_assets SET rejection_reason=?,updated_at_ms=? WHERE id=?").run(`${NEEDS_PERSON_NOTE}: the text appears to contain a secret`, this.store.now(), asset.id);
          continue;
        }
        this.publishAsset(organizationId, workspaceId, asset, reviewer, true, true);
        published++;
      } catch { /* stays in the inbox; the next pass tries again */ }
    }
    return published;
  }

  /**
   * Saved documents become reviewable (row 55). Every readable, active document version that was saved to the workspace is proposed
   * once as a "saved document" asset in the Review inbox; a person approves it (or says Not now) like a write-up. A document saved by a
   * person on a one-person install publishes itself under ADR 0007 (the sweep above); one saved by Brain or by an agent waits for a
   * person. A newer version of the document, or removing it, takes the older proposal out of the inbox and out of search.
   */
  syncSavedDocuments(organizationId: string, workspaceId: string): number {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const now = this.store.now();
    let created = 0;
    const docs = db.prepare(`SELECT d.id, d.title, v.id AS version_id, v.digest, v.extracted_text, v.created_by FROM documents d JOIN document_versions v ON v.id=d.current_version_id
      WHERE d.state='active' AND v.extraction_status='ready' AND v.extracted_text IS NOT NULL ORDER BY d.created_at_ms, d.id LIMIT 500`).all() as Array<{ id: string; title: string; version_id: string; digest: string; extracted_text: string; created_by: string }>;
    for (const doc of docs) {
      const text = doc.extracted_text.trim();
      if (!text) continue;
      const signature = domainDigest("brain:saved-document:v1", { documentId: doc.id, versionId: doc.version_id });
      const id = digestId("knowledge", signature);
      const inserted = db.prepare(`INSERT OR IGNORE INTO knowledge_assets(id,signature,operation_id,state,classification,content,source_count,title,mission_id,producer_id,provenance_json,created_at_ms,updated_at_ms)
        VALUES (?,?, 'saved-document', 'extracted', 'internal', ?, 1, ?, NULL, ?, ?, ?, ?)`)
        .run(id, signature, text.slice(0, SAVED_DOCUMENT_CHARS), doc.title.slice(0, 256), doc.created_by, JSON.stringify([{ rootRunId: doc.id, evidenceDigest: doc.digest }]), now, now);
      if (Number(inserted.changes) > 0) {
        created++;
        this.supersedeDocumentAssets(organizationId, workspaceId, db, doc.id, id, "Replaced by a newer version of the document", now);
      }
    }
    // A removed document leaves the inbox and search with it.
    const live = db.prepare(`SELECT a.id, a.state, json_extract(a.provenance_json,'$[0].rootRunId') AS document_id FROM knowledge_assets a
      WHERE a.operation_id='saved-document' AND a.superseded_by IS NULL AND a.state IN ('extracted','reviewed','published') AND (a.rejection_reason IS NULL OR a.rejection_reason<>?)`).all(REMOVED_NOTE) as Array<{ id: string; state: string; document_id: string }>;
    for (const row of live) {
      if (db.prepare("SELECT 1 FROM documents WHERE id=? AND state='active'").get(row.document_id)) continue;
      if (row.state === "published") {
        this.ports.memory.revoke(organizationId, workspaceId, row.id);
        db.prepare("UPDATE knowledge_assets SET state='revoked',rejection_reason=?,updated_at_ms=? WHERE id=?").run(REMOVED_NOTE, now, row.id);
        this.ports.reuse.unindex(organizationId, workspaceId, `knowledge:${row.id}`);
      } else db.prepare("UPDATE knowledge_assets SET rejection_reason=?,updated_at_ms=? WHERE id=?").run(REMOVED_NOTE, now, row.id);
    }
    return created;
  }

  /** Takes every other live proposal of the same document out of the inbox (and out of search when it was published). Nothing is deleted. */
  private supersedeDocumentAssets(organizationId: string, workspaceId: string, db: ReturnType<Store["workspaceDb"]>, documentId: string, keepId: string, reason: string, now: number): void {
    const older = db.prepare(`SELECT id, state FROM knowledge_assets WHERE operation_id='saved-document' AND superseded_by IS NULL AND state IN ('extracted','reviewed','published')
      AND json_extract(provenance_json,'$[0].rootRunId')=? AND id<>?`).all(documentId, keepId) as Array<{ id: string; state: string }>;
    for (const row of older) {
      if (row.state === "published") {
        this.ports.memory.revoke(organizationId, workspaceId, row.id);
        db.prepare("UPDATE knowledge_assets SET state='revoked',superseded_by=?,rejection_reason=?,updated_at_ms=? WHERE id=?").run(keepId, reason, now, row.id);
        this.ports.reuse.unindex(organizationId, workspaceId, `knowledge:${row.id}`);
      } else {
        db.prepare("UPDATE knowledge_assets SET superseded_by=?,rejection_reason=?,updated_at_ms=? WHERE id=?").run(keepId, reason, now, row.id);
      }
    }
  }

  /** When the organization's active release was activated: the config.activated event, else the release's own staging time. */
  private activatedAt(organizationId: string, releaseDigest: string): string {
    const event = this.store.control.prepare("SELECT created_at_ms FROM events WHERE organization_id=? AND event_type='config.activated' AND aggregate_id=? ORDER BY created_at_ms DESC LIMIT 1").get(organizationId, releaseDigest) as { created_at_ms: number } | undefined;
    const staged = this.store.control.prepare("SELECT created_at_ms FROM config_releases WHERE organization_id=? AND digest=?").get(organizationId, releaseDigest) as { created_at_ms: number } | undefined;
    return iso(event?.created_at_ms ?? staged?.created_at_ms ?? 0);
  }

  /**
   * The registry of the active release's tools. Everything is read, none invented: the activation time of the release, the agents whose
   * allowlist pins this exact tool digest, the pinned script as proof, and call counts from the tool events the runners recorded.
   */
  private activeTools(organizationId: string, workspaceId?: string): ToolCatalogEntry[] {
    const active = activeReleaseRecord(this.store, organizationId);
    if (!active) return [];
    const createdAt = this.activatedAt(organizationId, active.digest);
    const usage = workspaceId ? this.toolUsage(organizationId, workspaceId) : new Map<string, ToolUsage>();
    const sources = workspaceId ? readableSources(this.store, organizationId, workspaceId) : undefined;
    const candidates = workspaceId
      ? new Map((this.store.workspaceDb(workspaceId, organizationId).prepare("SELECT package_digest,operation_id,state FROM tool_candidates").all() as Array<{ package_digest: string; operation_id: string; state: string }>).map((row) => [`${row.operation_id}@${row.package_digest}`, row.state]))
      : new Map<string, string>();
    return (active.release.manifest.tools ?? []).map((tool) => {
      const allowedAgents = Object.entries(active.release.agents ?? {}).filter(([, agent]) => agent.spec.tools.some((allowed) => allowed.id === tool.id && allowed.digest === tool.digest)).map(([agentId]) => agentId).sort();
      const candidate = candidates.get(`${tool.id}@${tool.digest}`);
      const status: ToolCatalogEntry["status"] = candidate === "quarantined" ? "candidate" : candidate === "reviewed" ? "reviewing" : "trusted";
      const used = usage.get(tool.id);
      const script = tool.entrypointDigest ? this.store.control.prepare("SELECT bytes FROM release_files WHERE release_digest=? AND tool_id=?").get(active.digest, tool.id) as { bytes: number } | undefined : undefined;
      return {
        id: tool.id, release: { id: tool.id, digest: tool.digest }, status, effectClass: tool.effectClass,
        inputSchemaRef: tool.inputSchemaRef, outputSchemaRef: tool.outputSchemaRef,
        // The proof is the pinned script itself: the exact bytes the runners verify before executing.
        evidence: tool.entrypointDigest && script ? [{ artifactId: `tool-script:${tool.id}`, digest: tool.entrypointDigest, bytes: script.bytes, mediaType: "text/x-shellscript", classification: "internal" as const }] : [],
        createdAt, allowedAgents,
        ...(tool.description ? { description: tool.description } : {}), ...(tool.allowedHosts ? { allowedHosts: tool.allowedHosts } : {}),
        usage: used ?? { calls: 0, failures: 0 },
        // Whether the workspace holds anything this tool could read; an unavailable tool is left out of agents' tool lists and says why here.
        availability: sources ? toolAvailability(tool.id, sources) : { available: true },
      };
    });
  }

  /**
   * Per-tool calls and failures of this workspace from the `tool_calls` table, which attempt-event ingestion keeps current (one row per
   * proposed call, written when its event is first stored). A grouped read of an indexed table, never a scan of event history. Calls made
   * before the table existed are not counted: usage starts at zero (no backfill).
   */
  private toolUsage(organizationId: string, workspaceId: string): Map<string, ToolUsage> {
    const rows = this.store.control.prepare(`SELECT t.tool_id AS toolId, COUNT(*) AS calls, COALESCE(SUM(t.failed),0) AS failures,
        MAX(NULLIF(t.proposed_at,'')) AS lastCallAt, MAX(CASE WHEN t.failed=1 THEN NULLIF(t.finished_at,'') END) AS lastFailureAt,
        (SELECT c.failure_message FROM tool_calls c WHERE c.organization_id=t.organization_id AND c.workspace_id=t.workspace_id AND c.tool_id=t.tool_id AND c.failed=1 ORDER BY c.finished_at DESC, c.rowid DESC LIMIT 1) AS lastFailureMessage,
        (SELECT c.run_id FROM tool_calls c WHERE c.organization_id=t.organization_id AND c.workspace_id=t.workspace_id AND c.tool_id=t.tool_id ORDER BY c.proposed_at DESC, c.rowid DESC LIMIT 1) AS lastCallRunId,
        (SELECT c.run_id FROM tool_calls c WHERE c.organization_id=t.organization_id AND c.workspace_id=t.workspace_id AND c.tool_id=t.tool_id AND c.failed=1 ORDER BY c.finished_at DESC, c.rowid DESC LIMIT 1) AS lastFailureRunId
      FROM tool_calls t WHERE t.organization_id=? AND t.workspace_id=? GROUP BY t.tool_id`).all(organizationId, workspaceId) as Array<{ toolId: string; calls: number; failures: number; lastCallAt: string | null; lastFailureAt: string | null; lastFailureMessage: string | null; lastCallRunId: string | null; lastFailureRunId: string | null }>;
    return new Map(rows.map((row): [string, ToolUsage] => [row.toolId, {
      calls: row.calls, failures: row.failures,
      ...(row.lastCallAt ? { lastCallAt: row.lastCallAt } : {}), ...(row.lastCallAt && row.lastCallRunId ? { lastCallRunId: row.lastCallRunId } : {}),
      ...(row.lastFailureAt ? { lastFailureAt: row.lastFailureAt } : {}), ...(row.lastFailureAt && row.lastFailureMessage ? { lastFailureMessage: row.lastFailureMessage } : {}), ...(row.lastFailureAt && row.lastFailureRunId ? { lastFailureRunId: row.lastFailureRunId } : {}),
    }]));
  }


  query(actor: ActorContext, queryType: string, workspaceId: string, limit: number): JsonValue {
    requireWorkspaceRead(this.store, actor, workspaceId);
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    if (queryType === "library.summary") {
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const writeups = count(`SELECT COUNT(*) AS n FROM knowledge_assets WHERE state='extracted' AND operation_id IN ('mission-knowledge','saved-document') AND superseded_by IS NULL AND (rejection_reason IS NULL OR rejection_reason LIKE '${NEEDS_PERSON_NOTE}%')`);
      const tools = count("SELECT COUNT(*) AS n FROM tool_candidates WHERE state='quarantined'");
      const plays = count("SELECT COUNT(*) AS n FROM play_proposals WHERE state='proposed'");
      return {
        // What truly needs a person: write-ups waiting for a reviewer (including ones set aside for a secret), tool and Play proposals.
        // What Brain published itself is counted apart (publishedAutomatically) and never waits here.
        awaitingReview: writeups + tools + plays,
        needsPerson: { writeups, tools, plays },
        publishedAutomatically: count("SELECT COUNT(*) AS n FROM knowledge_assets WHERE state='published' AND auto_published=1"),
        publishedKnowledge: count("SELECT COUNT(*) AS n FROM knowledge_assets WHERE state='published'"),
        // What Brain learned lately, for the quiet line on Today: mission write-ups published in the last seven days, and how many of those it published itself.
        learnedThisWeek: count(`SELECT COUNT(*) AS n FROM knowledge_assets WHERE operation_id='mission-knowledge' AND state='published' AND reviewed_at_ms>=${this.store.now() - 7 * 86_400_000}`),
        learnedAutomatically: count(`SELECT COUNT(*) AS n FROM knowledge_assets WHERE operation_id='mission-knowledge' AND state='published' AND auto_published=1 AND reviewed_at_ms>=${this.store.now() - 7 * 86_400_000}`),
        autoPublishKnowledge: this.autoPublishOn(db),
        documents: count("SELECT COUNT(*) AS n FROM documents WHERE state='active'"),
        tools: this.activeTools(actor.organizationId, workspaceId).length,
      } as unknown as JsonValue;
    }
    if (queryType === "tools.list") return { items: this.activeTools(actor.organizationId, workspaceId).slice(0, limit) } as unknown as JsonValue;
    if (queryType === "knowledgeAssets.list") {
      const rows = db.prepare("SELECT * FROM knowledge_assets ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as AssetRow[];
      return { items: rows.map((row) => this.asset(workspaceId, db, row)) } as unknown as JsonValue;
    }
    if (queryType === "capabilityCandidates.list" || queryType === "toolCandidates.list") {
      const rows = db.prepare("SELECT * FROM tool_candidates ORDER BY created_at_ms DESC,id LIMIT ?").all(limit) as CandidateRow[];
      const items = rows.map((row) => this.candidate(workspaceId, row));
      if (queryType === "toolCandidates.list") return { items: items.map((item) => ({ release: item.release, state: item.state, createdAt: item.createdAt })) } as unknown as JsonValue;
      return { items } as unknown as JsonValue;
    }
    if (queryType === "capitalizationRuns.list") {
      const rows = db.prepare("SELECT * FROM capitalization_runs ORDER BY created_at_ms DESC,id LIMIT ?").all(limit) as RunRow[];
      return { items: rows.map((row) => this.run(workspaceId, row)) } as unknown as JsonValue;
    }
    throw new BrainDomainError("INVALID_CONTRACT", `unsupported capitalization query ${queryType}`);
  }

  private asset(workspaceId: string, db: ReturnType<Store["workspaceDb"]>, row: AssetRow): KnowledgeAsset {
    // Mission assets carry their own provenance (the mission's evidence bundles); operation assets look it up by signature.
    const provenance = row.mission_id || row.operation_id === "saved-document"
      ? (JSON.parse(row.provenance_json) as Array<{ rootRunId: string; evidenceDigest: string }>)
      : (db.prepare("SELECT root_run_id,evidence_digest FROM operation_observations WHERE signature=? AND verified_success=1 ORDER BY root_run_id").all(row.signature) as Array<{ root_run_id: string; evidence_digest: string }>)
        .map((item) => ({ rootRunId: item.root_run_id, evidenceDigest: item.evidence_digest }));
    return {
      assetId: row.id, workspaceId, signature: row.signature, operationId: row.operation_id, state: row.state,
      classification: row.classification, content: row.content, sourceCount: row.source_count,
      provenance,
      ...(row.title ? { title: row.title } : {}), ...(row.mission_id ? { missionId: row.mission_id } : {}),
      ...(row.producer_id ? { producedBy: row.producer_id } : {}), ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
      ...(row.reviewed_at_ms ? { reviewedAt: iso(row.reviewed_at_ms) } : {}), ...(row.self_reviewed ? { selfReviewed: true } : {}),
      ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}), ...(row.auto_published ? { autoPublished: true } : {}), ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}), ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
      createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  private candidate(workspaceId: string, row: CandidateRow): CapabilityCandidate {
    const definition = JSON.parse(row.definition_json) as CandidateDefinition;
    return {
      candidateId: row.id, workspaceId, signature: row.signature, operationId: row.operation_id,
      release: { id: row.operation_id, digest: row.package_digest }, state: row.state, testStatus: row.test_status,
      sourceCount: row.source_count, evidenceDigests: definition.testFixtures, inputSchema: definition.inputSchema,
      effectClass: row.effect_class, existingAlternatives: definition.existingAlternatives, createdAt: iso(row.created_at_ms),
      ...(row.reviewer_id ? { reviewedBy: row.reviewer_id } : {}), ...(row.reviewed_at_ms ? { reviewedAt: iso(row.reviewed_at_ms) } : {}),
      ...(row.published_at_ms ? { publishedAt: iso(row.published_at_ms) } : {}),
    };
  }

  private run(workspaceId: string, row: RunRow): CapitalizationRun {
    return {
      runId: row.id, workspaceId, state: row.state, observedCount: row.observed_count,
      extractedCount: row.extracted_count, candidateCount: row.candidate_count, requestedBy: row.requested_by,
      createdAt: iso(row.created_at_ms), ...(row.started_at_ms ? { startedAt: iso(row.started_at_ms) } : {}),
      ...(row.completed_at_ms ? { completedAt: iso(row.completed_at_ms) } : {}), ...(row.error ? { error: row.error } : {}),
    };
  }
}
