import { domainDigest } from "@brain/contracts";
import type {
  ActorContext, CapabilityCandidate, CapitalizationRun, EvidenceBundle, JsonValue,
  KnowledgeAsset, ReleaseRef, ToolCatalogEntry,
} from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { looksLikeSecret } from "../knowledge/memory";

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

type AssetRow = {
  id: string; signature: string; operation_id: string; state: KnowledgeAsset["state"];
  classification: KnowledgeAsset["classification"]; content: string; source_count: number;
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

export class CapitalizationService {
  constructor(private readonly store: Store) {}

  apply(actor: ActorContext, command: CapitalizationCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    requireWorkspaceRead(this.store, actor, workspaceId);
    switch (command.commandType) {
      case "capitalization.run": return this.requestRun(actor, workspaceId, command.commandId);
      case "capability.review": return this.review(actor, workspaceId, command.payload);
      case "tool.propose": return this.propose(actor, workspaceId, command.payload);
      case "tool.publish": return this.publish(actor, workspaceId, command.payload);
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

  private requestRun(actor: ActorContext, workspaceId: string, commandId: string): string {
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const id = digestId("caprun", domainDigest("brain:capitalization-request:v1", { workspaceId, commandId }));
    this.store.inTx(db, () => {
      db.prepare("INSERT OR IGNORE INTO capitalization_runs(id,state,requested_by,created_at_ms) VALUES (?,'queued',?,?)").run(id, actor.actorId, this.store.now());
    });
    return id;
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
          db.prepare("UPDATE capitalization_runs SET state='failed',error=?,completed_at_ms=? WHERE id=? AND state!='succeeded'")
            .run(error instanceof Error ? error.message.slice(0, 1000) : "capitalization failed", this.store.now(), run.id);
        }
      }
    }
    return { processed, failed };
  }

  private processRun(workspaceId: string, organizationId: string, runId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    this.store.inTx(db, () => {
      const run = db.prepare("SELECT state FROM capitalization_runs WHERE id=?").get(runId) as { state: string } | undefined;
      if (!run || run.state === "succeeded" || run.state === "failed") return;
      const now = this.store.now();
      db.prepare("UPDATE capitalization_runs SET state='running',started_at_ms=COALESCE(started_at_ms,?),error=NULL WHERE id=?").run(now, runId);
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
      db.prepare("UPDATE capitalization_runs SET state='succeeded',observed_count=?,extracted_count=?,candidate_count=?,completed_at_ms=? WHERE id=?")
        .run(observed, extracted, candidates, now, runId);
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
      db.prepare("UPDATE tool_candidates SET state=?,reviewer_id=?,reviewed_at_ms=? WHERE id=?").run(state, actor.actorId, now, candidateId);
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
      db.prepare("UPDATE tool_candidates SET state='published',published_at_ms=? WHERE id=?").run(now, candidate.id);
      this.store.emit(db, { workspaceId, aggregateType: "capability", aggregateId: candidate.id, eventType: "capability.published", payload: { resourceId: candidate.id, workspaceId, state: "published" } });
    });
    return release.id;
  }

  markKnowledgePublished(organizationId: string, workspaceId: string, sourceId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    db.prepare("UPDATE knowledge_assets SET state='published',updated_at_ms=? WHERE id=? AND state IN ('extracted','reviewed')").run(this.store.now(), sourceId);
  }

  markKnowledgeRevoked(organizationId: string, workspaceId: string, sourceId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    db.prepare("UPDATE knowledge_assets SET state='revoked',updated_at_ms=? WHERE id=?").run(this.store.now(), sourceId);
  }

  private activeTools(organizationId: string): ToolCatalogEntry[] {
    const row = this.store.control.prepare(`SELECT r.manifest_json,r.digest FROM active_config a JOIN config_releases r ON r.digest=a.release_digest
      WHERE a.organization_id=?`).get(organizationId) as { manifest_json: string; digest: string } | undefined;
    if (!row) return [];
    const stored = JSON.parse(row.manifest_json) as { manifest?: { tools?: Array<{ id: string; digest: string; effectClass: "read" | "write" | "privileged"; inputSchemaRef: string; outputSchemaRef: string }> } };
    return (stored.manifest?.tools ?? []).map((tool) => ({
      id: tool.id, release: { id: tool.id, digest: tool.digest }, status: "trusted", effectClass: tool.effectClass,
      inputSchemaRef: tool.inputSchemaRef, outputSchemaRef: tool.outputSchemaRef, evidence: [], createdAt: this.store.nowIso(),
    }));
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, limit: number): JsonValue {
    requireWorkspaceRead(this.store, actor, workspaceId);
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    if (queryType === "tools.list") return { items: this.activeTools(actor.organizationId).slice(0, limit) } as unknown as JsonValue;
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
    const provenance = db.prepare("SELECT root_run_id,evidence_digest FROM operation_observations WHERE signature=? AND verified_success=1 ORDER BY root_run_id").all(row.signature) as Array<{ root_run_id: string; evidence_digest: string }>;
    return {
      assetId: row.id, workspaceId, signature: row.signature, operationId: row.operation_id, state: row.state,
      classification: row.classification, content: row.content, sourceCount: row.source_count,
      provenance: provenance.map((item) => ({ rootRunId: item.root_run_id, evidenceDigest: item.evidence_digest })),
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
