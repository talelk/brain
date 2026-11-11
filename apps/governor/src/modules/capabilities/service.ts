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
import { putBytes, readVerified } from "../artifacts/index";

interface ToolUsage { calls: number; failures: number; lastCallAt?: string; lastCallRunId?: string; lastFailureAt?: string; lastFailureRunId?: string }

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
  title: string; mission_id: string | null; producer_id: string | null; provenance_json: string;
  reviewed_by: string | null; self_reviewed: number; reviewed_at_ms: number | null; rejection_reason: string | null; content_digest: string | null;
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

/** The readable asset stays inside the contract's 12000 characters, cut section by section. */
const ASSET_CHARS = 12000;
const section = (heading: string, lines: readonly string[], budget: number): string => {
  const body: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) { body.push(`(${lines.length - body.length} more not shown)`); break; }
    body.push(line); used += line.length + 1;
  }
  return `${heading}\n${body.length ? body.join("\n") : "None."}`;
};

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
   * One readable knowledge asset per achieved mission (#67), built from verified
   * material only with a fixed template and no model summary: the goal, success
   * criteria with how the verdict checked them, accepted decisions, verified
   * outputs, what the verdict rejected, workflows used, cost and time. Member
   * notes, handoff notes, messages and transcripts are claims and are never read
   * (GLOSSARY: Capitalization run). Provenance is the mission's evidence bundles.
   */
  private extractMissionKnowledge(db: ReturnType<Store["workspaceDb"]>, missionId: string, now: number): number {
    const mission = db.prepare("SELECT id, title, intent, success_criteria_json, owner_id, outcome, state, active_ms FROM missions WHERE id=?").get(missionId) as
      | { id: string; title: string; intent: string; success_criteria_json: string; owner_id: string; outcome: string | null; state: string; active_ms: number } | undefined;
    if (!mission || mission.state !== "closed" || mission.outcome !== "achieved") return 0;
    const bundles = db.prepare("SELECT digest, state, findings_json, created_at_ms FROM mission_evidence_bundles WHERE mission_id=? AND state IN ('verified','rejected') ORDER BY created_at_ms, rowid").all(missionId) as Array<{ digest: string; state: "verified" | "rejected"; findings_json: string; created_at_ms: number }>;
    const verified = bundles.filter((bundle) => bundle.state === "verified").at(-1);
    if (!verified) return 0;
    const checks = db.prepare("SELECT evaluator, outcome, advisory, evidence_digest FROM mission_bundle_checks WHERE bundle_digest=? ORDER BY criterion_id, evaluator").all(verified.digest) as Array<{ evaluator: string; outcome: string; advisory: number; evidence_digest: string }>;
    const independent = checks.filter((check) => check.advisory === 0 && check.outcome === "passed");
    const advisory = checks.filter((check) => check.advisory === 1);
    const verdictDay = new Date(verified.created_at_ms).toISOString().slice(0, 10);
    const basis = independent.length > 0
      ? `verified: ${independent.length} independent check${independent.length === 1 ? "" : "s"} passed (${[...new Set(independent.map((check) => check.evaluator))].join(", ")}) and a mission verdict recorded by a person on ${verdictDay}${advisory.length ? `; ${advisory.length} advisory model-opinion check${advisory.length === 1 ? "" : "s"} did not decide the outcome` : ""}`
      : `verified: human sign-off, mission verdict recorded by a person on ${verdictDay}`;
    const criteria = (JSON.parse(mission.success_criteria_json) as string[]).map((text) => `- ${text} [${basis}]`);
    const decisions = (db.prepare("SELECT statement, source_kind FROM accepted_decisions WHERE mission_id=? AND superseded_by IS NULL ORDER BY introduced_version, id").all(missionId) as Array<{ statement: string; source_kind: string }>)
      .map((row) => `- ${row.statement} (accepted by a person; source: ${row.source_kind})`);
    const outputs = (db.prepare("SELECT o.name, v.artifact_digest FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id WHERE o.mission_id=? AND v.verified=1 ORDER BY o.name, v.id").all(missionId) as Array<{ name: string; artifact_digest: string }>)
      .map((row) => {
        let preview = "";
        try { preview = new TextDecoder("utf-8", { fatal: true }).decode(readVerified(this.store, row.artifact_digest)).replace(/\s+/gu, " ").trim().slice(0, 240); } catch { preview = "(binary or unreadable content)"; }
        return `- ${row.name} [${row.artifact_digest}]${preview ? `: ${preview}` : ""}`;
      });
    const rejected = bundles.filter((bundle) => bundle.state === "rejected").flatMap((bundle) => (JSON.parse(bundle.findings_json) as string[]).map((finding) => `- ${finding} (verdict ${bundle.digest.slice(0, 19)}...)`));
    const workflows = (db.prepare("SELECT DISTINCT workflow_id FROM work_items WHERE mission_id=? AND workflow_id IS NOT NULL ORDER BY workflow_id").all(missionId) as Array<{ workflow_id: string }>).map((row) => row.workflow_id);
    const spend = (db.prepare("SELECT COALESCE(SUM(settled_micro_usd),0) AS micro FROM mission_spend WHERE mission_id=?").get(missionId) as { micro: number }).micro;
    const minutes = Math.max(1, Math.round(mission.active_ms / 60_000));
    const content = [
      `# ${mission.title}`,
      section("## Goal", [mission.intent], 1800),
      section("## Success criteria and how each was checked", criteria, 2600),
      section("## Decisions accepted along the way", decisions, 1800),
      section("## Verified outputs", outputs, 2600),
      section("## What the verdict rejected, and why", rejected, 1800),
      section("## Workflows used", workflows.map((id) => `- ${id}`), 400),
      section("## Cost and time", [`- Settled spend: $${(spend / 1_000_000).toFixed(4)}`, `- Active time: about ${minutes} minute${minutes === 1 ? "" : "s"}`], 300),
      "Claim basis: statements tagged [verified: ...] come from the mission's verified evidence bundle. This is a record of past work, not evidence for a new mission.",
    ].join("\n\n").slice(0, ASSET_CHARS);
    const signature = domainDigest("brain:mission-knowledge:v1", { missionId });
    const provenance = [verified.digest, ...new Set(independent.map((check) => check.evidence_digest))].slice(0, 20).map((evidenceDigest) => ({ rootRunId: missionId, evidenceDigest }));
    const inserted = db.prepare(`INSERT OR IGNORE INTO knowledge_assets(id,signature,operation_id,state,classification,content,source_count,title,mission_id,producer_id,provenance_json,created_at_ms,updated_at_ms)
      VALUES (?,?, 'mission-knowledge', 'extracted', 'internal', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(digestId("knowledge", signature), signature, content, Math.max(1, bundles.length), mission.title, missionId, mission.owner_id, JSON.stringify(provenance), now, now);
    return Number(inserted.changes);
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
        const extracted = this.extractMissionKnowledge(db, run.mission_id, now);
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
    if (asset.operation_id !== "mission-knowledge") throw new BrainDomainError("CONFLICT", "only proposed knowledge from a closed mission is reviewed here");
    if (decision === "reject") {
      if (asset.state !== "extracted") throw new BrainDomainError("CONFLICT", `a ${asset.state} knowledge asset cannot be rejected`);
      db.prepare("UPDATE knowledge_assets SET rejection_reason=?,updated_at_ms=? WHERE id=?").run(reason.slice(0, 512), this.store.now(), assetId);
      return assetId;
    }
    if (asset.state === "published") return assetId;
    if (asset.state !== "extracted") throw new BrainDomainError("CONFLICT", `a ${asset.state} knowledge asset cannot be approved`);
    const self = asset.producer_id === actor.actorId;
    if (self && this.otherReviewers(actor, workspaceId).length > 0) {
      throw new BrainDomainError("FORBIDDEN", "another reviewer in this workspace must approve knowledge you produced");
    }
    if (looksLikeSecret(asset.content) || looksLikeSecret(asset.title)) {
      throw new BrainDomainError("INVALID_ARGUMENT", "this knowledge appears to contain a secret; it was not published");
    }
    const digest = putBytes(this.store, new TextEncoder().encode(asset.content));
    this.ports.memory.publish({ organizationId: actor.organizationId, workspaceId, sourceId: assetId, text: asset.content, sourceType: "knowledge", status: "reviewed", title: asset.title, selfReviewed: self });
    const now = this.store.now();
    this.store.inTx(db, () => {
      db.prepare("UPDATE knowledge_assets SET state='published',reviewed_by=?,self_reviewed=?,reviewed_at_ms=?,content_digest=?,rejection_reason=NULL,updated_at_ms=? WHERE id=? AND state='extracted'")
        .run(actor.actorId, self ? 1 : 0, now, digest, now, assetId);
    });
    this.ports.reuse.indexKnowledge(actor.organizationId, workspaceId, assetId);
    return assetId;
  }

  /** Other active people who could review: when none exist, a producer may review their own knowledge (ADR 0007). */
  private otherReviewers(actor: ActorContext, workspaceId: string): string[] {
    const people = this.store.control.prepare(`SELECT p.id FROM principals p JOIN workspace_memberships m ON m.principal_id=p.id AND m.workspace_id=? AND m.revoked_at_ms IS NULL
      WHERE p.organization_id=? AND p.kind='human' AND p.disabled_at_ms IS NULL AND p.id<>?`).all(workspaceId, actor.organizationId, actor.actorId) as Array<{ id: string }>;
    return people.map((row) => row.id).filter((id) => scopesForPrincipal(this.store, id, actor.organizationId, workspaceId).includes("memory:publish"));
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
      };
    });
  }

  /** Per-tool calls and failures from the recorded engine tool events of this workspace (most recent 20000 events). */
  private toolUsage(organizationId: string, workspaceId: string): Map<string, ToolUsage> {
    const rows = this.store.control.prepare(`SELECT e.event_json AS json, j.workflow_run_id AS runId FROM attempt_events e
      JOIN job_attempts a ON a.id=e.attempt_id JOIN jobs j ON j.id=a.job_id
      WHERE j.organization_id=? AND j.workspace_id=? AND json_extract(e.event_json,'$.payload.kind') IN ('tool.proposed','tool.result')
      ORDER BY e.rowid DESC LIMIT 20000`).all(organizationId, workspaceId) as Array<{ json: string; runId: string }>;
    type Ev = { payload: { kind: string; occurredAt?: string; payload: { proposalId?: string; tool?: { id: string }; receipt?: { result?: string; finishedAt?: string } } } };
    const proposals = new Map<string, { toolId: string; at: string | undefined; runId: string }>();
    const results: Array<{ proposalId: string; failed: boolean; at: string | undefined; runId: string }> = [];
    for (const row of rows) {
      const event = JSON.parse(row.json) as Ev;
      const body = event.payload.payload;
      if (event.payload.kind === "tool.proposed" && body.tool?.id && body.proposalId) proposals.set(`${row.runId}:${body.proposalId}`, { toolId: body.tool.id, at: event.payload.occurredAt, runId: row.runId });
      else if (event.payload.kind === "tool.result" && body.proposalId) results.push({ proposalId: `${row.runId}:${body.proposalId}`, failed: body.receipt?.result === "failed", at: body.receipt?.finishedAt ?? event.payload.occurredAt, runId: row.runId });
    }
    const out = new Map<string, ToolUsage>();
    const entry = (toolId: string): ToolUsage => {
      let value = out.get(toolId);
      if (!value) { value = { calls: 0, failures: 0 }; out.set(toolId, value); }
      return value;
    };
    for (const proposal of proposals.values()) {
      const value = entry(proposal.toolId);
      value.calls += 1;
      if (proposal.at && (!value.lastCallAt || proposal.at > value.lastCallAt)) { value.lastCallAt = proposal.at; value.lastCallRunId = proposal.runId; }
    }
    for (const result of results) {
      const proposal = proposals.get(result.proposalId);
      if (!proposal || !result.failed) continue;
      const value = entry(proposal.toolId);
      value.failures += 1;
      if (result.at && (!value.lastFailureAt || result.at > value.lastFailureAt)) { value.lastFailureAt = result.at; value.lastFailureRunId = result.runId; }
    }
    return out;
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, limit: number): JsonValue {
    requireWorkspaceRead(this.store, actor, workspaceId);
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
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
    const provenance = row.mission_id
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
      ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}), ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
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
