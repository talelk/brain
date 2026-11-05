import { readRuntimeConfig, type RuntimeConfig } from "../runtime-config";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActorContext, CommandReceipt, HumanApprovalDecision, JsonValue,
} from "@brain/contracts";
import { approvalSubjectDigest, domainDigest, isKnownQuery, sha256Digest } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { BrainDomainError } from "../domain/errors";
import { assertExpectedVersion, transitionState } from "../domain/states";
import { iso } from "../domain/clock";
import { Store, type BrainOptions } from "./store";
import { hasWorkspaceMembership, resolveActor, requireWorkspaceRead, scopesForPrincipal, type ResolvedActor } from "./authz";
import { CommandFunnel } from "./command-funnel";
import { workspaceAdminCommands } from "./workspace-admin";
import { orgWorkspaces, textMatcher } from "./query";
import { executeOrganizationQuery, isOrganizationQuery, organizationCommandHandlers } from "./organization-admin";
import { activateRelease, compileRelease, configurationCommands, requireConfigurationAdmin, type AgentInstruction, type SourceDoc, type ToolScript } from "../modules/configuration/index";
import { MastraWorkflowEngine, workflowCommands, type WorkflowEnginePort } from "../modules/workflows/index";
import { knowledgeCommands, MemoryStore, TencentDbClient } from "../modules/knowledge/index";
import { admitApprovalDecision, governanceCommands, StepUpService } from "../modules/governance/index";
import { createBrainAuth, bootstrapIdentity, assertHumanIdentity, type BootstrapResult, type BrainAuth } from "../modules/identity/index";
import { localRunnerSettingsCurrent, quarantineRestoredAuthority, loadOrCreateVapidKeys, sendPush, encryptSubscription, decryptSubscription, type VapidKeys } from "../modules/operations/index";
import { EvidenceService } from "../modules/evidence/index";
import { readReleaseAgentInstructions, readReleaseToolScript } from "../modules/configuration/index";
import { acceptAttemptArtifact } from "../modules/evidence/index";
import {
  activeRelease as configActiveRelease, configExplain, releaseDefinitions, searchReleaseDocuments,
} from "../modules/configuration/index";
import {
  explainJob, getJob, getRunner, listJobs, listRunners, searchJobs,
} from "../modules/jobs/index";
import {
  commandReceipt, getApproval, listApprovals, searchApprovals,
} from "../modules/governance/index";
import { liveStatus, platformHealth, workspaceContext } from "../modules/operations/index";
import { getPack, listPack, slaSummary } from "../modules/packs/index";
import { artifactHistory, diffArtifacts, listArtifacts, readArtifactBytes, searchArtifacts } from "../modules/evidence/index";
import { bridge, today } from "../modules/work/index";
import { searchSessions } from "../modules/sessions/index";
import { jobCommands, JobProtocol } from "../modules/jobs/index";
import { issuePermit as governanceIssuePermit, validatePermit as governanceValidatePermit } from "../modules/governance/index";
import { revokeTrustDomain, verifyTrustDomain as governanceVerifyTrustDomain } from "../modules/governance/index";
import { WorkService, workCommands } from "../modules/work/index";
import { BoardService, boardCommands } from "../modules/board/index";
import { SessionService, continuationFacts, sessionCommands } from "../modules/sessions/index";
import { createStreamService, frameOf, type StreamFilters, type StreamService } from "../modules/stream/index";
import { DocumentService, documentCommands } from "../modules/resources/index";
import { IntegrationService, integrationCommands } from "../modules/integrations/index";
import { ConfigurationDraftService } from "../modules/configuration/index";
import { CapitalizationService, capitalizationCommands } from "../modules/capabilities/index";

export class Brain {
  readonly runtime: RuntimeConfig;
  readonly store: Store;
  readonly workflows: WorkflowEnginePort;
  readonly work: WorkService;
  readonly board: BoardService;
  readonly sessions: SessionService;
  readonly stream: StreamService;
  readonly documents: DocumentService;
  readonly integrations: IntegrationService;
  readonly drafts: ConfigurationDraftService;
  readonly jobProtocol: JobProtocol;
  readonly capitalization: CapitalizationService;
  readonly memory: MemoryStore;
  readonly auth: BrainAuth;
  readonly stepUp: StepUpService;
  readonly evidence: EvidenceService;
  readonly commands: CommandFunnel;

  constructor(opts: BrainOptions & { runtime?: RuntimeConfig }) {
    this.runtime = opts.runtime ?? readRuntimeConfig();
    this.store = new Store(opts);
    try {
      const authSecret = process.env["BRAIN_AUTH_SECRET"] ?? Buffer.from(this.store.pepper).toString("hex");
      this.auth = createBrainAuth(this.store.control, { initialPasswordFile: join(this.store.dataDir, "initial-admin-password"), secret: authSecret, baseURL: process.env["BRAIN_BASE_URL"] ?? "http://localhost:3000", requireTwoFactor: this.runtime.requireTwoFactor });
      this.auth.ensureTables();
      this.stepUp = new StepUpService(this.store, this.auth);
      this.memory = new MemoryStore(this.store);
      this.work = new WorkService(this.store);
      this.board = new BoardService(this.store, this.work);
      this.sessions = new SessionService(this.store);
      this.stream = createStreamService(this.store);
      this.documents = new DocumentService(this.store);
      this.integrations = new IntegrationService(this.store);
      this.drafts = new ConfigurationDraftService(this.store, {
        activeDocuments: (organizationId) => {
          const row = this.store.control.prepare("SELECT r.source_documents_json FROM active_config a JOIN config_releases r ON r.digest=a.release_digest WHERE a.organization_id=?").get(organizationId) as { source_documents_json: string } | undefined;
          return row ? JSON.parse(row.source_documents_json) as import("../modules/configuration/compiler").SourceDoc[] : [];
        },
        activeAssets: (organizationId) => {
          const row = this.store.control.prepare("SELECT r.digest,r.manifest_json FROM active_config a JOIN config_releases r ON r.digest=a.release_digest WHERE a.organization_id=?").get(organizationId) as { digest: string; manifest_json: string } | undefined;
          if (!row) return [];
          const stored = JSON.parse(row.manifest_json) as { schemas?: Record<string, unknown> };
          const schemas = Object.entries(stored.schemas ?? {}).map(([path, schema]) => ({ path, text: `${JSON.stringify(schema, null, 2)}\n` }));
          const files = this.store.control.prepare("SELECT entrypoint,digest FROM release_files WHERE release_digest=?").all(row.digest) as Array<{ entrypoint: string; digest: string }>;
          return [...schemas, ...files.map((file) => ({ path: file.entrypoint, text: readFileSync(this.casPath(file.digest), "utf8") }))];
        },
        publishConfiguration: (actor, bindingId, documents, message) => this.integrations.publishConfiguration(actor, bindingId, documents, message),
        stageRelease: (actor, documents, assets, sourceRevision) => this.stageRelease(actor, documents, sourceRevision, assets.scripts, assets.instructions, assets.schemas),
      });
      this.workflows = new MastraWorkflowEngine(this.store, this, join(this.store.dataDir, "mastra"));
      this.jobProtocol = new JobProtocol(this.store, {
        completeStep: (organizationId, workspaceId, runId, stepId, output, ok) => this.workflows.completeStep(organizationId, workspaceId, runId, stepId, output, ok),
        evaluatorEligible: (runnerId, jobId) => this.evidence.evaluatorEligible(runnerId, jobId),
        runnerCurrent: (organizationId, runnerId) => localRunnerSettingsCurrent(this.store, organizationId, runnerId),
        activeRelease: (organizationId) => this.activeRelease(organizationId),
        resolveWorkflow: (organizationId, workflowId) => this.workflowFromRelease(organizationId, workflowId),
        startRun: (input) => this.workflows.startRun(input as Parameters<WorkflowEnginePort["startRun"]>[0]),
      });
      this.capitalization = new CapitalizationService(this.store);
      this.evidence = new EvidenceService(this.store, this.workflows);
      this.commands = new CommandFunnel(this.store, {
        ...workCommands(this.work),
        ...boardCommands(this.board),
        ...sessionCommands(this.sessions),
        ...documentCommands(this.documents),
        ...integrationCommands(this.integrations),
        ...configurationCommands(this.store, this.drafts),
        ...capitalizationCommands(this.capitalization),
        ...jobCommands(this.store, this.jobProtocol),
        ...governanceCommands(this.store, { auth: this.auth, wakeGate: (org, ws, approvalId, approved) => this.workflows.wakeGate(org, ws, approvalId, approved) }),
        ...workflowCommands(this.store, {
          engine: this.workflows,
          loadWorkflow: (organizationId, workflowId) => this.workflowFromRelease(organizationId, workflowId),
          sessionWorkItem: (actor, workspaceId, sessionId) => this.sessions.workItemForDispatch(actor, workspaceId, sessionId),
          linkExecution: (actor, workspaceId, workItemId, runId) => this.work.linkExecution(actor, workspaceId, workItemId, runId),
          attachSessionRun: (actor, workspaceId, sessionId, runId) => this.sessions.attachRun(actor, workspaceId, sessionId, runId),
        }),
        ...knowledgeCommands(this.store, this.memory, {
          markKnowledgePublished: (org, ws, sourceId) => this.capitalization.markKnowledgePublished(org, ws, sourceId),
          markKnowledgeRevoked: (org, ws, sourceId) => this.capitalization.markKnowledgeRevoked(org, ws, sourceId),
        }),
        ...workspaceAdminCommands(this.store, this.auth),
        ...organizationCommandHandlers(this.store, this.auth),
      }, { afterCommit: () => this.stream.project() });
      quarantineRestoredAuthority(this.store, this.auth);
    } catch (e) {
      this.store.close();
      throw e;
    }
    this.probeMemoryService();
    this.memoryProbeTimer = setInterval(() => this.probeMemoryService(), 10_000);
    this.memoryProbeTimer.unref();
  }

  close(): void {
    clearInterval(this.memoryProbeTimer);
    this.store.close();
  }

  // platform.health must report the memory service's real reachability, not a
  // constant. The probe is periodic so the synchronous query path reads a
  // fresh-but-stable result; reaching the service is a liveness check only and
  // makes no claim about the G04 workload gate.
  private memoryProbeTimer: ReturnType<typeof setInterval>;
  private memoryProbe: { status: "healthy" | "unavailable" | "disabled"; detail: string; checkedAt: string } =
    { status: "disabled", detail: "no memory service configured; local scoped store active", checkedAt: "" };

  private probeMemoryService(): void {
    const checkedAt = this.store.nowIso();
    const url = process.env["BRAIN_TENCENTDB_URL"];
    if (!url) {
      this.memoryProbe = { status: "disabled", detail: "no memory service configured; local scoped store active", checkedAt };
      return;
    }
    fetch(`${url.replace(/\/$/u, "")}/health`, { signal: AbortSignal.timeout(1500) })
      .then((response) => { this.memoryProbe = response.ok
        ? { status: "healthy", detail: "TencentDB Memory Core reachable; scoped local review records remain authoritative", checkedAt }
        : { status: "unavailable", detail: `TencentDB Memory Core health returned HTTP ${response.status}`, checkedAt }; })
      .catch(() => { this.memoryProbe = { status: "unavailable", detail: `TencentDB Memory Core unreachable at ${url}`, checkedAt }; });
  }

  // --- bootstrap / directory ---
  bootstrap(raw: unknown, setupCredential: string): Promise<BootstrapResult> {
    return bootstrapIdentity(this.store, this.auth, raw, setupCredential);
  }

  resolveActor(headers: Headers, workspaceId?: string): Promise<ResolvedActor> {
    return resolveActor(this.store, this.auth, headers, workspaceId);
  }

  createWorkspace(actor: ActorContext, input: { workspaceId: string; slug: string; description?: string; ownerId?: string; tags?: string[] }): void {
    const s = this.store;
    if (!actor.scopes.includes("config:activate") && !actor.scopes.includes("workspace:import")) {
      // Bootstrap owner path: organization-admin creates workspaces.
      throw new BrainDomainError("FORBIDDEN", "workspace creation requires organization administration");
    }
    const ownerId = input.ownerId ?? actor.actorId;
    if (!s.control.prepare("SELECT 1 FROM principals WHERE id=? AND organization_id=? AND kind='human' AND disabled_at_ms IS NULL").get(ownerId, actor.organizationId)) throw new BrainDomainError("NOT_FOUND", "workspace owner must be an active organization member");
    s.inTx(s.control, () => {
      s.control.prepare("INSERT INTO workspaces(id, organization_id, slug, status, description, owner_id, tags_json) VALUES (?,?,?, 'active',?,?,?)")
        .run(input.workspaceId, actor.organizationId, input.slug, input.description ?? "", ownerId, JSON.stringify(input.tags ?? []));
      s.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,?,1,?,?)")
        .run(input.workspaceId, actor.organizationId, actor.actorId, "workspace-lead", actor.actorId, s.now());
    });
    s.workspaceDb(input.workspaceId, actor.organizationId);
  }

  ensurePrincipal(organizationId: string, principalId: string, kind: string): void {
    this.store.control.prepare("INSERT OR IGNORE INTO principals(id, organization_id, kind, auth_subject_id) VALUES (?,?,?,?)")
      .run(principalId, organizationId, kind, principalId);
  }

  // --- config releases ---
  stageRelease(actor: ActorContext, docs: readonly SourceDoc[], sourceRevision: string, scripts?: readonly ToolScript[], instructions: readonly AgentInstruction[] = [], schemas: readonly SourceDoc[] = []): { digest: string } {
    requireConfigurationAdmin(this.store, actor);
    const request = validate("ReleaseStageRequest",{ documents: docs, sourceRevision, scripts, instructions, schemas });
    if (!request.ok) throw new BrainDomainError("INVALID_CONTRACT",request.errors.join("; "));
    if (!/^(sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/u.test(sourceRevision)) {
      throw new BrainDomainError("INVALID_CONTRACT", "sourceRevision must be sha1:<40 hex> or sha256:<64 hex>");
    }
    if (scripts && scripts.length > 64) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "too many tool scripts");
    if (instructions.length > 100) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "too many agent instruction assets");
    for (const script of scripts ?? []) {
      if (!/^[A-Za-z0-9._-]+$/u.test(script.entrypoint) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(script.toolId)) {
        throw new BrainDomainError("INVALID_CONTRACT", "tool script toolId/entrypoint malformed");
      }
      if (Buffer.from(script.bytesBase64, "base64").length > 1024 * 1024) {
        throw new BrainDomainError("PAYLOAD_TOO_LARGE", "tool script exceeds 1 MiB");
      }
    }
    for (const instruction of instructions) {
      const bytes = Buffer.byteLength(instruction.text, "utf8");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(instruction.agentId) || !/^[A-Za-z0-9][A-Za-z0-9/_-]*\.md$/u.test(instruction.path) || instruction.path.includes("..")) {
        throw new BrainDomainError("INVALID_CONTRACT", "agent instruction agentId/path malformed");
      }
      if (bytes > 256 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "agent instructions exceed 256 KiB");
    }
    const compiled = compileRelease(docs, sourceRevision, scripts, instructions, schemas);
    const s = this.store;
    s.inTx(s.control, () => {
      const compilerDigest = (compiled.manifest as { compilerDigest?: string }).compilerDigest ?? compiled.digest;
      s.control.prepare("INSERT OR IGNORE INTO config_releases(digest, organization_id, source_revision, compiler_digest, source_documents_json, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
        .run(compiled.digest, actor.organizationId, sourceRevision, compilerDigest, JSON.stringify(docs), JSON.stringify({ manifest: compiled.manifest, workflows: compiled.workflows, agents: compiled.agents, evaluators: compiled.evaluators, tools: compiled.tools, schemas: compiled.schemas }), s.now());
      for (const script of scripts ?? []) {
        const bytes = new Uint8Array(Buffer.from(script.bytesBase64, "base64"));
        const digest = sha256Digest(bytes);
        const path = this.casPath(digest);
        mkdirSync(join(path, ".."), { recursive: true });
        if (!existsSync(path)) writeFileSync(path, bytes);
        s.control.prepare("INSERT OR REPLACE INTO release_files(release_digest, tool_id, entrypoint, digest, bytes, created_at_ms) VALUES (?,?,?,?,?,?)")
          .run(compiled.digest, script.toolId, script.entrypoint, digest, bytes.length, s.now());
      }
      for (const instruction of instructions) {
        const bytes = new TextEncoder().encode(instruction.text);
        const digest = sha256Digest(bytes);
        const path = this.casPath(digest);
        mkdirSync(join(path, ".."), { recursive: true });
        if (!existsSync(path)) writeFileSync(path, bytes);
        s.control.prepare("INSERT OR REPLACE INTO release_files(release_digest, tool_id, entrypoint, digest, bytes, created_at_ms) VALUES (?,?,?,?,?,?)")
          .run(compiled.digest, `agent:${instruction.agentId}`, instruction.path, digest, bytes.length, s.now());
      }
      s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "config", aggregateId: compiled.digest, eventType: "config.compiled", payload: { digest: compiled.digest } });
    });
    return { digest: compiled.digest };
  }

  listVerifiedEvidence(actor: ActorContext, workspaceId: string): JsonValue {
    requireWorkspaceRead(this.store, actor, workspaceId);
    const rows = this.store.workspaceDb(workspaceId, actor.organizationId).prepare("SELECT digest,manifest_json FROM evidence_bundles WHERE state='verified' ORDER BY created_at_ms DESC LIMIT 100").all() as Array<{ digest: string; manifest_json: string }>;
    return { items: rows.map((row) => {
      const manifest = JSON.parse(row.manifest_json) as { checks?: Array<{ criterionId: string; status: string }> };
      return { digest: row.digest, passedCriteria: (manifest.checks ?? []).filter((check) => check.status === "passed").map((check) => check.criterionId) };
    }) } as JsonValue;
  }

  listReleases(actor: ActorContext): JsonValue {
    requireConfigurationAdmin(this.store, actor);
    const active = this.activeRelease(actor.organizationId);
    const rows = this.store.control.prepare("SELECT digest,source_revision,manifest_json,created_at_ms FROM config_releases WHERE organization_id=? ORDER BY created_at_ms DESC LIMIT 50").all(actor.organizationId) as Array<{ digest: string; source_revision: string; manifest_json: string; created_at_ms: number }>;
    return { items: rows.map((row) => {
      const stored = JSON.parse(row.manifest_json) as { manifest?: { documents?: Array<{ kind: string }> } };
      const documents = stored.manifest?.documents ?? [];
      return { digest: row.digest, sourceRevision: row.source_revision, createdAt: iso(row.created_at_ms), active: row.digest === active?.digest,
        agents: documents.filter((doc) => doc.kind === "Agent").length, workflows: documents.filter((doc) => doc.kind === "Workflow").length,
        assets: documents.filter((doc) => doc.kind !== "Agent" && doc.kind !== "Workflow").length };
    }) } as JsonValue;
  }

  inspectRelease(actor: ActorContext, digest: string): JsonValue {
    requireConfigurationAdmin(this.store, actor);
    const row = this.store.control.prepare("SELECT digest,source_revision,manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(digest, actor.organizationId) as { digest: string; source_revision: string; manifest_json: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "config release not found");
    const active = this.activeRelease(actor.organizationId);
    return { digest: row.digest, sourceRevision: row.source_revision, expectedActiveDigest: active?.digest ?? null, ...JSON.parse(row.manifest_json) } as JsonValue;
  }

  activateRelease(actor: ActorContext, digest: string, expectedActiveDigest?: string | null): void {
    activateRelease(this.store, actor, digest, expectedActiveDigest);
  }

  activeRelease(organizationId: string): { digest: string; manifest: string } | undefined {
    return configActiveRelease(this.store, organizationId);
  }

  workflowFromRelease(organizationId: string, workflowId: string): { workflow: import("@brain/contracts").Workflow; configDigest: string } {
    const rel = this.activeRelease(organizationId);
    if (!rel) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "no active config release");
    const parsed = JSON.parse(rel.manifest) as { workflows?: Record<string, import("@brain/contracts").Workflow> };
    const wf = parsed.workflows?.[workflowId];
    if (!wf) throw new BrainDomainError("NOT_FOUND", `workflow ${workflowId} not in active release`);
    return { workflow: wf, configDigest: rel.digest };
  }

  loadWorkflow(organizationId: string, workflowId: string): { workflow: import("@brain/contracts").Workflow; configDigest: string } {
    return this.workflowFromRelease(organizationId, workflowId);
  }

  recordSteer(input: { organizationId: string; workspaceId: string; runId: string; stepId: string; payload: JsonValue }): void {
    const s = this.store;
    const ws = s.workspaceDb(input.workspaceId, input.organizationId);
    const payload = (input.payload ?? {}) as { sessionId?: string };
    ws.prepare("INSERT INTO session_controls(id, session_id, kind, payload, created_at_ms) VALUES (?,?,?,?,?)")
      .run(s.id("ctl"), payload.sessionId ?? input.runId, "session.steer", JSON.stringify({ ...payload, runId: input.runId, stepId: input.stepId }), s.now());
  }

  // --- jobs (WorkflowHost + scheduler) ---
  createJobForStep(input: {
    organizationId: string; workspaceId: string; runId: string; stepId: string;
    executionKey: string; configDigest: string; placementJson: string;
    executionDigest: string; effectClass: string; kind: string; payload: JsonValue;
  }): string {
    const s = this.store;
    let jobId = "";
    s.inTx(s.control, () => {
      s.assertWorkspaceActive(input.workspaceId, input.organizationId);
      const existing = s.control.prepare("SELECT id FROM jobs WHERE organization_id=? AND execution_key=?").get(input.organizationId, input.executionKey) as { id: string } | undefined;
      if (existing) { jobId = existing.id; return; }
      jobId = s.id("job");
      let placementJson = input.placementJson;
      const step = (input.payload as { step?: { uses?: { type: string; release: { id: string } } } }).step;
      if (step?.uses?.type === "agent") {
        const release = s.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(input.configDigest, input.organizationId) as { manifest_json: string };
        const agent = (JSON.parse(release.manifest_json) as { agents: Record<string, import("@brain/contracts").Agent> }).agents[step.uses.release.id];
        if (!agent) throw new BrainDomainError("INVALID_CONTRACT", "agent is absent from pinned release");
        const placement = JSON.parse(placementJson) as import("@brain/contracts").Placement;
        const anyOf = placement.engine ? agent.spec.engine.anyOf.filter((id) => placement.engine!.anyOf.includes(id)) : agent.spec.engine.anyOf;
        if (!anyOf.length) throw new BrainDomainError("INVALID_CONTRACT", "agent and workflow engine requirements do not intersect");
        placementJson = JSON.stringify({ ...placement, engine: { anyOf, features: [...new Set([...agent.spec.engine.features, ...(placement.engine?.features ?? [])])] } });
      }
      const runTarget = s.workspaceDb(input.workspaceId, input.organizationId).prepare("SELECT runner_id FROM run_inputs WHERE run_id=?").get(input.runId) as { runner_id: string | null } | undefined;
      if (runTarget?.runner_id) placementJson = JSON.stringify({ ...(JSON.parse(placementJson) as import("@brain/contracts").Placement), runnerId: runTarget.runner_id });
      s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, created_at_ms, ready_at_ms, deadline_ms)
        VALUES (?,?,?,?,?,?,'queued',?,?,?,?,'WAITING_FOR_RUNNER',?,?,?)`)
        .run(jobId, input.organizationId, input.workspaceId, input.executionKey, input.runId, input.stepId, input.configDigest, placementJson, input.executionDigest, input.effectClass, s.now(), s.now(), s.now() + 7 * 24 * 3600_000);
      s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(jobId, input.kind, JSON.stringify(input.payload));
      s.emit(s.control, { organizationId: input.organizationId, workspaceId: input.workspaceId, aggregateType: "job", aggregateId: jobId, eventType: "job.queued", payload: { jobId, runId: input.runId, stepId: input.stepId }, destinations: [`workspace:${input.workspaceId}`] });
    });
    return jobId;
  }

  // --- web push (T45): subscriptions are encrypted at rest; delivery is
  // best-effort and never authorizes anything by itself. ---
  private vapidKeys?: VapidKeys;
  private pushKeys(): VapidKeys {
    this.vapidKeys ??= loadOrCreateVapidKeys(this.store.dataDir);
    return this.vapidKeys;
  }
  vapidPublicKey(): string { return this.pushKeys().publicKey; }

  registerPushSubscription(actor: ActorContext, sub: { endpoint: string; p256dh: string; auth: string }): { subscriptionId: string } {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "push subscriptions are for human browsers");
    let url: URL;
    try { url = new URL(sub.endpoint); } catch { throw new BrainDomainError("INVALID_ARGUMENT", "push endpoint must be an absolute URL"); }
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new BrainDomainError("INVALID_ARGUMENT", "push endpoint must be https");
    if (Buffer.from(sub.p256dh, "base64url").length !== 65 || Buffer.from(sub.auth, "base64url").length < 16) {
      throw new BrainDomainError("INVALID_ARGUMENT", "push subscription keys are malformed");
    }
    const s = this.store;
    const digest = s.tokenDigest("push-endpoint", sub.endpoint);
    const encrypted = encryptSubscription(s.pepper, sub);
    const existing = s.control.prepare("SELECT id FROM notification_subscriptions WHERE organization_id=? AND endpoint_digest=?").get(actor.organizationId, digest) as { id: string } | undefined;
    if (existing) {
      s.control.prepare("UPDATE notification_subscriptions SET principal_id=?, encrypted_endpoint_json=?, revoked_at_ms=NULL WHERE id=?").run(actor.actorId, encrypted, existing.id);
      return { subscriptionId: existing.id };
    }
    const id = s.id("push");
    s.control.prepare("INSERT INTO notification_subscriptions(id, organization_id, principal_id, endpoint_digest, encrypted_endpoint_json) VALUES (?,?,?,?,?)")
      .run(id, actor.organizationId, actor.actorId, digest, encrypted);
    return { subscriptionId: id };
  }

  unregisterPushSubscription(actor: ActorContext, endpoint: string): void {
    const s = this.store;
    const digest = s.tokenDigest("push-endpoint", endpoint);
    s.control.prepare("UPDATE notification_subscriptions SET revoked_at_ms=? WHERE organization_id=? AND principal_id=? AND endpoint_digest=?")
      .run(s.now(), actor.organizationId, actor.actorId, digest);
  }

  async notifyPrincipal(organizationId: string, principalId: string, payload: { title: string; body: string; url?: string }): Promise<number> {
    const s = this.store;
    const rows = s.control.prepare("SELECT id, encrypted_endpoint_json FROM notification_subscriptions WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL").all(organizationId, principalId) as Array<{ id: string; encrypted_endpoint_json: string }>;
    if (rows.length === 0) return 0;
    let delivered = 0;
    for (const row of rows) {
      try {
        const sub = decryptSubscription(s.pepper, row.encrypted_endpoint_json);
        const { status } = await sendPush(this.pushKeys(), sub, payload);
        if (status === 404 || status === 410) {
          s.control.prepare("UPDATE notification_subscriptions SET revoked_at_ms=? WHERE id=?").run(s.now(), row.id);
        } else if (status >= 200 && status < 300) {
          delivered += 1;
        }
      } catch { /* push is best-effort; the durable record is the approval inbox */ }
    }
    return delivered;
  }

  private notifyApprovers(input: { organizationId: string; workspaceId: string }): void {
    const approvers = this.store.control.prepare(
      "SELECT DISTINCT principal_id FROM workspace_memberships WHERE workspace_id=? AND organization_id=? AND role IN ('approver','workspace-lead') AND revoked_at_ms IS NULL",
    ).all(input.workspaceId, input.organizationId) as Array<{ principal_id: string }>;
    for (const a of approvers) {
      void this.notifyPrincipal(input.organizationId, a.principal_id, {
        title: "Approval requested", body: "A workflow gate is waiting for your review.", url: "/#/approvals",
      }).catch(() => undefined);
    }
  }

  createApprovalForGate(input: { organizationId: string; workspaceId: string; runId: string; stepId: string; subject: JsonValue; expiresAtMs: number; requestedBy: string }): string {
    const s = this.store;
    const digest = approvalSubjectDigest(input.subject);
    const approvalId = s.id("apr");
    s.inTx(s.control, () => {
      s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
        VALUES (?,?,?,?,?,?,'pending',?,?)`).run(approvalId, input.organizationId, input.workspaceId, input.requestedBy, digest, JSON.stringify(input.subject), input.expiresAtMs, s.now());
      s.control.prepare("INSERT INTO wake_intents(wake_event_id, workspace_id, workflow_run_id, wait_generation, state, next_attempt_at_ms) VALUES (?,?,?,1,'pending',?)")
        .run(`wake-${approvalId}`, input.workspaceId, input.runId, s.now());
      s.emit(s.control, { organizationId: input.organizationId, workspaceId: input.workspaceId, aggregateType: "approval", aggregateId: approvalId, eventType: "approval.requested", payload: { approvalId, subjectDigest: digest } });
    });
    this.notifyApprovers(input);
    return approvalId;
  }

  // --- command funnel ---
  /**
   * Every declared command enters through the command funnel (ADR 0002). The
   * correlation id belongs to the transport boundary (error envelopes and
   * access logs), not to the command envelope, so it is not part of the
   * durable receipt.
   */
  executeCommand(actor: ActorContext, raw: unknown, _correlationId: string, headers?: Headers): Promise<{ receipt: CommandReceipt; status: number }> {
    return this.commands.execute(actor, raw, headers ? { headers } : {});
  }

  // --- approvals + step-up ---
  async decideApproval(identity: ResolvedActor, approvalId: string, body: HumanApprovalDecision): Promise<{ decisionId: string; state: string }> {
    const { actor, cmd } = admitApprovalDecision(this.store, this.auth, identity, approvalId, body);
    const { receipt } = await this.commands.run(actor, cmd, { identity });
    const saved = receipt as unknown as { decisionId: string; state: string };
    return { decisionId: saved.decisionId, state: saved.state };
  }

  decisionStatus(actor: ActorContext, approvalId: string, idempotencyKey: string): JsonValue {
    const s = this.store;
    const row = s.control.prepare("SELECT state, subject_digest, workspace_id FROM approval_requests WHERE id=? AND organization_id=?").get(approvalId, actor.organizationId) as
      | { state: string; subject_digest: string; workspace_id: string } | undefined;
    if (!row || !hasWorkspaceMembership(s, actor.actorId, actor.organizationId, row.workspace_id)) throw new BrainDomainError("NOT_FOUND", "approval not found");
    const prior = s.control.prepare("SELECT receipt_json FROM command_idempotency WHERE organization_id=? AND actor_id=? AND command_type='approval.decision' AND idempotency_key=?")
      .get(actor.organizationId, actor.actorId, idempotencyKey) as { receipt_json: string } | undefined;
    if (!prior) return { status: "pending", approvalId, state: row.state } as unknown as JsonValue;
    const saved = JSON.parse(prior.receipt_json) as { decisionId?: string };
    return { status: "confirmed", approvalId, decisionId: saved.decisionId ?? "", subjectDigest: row.subject_digest, state: row.state } as unknown as JsonValue;
  }

  // --- runner-facing surfaces owned outside modules/jobs ---
  issuePermit(runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return governanceIssuePermit(this.store, { auth: this.auth }, runner, attemptId, body);
  }

  validatePermit(token: string, invocationId: string): boolean {
    return governanceValidatePermit(this.store, { auth: this.auth }, token, invocationId);
  }

  acceptAttemptArtifact(runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, input: { digest: string; bytesBase64: string; mediaType?: string }): { artifactId: string; digest: string; bytes: number } {
    return acceptAttemptArtifact(this.store, runner, attemptId, input);
  }

  readReleaseTool(runner: { runnerId: string; epoch: number; organizationId: string }, releaseDigest: string, toolId: string): { entrypoint: string; entrypointDigest: string; bytes: Uint8Array } {
    return readReleaseToolScript(this.store, runner.organizationId, releaseDigest, toolId);
  }

  readReleaseAgent(runner: { runnerId: string; epoch: number; organizationId: string }, releaseDigest: string, agentId: string): ReturnType<typeof readReleaseAgentInstructions> {
    const attempt = this.store.control.prepare(`SELECT 1 FROM job_attempts a JOIN jobs j ON j.id=a.job_id JOIN job_payloads p ON p.job_id=j.id JOIN runners r ON r.id=a.runner_id
      WHERE a.runner_id=? AND a.runner_epoch=? AND r.session_epoch=a.runner_epoch AND a.state='running' AND j.state='running'
        AND j.organization_id=? AND j.config_digest=? AND json_extract(p.payload_json,'$.step.uses.type')='agent' AND json_extract(p.payload_json,'$.step.uses.release.id')=?
        AND a.lease_expires_at_ms>? AND j.job_fence=a.job_fence`).get(runner.runnerId,runner.epoch,runner.organizationId,releaseDigest,agentId,this.store.now());
    if (!attempt) throw new BrainDomainError("FORBIDDEN","agent asset requires a current matching attempt");
    return readReleaseAgentInstructions(this.store, runner.organizationId, releaseDigest, agentId);
  }

  verifyTrustDomain(identity: ResolvedActor, input: { runnerId: string; domain: string; reason: string }): { capability: string; expiresAtMs: number } {
    assertHumanIdentity(this.store, this.auth, identity, this.runtime.requireTwoFactor);
    const actor = { ...identity.actor, scopes: scopesForPrincipal(this.store, identity.actor.actorId, identity.actor.organizationId) };
    return governanceVerifyTrustDomain(this.store, actor, input);
  }

  revokeTrustDomain(actor: ActorContext, input: { runnerId: string; domain: string; reason: string }): void {
    revokeTrustDomain(this.store, actor, input);
  }

  // --- CAS artifacts ---
  casPath(digest: string): string {
    const hex = digest.replace("sha256:", "");
    return join(this.store.dataDir, "cas", hex.slice(0, 2), hex);
  }

  initUpload(actor: ActorContext, body: Record<string, unknown>): JsonValue {
    const s = this.store;
    const workspaceId = String(body["workspaceId"] ?? "");
    requireWorkspaceRead(s, actor, workspaceId);
    const id = s.id("upl");
    s.control.prepare(`INSERT INTO artifact_uploads(id, organization_id, workspace_id, initiated_by, attempt_id, expected_digest, expected_bytes, state, expires_at_ms, created_at_ms)
      VALUES (?,?,?,?,?,?,?,'open',?,?)`).run(id, actor.organizationId, workspaceId, actor.actorId, body["attemptId"] ? String(body["attemptId"]) : null,
      String(body["expectedDigest"]), Number(body["expectedBytes"] ?? 0), s.now() + 24 * 3600_000, s.now());
    return { uploadId: id, expiresAt: iso(s.now() + 24 * 3600_000) } as unknown as JsonValue;
  }

  private loadOpenUpload(actor: ActorContext, uploadId: string): { organization_id: string; workspace_id: string; expected_digest: string; expected_bytes: number } {
    const s = this.store;
    const row = s.control.prepare("SELECT organization_id, workspace_id, initiated_by, expected_digest, expected_bytes, state, expires_at_ms FROM artifact_uploads WHERE id=?").get(uploadId) as
      | { organization_id: string; workspace_id: string; initiated_by: string; expected_digest: string; expected_bytes: number; state: string; expires_at_ms: number } | undefined;
    // An upload is completable only by its initiator (T27 ownership).
    if (!row || row.organization_id !== actor.organizationId || row.initiated_by !== actor.actorId) {
      throw new BrainDomainError("NOT_FOUND", "upload not found");
    }
    if (row.state !== "open" || row.expires_at_ms <= s.now()) throw new BrainDomainError("CONFLICT", "upload closed or expired");
    return row;
  }

  private finalizeUpload(uploadId: string, row: { organization_id: string; workspace_id: string }, digest: string, byteCount: number): JsonValue {
    const s = this.store;
    const artifactId = `art-${uploadId}`;
    s.inTx(s.control, () => {
      s.control.prepare("UPDATE artifact_uploads SET state='complete', received_bytes=? WHERE id=?").run(byteCount, uploadId);
      s.control.prepare(`INSERT OR IGNORE INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms)
        VALUES (?,?,?,?,'upload',?,'internal',?)`).run(artifactId, row.organization_id, row.workspace_id, digest, uploadId, s.now());
    });
    const ws = s.workspaceDb(row.workspace_id, row.organization_id);
    ws.prepare("INSERT OR IGNORE INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES (?,?,?, 'application/octet-stream','internal','verified',?)")
      .run(artifactId, digest, byteCount, s.now());
    return { artifactId, digest, bytes: byteCount, mediaType: "application/octet-stream", classification: "internal" } as unknown as JsonValue;
  }

  putUpload(actor: ActorContext, uploadId: string, bytes: Uint8Array): JsonValue {
    const s = this.store;
    const row = this.loadOpenUpload(actor, uploadId);
    if (bytes.length > 100 * 1024 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "artifact exceeds 100 MiB");
    const digest = sha256Digest(bytes);
    if (digest !== row.expected_digest || bytes.length !== row.expected_bytes) {
      s.control.prepare("UPDATE artifact_uploads SET state='rejected' WHERE id=?").run(uploadId);
      throw new BrainDomainError("INVALID_CONTRACT", "artifact digest/size mismatch");
    }
    const path = this.casPath(digest);
    mkdirSync(join(path, ".."), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes);
    return this.finalizeUpload(uploadId, row, digest, bytes.length);
  }

  // Streamed completion (T27): bytes go to a temp file with an incremental
  // digest, so multi-megabyte artifacts never sit whole in memory. Oversize
  // streams abort mid-flight and the upload is rejected.
  async putUploadStream(actor: ActorContext, uploadId: string, chunks: AsyncIterable<Uint8Array>): Promise<JsonValue> {
    const s = this.store;
    const row = this.loadOpenUpload(actor, uploadId);
    const limit = Math.min(100 * 1024 * 1024, row.expected_bytes);
    const tmpDir = join(s.dataDir, "upload-tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${uploadId}.part`);
    const hash = createHash("sha256");
    let received = 0;
    const out = createWriteStream(tmpPath);
    try {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > limit) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "artifact stream exceeds declared size");
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    } catch (e) {
      out.destroy();
      try { unlinkSync(tmpPath); } catch { /* already gone */ }
      s.control.prepare("UPDATE artifact_uploads SET state='rejected' WHERE id=?").run(uploadId);
      throw e;
    }
    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== row.expected_digest || received !== row.expected_bytes) {
      try { unlinkSync(tmpPath); } catch { /* already gone */ }
      s.control.prepare("UPDATE artifact_uploads SET state='rejected' WHERE id=?").run(uploadId);
      throw new BrainDomainError("INVALID_CONTRACT", "artifact digest/size mismatch");
    }
    const path = this.casPath(digest);
    mkdirSync(join(path, ".."), { recursive: true });
    if (existsSync(path)) unlinkSync(tmpPath);
    else renameSync(tmpPath, path);
    return this.finalizeUpload(uploadId, row, digest, received);
  }

  readArtifact(actor: ActorContext, artifactId: string): Uint8Array {
    return readArtifactBytes(this.store, actor, artifactId);
  }

  // E090: CAS garbage collection. Evidence/upload references and every
  // immutable document version are always retained; only unreferenced files
  // older than the grace window can be removed.
  casSweep(graceMs = 24 * 3600_000): { scanned: number; removed: number; retained: number } {
    const s = this.store;
    const referenced = new Set<string>();
    for (const r of s.control.prepare("SELECT digest FROM artifact_associations").all() as Array<{ digest: string }>) {
      referenced.add(r.digest.replace("sha256:", ""));
    }
    for (const r of s.control.prepare("SELECT expected_digest FROM artifact_uploads WHERE state='open' AND expires_at_ms>?").all(s.now()) as Array<{ expected_digest: string }>) {
      referenced.add(r.expected_digest.replace("sha256:", ""));
    }
    for (const workspace of s.control.prepare("SELECT id,organization_id FROM workspaces").all() as Array<{ id: string; organization_id: string }>) {
      const db = s.workspaceDb(workspace.id, workspace.organization_id);
      for (const version of db.prepare("SELECT digest FROM document_versions").all() as Array<{ digest: string }>) referenced.add(version.digest.replace("sha256:", ""));
    }
    const casDir = join(s.dataDir, "cas");
    let scanned = 0, removed = 0, retained = 0;
    if (!existsSync(casDir)) return { scanned, removed, retained };
    for (const shard of readdirSync(casDir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const shardDir = join(casDir, shard.name);
      for (const name of readdirSync(shardDir)) {
        scanned++;
        const full = join(shardDir, name);
        if (referenced.has(name)) { retained++; continue; }
        const age = s.now() - statSync(full).mtimeMs;
        if (age < graceMs) { retained++; continue; }
        unlinkSync(full);
        removed++;
      }
    }
    return { scanned, removed, retained };
  }

  // --- evidence & verdicts ---
  submitEvidence(runner: { runnerId: string; epoch: number; organizationId: string }, raw: unknown): JsonValue {
    const result = this.evidence.submit(runner,raw);
    const bundle = raw as import("@brain/contracts").EvidenceBundle;
    this.workflows.evidenceSubmitted(runner.organizationId,bundle.workspaceId,bundle.workflowRunId);
    return result;
  }

  acceptVerdict(runner: { runnerId: string; epoch: number; organizationId: string }, workspaceId: string, raw: unknown): JsonValue {
    const result = this.evidence.accept(runner, workspaceId, raw);
    if (result.outcome === "verified") this.capitalization.captureVerifiedBundle(runner.organizationId, workspaceId, (raw as { bundleDigest: string }).bundleDigest);
    return result;
  }

  reconcileJob(input: { organizationId: string; jobId: string; outcome: "applied" | "absent" | "conflicting" | "unknown"; evidenceDigest: string }): JsonValue {
    const s = this.store;
    let workspaceId = ""; let runId = ""; let stepId = "";
    s.inTx(s.control, () => {
      const job = s.control.prepare("SELECT workspace_id, workflow_run_id, step_id, state FROM jobs WHERE id=? AND organization_id=?").get(input.jobId, input.organizationId) as
        | { workspace_id: string; workflow_run_id: string; step_id: string; state: string } | undefined;
      if (!job) throw new BrainDomainError("NOT_FOUND", "job not found");
      workspaceId = job.workspace_id; runId = job.workflow_run_id; stepId = job.step_id;
      s.control.prepare("UPDATE reconciliation_requests SET state=?, outcome=?, evidence_digest=? WHERE job_id=? AND state IN ('pending','observing')")
        .run(input.outcome === "unknown" || input.outcome === "conflicting" ? "blocked" : "resolved", input.outcome, input.evidenceDigest, input.jobId);
      if (input.outcome === "applied") {
        for (const a of s.control.prepare("SELECT id FROM job_attempts WHERE job_id=? AND state='outcome_unknown'").all(input.jobId) as Array<{ id: string }>) {
          transitionState(s.control, "attempt", a.id, "verifying");
        }
        transitionState(s.control, "job", input.jobId, "verifying", { bumpVersion: true });
        s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE attempt_id IN (SELECT id FROM job_attempts WHERE job_id=?)").run(s.now(), input.jobId);
      } else if (input.outcome === "absent") {
        // The unknown attempt is terminally concluded (effect proven absent)
        // so the one-active-attempt index frees the job for a fresh attempt.
        const stale = s.control.prepare("SELECT id FROM job_attempts WHERE job_id=? AND state='outcome_unknown'").all(input.jobId) as Array<{ id: string }>;
        for (const a of stale) transitionState(s.control, "attempt", a.id, "failed");
        transitionState(s.control, "job", input.jobId, "queued", { bumpVersion: true });
        for (const a of stale) this.jobProtocol.releaseReservation(a.id);
        s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE attempt_id IN (SELECT id FROM job_attempts WHERE job_id=?)").run(s.now(), input.jobId);
      }
      // conflicting/unknown: guard remains, job stays outcome_unknown
    });
    void workspaceId; void runId; void stepId;
    return { jobId: input.jobId, outcome: input.outcome } as unknown as JsonValue;
  }

  recordToolObservation(input: Parameters<CapitalizationService["capture"]>[0]): JsonValue {
    return this.capitalization.capture(input);
  }

  runCapitalization(): { processed: number; failed: number } {
    return this.capitalization.processPending();
  }

  // External observation ingest (E082/E086): deliveries dedupe on
  // (sourceId, externalId). The same id with the same payload digest is a
  // stable duplicate; the same id with a *different* digest is parked for
  // repair and never touches the accepted projection.
  ingestObservation(input: {
    organizationId: string; workspaceId: string; sourceId: string;
    externalId: string; cursor: string; payload: JsonValue;
  }): JsonValue {
    const s = this.store;
    const ws = s.workspaceDb(input.workspaceId, input.organizationId);
    const digest = domainDigest("brain:observation:v1", input.payload);
    let outcome = "accepted";
    s.inTx(ws, () => {
      const prior = ws.prepare("SELECT payload_digest, state FROM source_observations WHERE source_id=? AND external_id=?")
        .get(input.sourceId, input.externalId) as { payload_digest: string; state: string } | undefined;
      if (prior) {
        if (prior.payload_digest === digest) { outcome = "duplicate"; return; }
        ws.prepare("INSERT INTO parked_observations(source_id, external_id, payload_digest, payload_json, reason, created_at_ms) VALUES (?,?,?,?,?,?)")
          .run(input.sourceId, input.externalId, digest, JSON.stringify(input.payload), "id-collision-different-payload", s.now());
        outcome = "parked";
        return;
      }
      ws.prepare("INSERT INTO source_observations(source_id, external_id, cursor, payload_digest, payload_json, state, created_at_ms) VALUES (?,?,?,?,?,'accepted',?)")
        .run(input.sourceId, input.externalId, input.cursor, digest, JSON.stringify(input.payload), s.now());
    });
    return { outcome, sourceId: input.sourceId, externalId: input.externalId, payloadDigest: digest } as unknown as JsonValue;
  }

  // --- connector onboarding & pack lifecycles (T41-T44) ---
  // Fact discovery is read-only on the remote system: issues become local
  // ticket facts keyed by (connector_id, remote_id). Re-discovery is
  // idempotent — unchanged facts keep their version; changed facts advance
  // it. Nothing here writes back or proposes merges by default.
  async discoverGitLabFacts(input: {
    actor: ActorContext; workspaceId: string; baseUrl: string; projectId: number; token: string;
  }): Promise<{ discovered: number; created: number; updated: number; unchanged: number }> {
    const s = this.store;
    requireWorkspaceRead(s, input.actor, input.workspaceId);
    const { GitLabConnector } = await import("../modules/packs/index");
    const connector = new GitLabConnector(input.baseUrl, input.projectId, input.token);
    const probe = await connector.probe();
    if (!probe.reachable) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "GitLab project is not reachable for discovery");
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const cursorRow = ws.prepare("SELECT source_watermark FROM connector_cursors WHERE connector_id='gitlab'").get() as { source_watermark: string | null } | undefined;
    const issues = await connector.listIssues(cursorRow?.source_watermark ?? undefined);
    let created = 0; let updated = 0; let unchanged = 0;
    let watermark: string | null = cursorRow?.source_watermark ?? null;
    s.inTx(ws, () => {
      for (const issue of issues) {
        const iid = Number(issue["iid"]);
        if (!Number.isSafeInteger(iid) || iid <= 0) continue;
        const title = String(issue["title"] ?? `issue ${iid}`).slice(0, 512);
        const state = String(issue["state"] ?? "opened") === "closed" ? "closed" : "open";
        const updatedAt = String(issue["updated_at"] ?? "");
        if (updatedAt && (!watermark || updatedAt > watermark)) watermark = updatedAt;
        const bodyDigest = domainDigest("brain:ticket-fact:v1", { iid, title, state, updatedAt } as unknown as JsonValue);
        const prior = ws.prepare("SELECT id, body_digest FROM tickets WHERE connector_id='gitlab' AND remote_id=?").get(String(iid)) as { id: string; body_digest: string } | undefined;
        if (!prior) {
          ws.prepare("INSERT INTO tickets(id, connector_id, remote_id, state, title, body_digest, source_version, observed_at_ms, created_at_ms) VALUES (?, 'gitlab', ?, ?, ?, ?, ?, ?, ?)")
            .run(`tkt-gl-${iid}`, String(iid), state, title, bodyDigest, updatedAt || "unknown", s.now(), s.now());
          created++;
        } else if (prior.body_digest !== bodyDigest) {
          ws.prepare("UPDATE tickets SET state=?, title=?, body_digest=?, source_version=?, observed_at_ms=?, version=version+1 WHERE id=?")
            .run(state, title, bodyDigest, updatedAt || "unknown", s.now(), prior.id);
          updated++;
        } else {
          unchanged++;
        }
      }
      ws.prepare(`INSERT INTO connector_cursors(connector_id, cursor_json, source_watermark, version, updated_at_ms) VALUES ('gitlab', '{}', ?, 1, ?)
        ON CONFLICT(connector_id) DO UPDATE SET source_watermark=excluded.source_watermark, version=version+1, updated_at_ms=excluded.updated_at_ms`)
        .run(watermark, s.now());
    });
    return { discovered: issues.length, created, updated, unchanged };
  }

  // Support draft lifecycle (T42): drafts are deduped by source fingerprint,
  // publication requires an approved approval and writes the exact approved
  // CAS text; readback reconciliation records the outcome.
  createSupportDraft(input: {
    actor: ActorContext; workspaceId: string; ticketId: string;
    contentDigest: string; sourceFingerprint: string; evidenceDigest: string;
  }): { draftId: string; created: boolean } {
    const s = this.store;
    requireWorkspaceRead(s, input.actor, input.workspaceId);
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    if (!ws.prepare("SELECT 1 FROM tickets WHERE id=?").get(input.ticketId)) throw new BrainDomainError("NOT_FOUND", "ticket not found");
    const existing = ws.prepare("SELECT id FROM support_drafts WHERE ticket_id=? AND source_fingerprint=?").get(input.ticketId, input.sourceFingerprint) as { id: string } | undefined;
    if (existing) return { draftId: existing.id, created: false };
    const count = ws.prepare("SELECT COUNT(*) AS n FROM support_drafts WHERE ticket_id=?").get(input.ticketId) as { n: number };
    const id = s.id("draft");
    ws.prepare("INSERT INTO support_drafts(id, ticket_id, version, content_digest, source_fingerprint, evidence_digest, author_principal_id, approval_id, created_at_ms) VALUES (?,?,?,?,?,?,?,NULL,?)")
      .run(id, input.ticketId, count.n + 1, input.contentDigest, input.sourceFingerprint, input.evidenceDigest, input.actor.actorId, s.now());
    return { draftId: id, created: true };
  }

  approveSupportDraft(input: { actor: ActorContext; workspaceId: string; draftId: string; approvalId: string }): void {
    const s = this.store;
    const approval = s.control.prepare("SELECT state FROM approval_requests WHERE id=? AND organization_id=?").get(input.approvalId, input.actor.organizationId) as { state: string } | undefined;
    if (!approval || approval.state !== "approved") throw new BrainDomainError("FORBIDDEN", "support draft approval requires an approved approval request");
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const changed = ws.prepare("UPDATE support_drafts SET approval_id=? WHERE id=? AND approval_id IS NULL").run(input.approvalId, input.draftId);
    if (changed.changes === 0) throw new BrainDomainError("CONFLICT", "support draft not found or already approved");
  }

  async publishSupportDraft(input: {
    actor: ActorContext; workspaceId: string; draftId: string;
    baseUrl: string; projectId: number; token: string;
  }): Promise<{ outcome: string }> {
    const s = this.store;
    requireWorkspaceRead(s, input.actor, input.workspaceId);
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const draft = ws.prepare("SELECT d.content_digest, d.approval_id, t.remote_id, t.connector_id FROM support_drafts d JOIN tickets t ON t.id=d.ticket_id WHERE d.id=?").get(input.draftId) as
      | { content_digest: string; approval_id: string | null; remote_id: string; connector_id: string } | undefined;
    if (!draft) throw new BrainDomainError("NOT_FOUND", "support draft not found");
    if (!draft.approval_id) throw new BrainDomainError("FORBIDDEN", "unapproved support drafts cannot be published");
    if (draft.connector_id !== "gitlab") throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `publishing to ${draft.connector_id} is not installed`);
    const textBytes = readFileSync(this.casPath(draft.content_digest));
    if (sha256Digest(textBytes) !== draft.content_digest) throw new BrainDomainError("CONFLICT", "draft content CAS digest mismatch");
    const { GitLabConnector } = await import("../modules/packs/index");
    const connector = new GitLabConnector(input.baseUrl, input.projectId, input.token);
    const iid = Number(draft.remote_id);
    const before = await connector.reconcileNote(iid, textBytes.toString("utf8"));
    if (before.outcome === "applied") return { outcome: "already-applied" };
    if (before.outcome === "conflicting") return { outcome: "conflicting" };
    await connector.createNote(iid, textBytes.toString("utf8"));
    const after = await connector.reconcileNote(iid, textBytes.toString("utf8"));
    return { outcome: after.outcome };
  }

  // Remediation proposals (T43): generated only from fresh observations and
  // inert until an approved approval is attached. Proposals never execute.
  proposeRemediation(input: {
    actor: ActorContext; workspaceId: string; incidentId: string; kind: string; detail: string;
  }): { proposalId: string } {
    const s = this.store;
    requireWorkspaceRead(s, input.actor, input.workspaceId);
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const incident = ws.prepare("SELECT state FROM incidents WHERE id=?").get(input.incidentId) as { state: string } | undefined;
    if (!incident) throw new BrainDomainError("NOT_FOUND", "incident not found");
    if (incident.state === "resolved") throw new BrainDomainError("CONFLICT", "resolved incidents take no remediation proposals");
    const fresh = ws.prepare("SELECT MAX(expires_at_ms) AS expires FROM observations WHERE incident_id=?").get(input.incidentId) as { expires: number | null };
    if (!fresh.expires || fresh.expires <= s.now()) {
      throw new BrainDomainError("CONFLICT", "remediation proposals require a fresh (unexpired) observation");
    }
    const id = s.id("rem");
    ws.prepare("INSERT INTO remediation_proposals(id, incident_id, kind, detail, state, created_at_ms) VALUES (?,?,?,?, 'proposed', ?)")
      .run(id, input.incidentId, input.kind, input.detail, s.now());
    return { proposalId: id };
  }

  decideRemediation(input: { actor: ActorContext; workspaceId: string; proposalId: string; approvalId: string }): void {
    const s = this.store;
    const approval = s.control.prepare("SELECT state FROM approval_requests WHERE id=? AND organization_id=?").get(input.approvalId, input.actor.organizationId) as { state: string } | undefined;
    if (!approval || approval.state !== "approved") throw new BrainDomainError("FORBIDDEN", "remediation requires an approved approval request");
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const changed = ws.prepare("UPDATE remediation_proposals SET state='approved', approval_id=? WHERE id=? AND state='proposed'").run(input.approvalId, input.proposalId);
    if (changed.changes === 0) throw new BrainDomainError("CONFLICT", "remediation proposal not found or already decided");
  }

  // Delivery dossier lifecycle (T44): explicit creation, rubric results only
  // from real attempts, and an explicit finalize that computes the verdict
  // deterministically — reads never transition state.
  createDeliveryDossier(input: {
    actor: ActorContext; workspaceId: string; sourceRevision: string; manifestDigest: string; rubricDigest: string;
  }): { dossierId: string } {
    const s = this.store;
    requireWorkspaceRead(s, input.actor, input.workspaceId);
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const id = s.id("dossier");
    ws.prepare("INSERT INTO delivery_dossiers(id, source_revision, manifest_digest, rubric_digest, state, version, created_at_ms) VALUES (?,?,?,?, 'draft', 1, ?)")
      .run(id, input.sourceRevision, input.manifestDigest, input.rubricDigest, s.now());
    return { dossierId: id };
  }

  recordRubricResult(input: {
    actor: ActorContext; workspaceId: string; dossierId: string;
    criterionId: string; evaluatorAttemptId: string; outcome: "passed" | "failed" | "incomplete"; evidenceDigest: string;
  }): void {
    const s = this.store;
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const dossier = ws.prepare("SELECT state FROM delivery_dossiers WHERE id=?").get(input.dossierId) as { state: string } | undefined;
    if (!dossier) throw new BrainDomainError("NOT_FOUND", "delivery dossier not found");
    if (dossier.state !== "draft" && dossier.state !== "evaluating") throw new BrainDomainError("CONFLICT", "dossier is finalized");
    // Evidence must be real; the attempt reference is recorded for provenance
    // when it names a Governor attempt, but external evaluator attempts are
    // accepted as declared provenance (their verdicts are separately pinned).
    if (!ws.prepare("SELECT 1 FROM artifacts WHERE digest=?").get(input.evidenceDigest)) {
      throw new BrainDomainError("EVIDENCE_MISSING", "rubric evidence artifact not found in workspace");
    }
    ws.prepare("INSERT OR REPLACE INTO rubric_results(dossier_id, criterion_id, evaluator_attempt_id, outcome, evidence_digest) VALUES (?,?,?,?,?)")
      .run(input.dossierId, input.criterionId, input.evaluatorAttemptId, input.outcome, input.evidenceDigest);
    ws.prepare("UPDATE delivery_dossiers SET state='evaluating', version=version+1 WHERE id=? AND state='draft'").run(input.dossierId);
  }

  finalizeDeliveryDossier(input: { actor: ActorContext; workspaceId: string; dossierId: string; expectedVersion: number }): { state: string } {
    const s = this.store;
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const dossier = ws.prepare("SELECT state, version FROM delivery_dossiers WHERE id=?").get(input.dossierId) as { state: string; version: number } | undefined;
    if (!dossier) throw new BrainDomainError("NOT_FOUND", "delivery dossier not found");
    assertExpectedVersion(dossier.version, input.expectedVersion);
    if (dossier.state !== "evaluating") throw new BrainDomainError("CONFLICT", "only evaluating dossiers can be finalized");
    const results = ws.prepare("SELECT outcome FROM rubric_results WHERE dossier_id=?").all(input.dossierId) as Array<{ outcome: string }>;
    if (results.length === 0) throw new BrainDomainError("CONFLICT", "cannot finalize a dossier with no rubric results");
    const state = results.every((r) => r.outcome === "passed") ? "verified" : "rejected";
    ws.prepare("UPDATE delivery_dossiers SET state=?, version=version+1 WHERE id=? AND version=?").run(state, input.dossierId, dossier.version);
    return { state };
  }

  // Optional calibrated judge (T44): assesses pinned evidence against rubric
  // criteria with the local model, stores each transcript as CAS evidence,
  // and records outcomes through the ordinary rubric-result path. The judge
  // is advisory — it can add results but never finalizes or advances state
  // beyond the same draft→evaluating transition any evaluator causes.
  async judgeDeliveryDossier(input: {
    actor: ActorContext; workspaceId: string; dossierId: string;
    criteria: Array<{ criterionId: string; criterionText: string; evidenceDigest: string }>;
  }): Promise<Array<{ criterionId: string; outcome: string; transcriptDigest: string }>> {
    const s = this.store;
    requireWorkspaceRead(s, input.actor, input.workspaceId);
    const ws = s.workspaceDb(input.workspaceId, input.actor.organizationId);
    const dossier = ws.prepare("SELECT state FROM delivery_dossiers WHERE id=?").get(input.dossierId) as { state: string } | undefined;
    if (!dossier) throw new BrainDomainError("NOT_FOUND", "delivery dossier not found");
    if (dossier.state !== "draft" && dossier.state !== "evaluating") throw new BrainDomainError("CONFLICT", "dossier is finalized");
    const { runLocalJudge, judgeModelId, JUDGE_PROMPT_VERSION } = await import("../modules/packs/index");
    const out: Array<{ criterionId: string; outcome: string; transcriptDigest: string }> = [];
    for (const criterion of input.criteria) {
      const evPath = this.casPath(criterion.evidenceDigest);
      const evidenceText = readFileSync(evPath).toString("utf8").slice(0, 32_768);
      let verdict;
      try {
        verdict = await runLocalJudge({ criterionText: criterion.criterionText, evidenceText });
      } catch (e) {
        throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", `judge model unavailable: ${(e as Error).message}`);
      }
      const transcript = Buffer.from(JSON.stringify({
        promptVersion: JUDGE_PROMPT_VERSION, model: judgeModelId(), criterionId: criterion.criterionId,
        criterionText: criterion.criterionText, evidenceDigest: criterion.evidenceDigest,
        outcome: verdict.outcome, rationale: verdict.rationale, raw: verdict.raw.slice(0, 4096),
      }), "utf8");
      const digest = sha256Digest(transcript);
      const up = this.initUpload(input.actor, { workspaceId: input.workspaceId, expectedDigest: digest, expectedBytes: transcript.length }) as unknown as { uploadId: string };
      this.putUpload(input.actor, up.uploadId, transcript);
      this.recordRubricResult({
        actor: input.actor, workspaceId: input.workspaceId, dossierId: input.dossierId,
        criterionId: criterion.criterionId, evaluatorAttemptId: `judge:${judgeModelId()}:${s.now()}`,
        outcome: verdict.outcome, evidenceDigest: digest,
      });
      out.push({ criterionId: criterion.criterionId, outcome: verdict.outcome, transcriptDigest: digest });
    }
    return out;
  }

  // --- queries ---
  /** The standard query envelope: every read model is wrapped here, once. */
  private envelope(queryType: string, snapshot: JsonValue, cursor = ""): JsonValue {
    const wm = this.store.control.prepare("SELECT COALESCE(MAX(cursor),0) AS m FROM events").get() as { m: number };
    return { queryType, snapshot, cursor, sourceWatermark: wm.m, asOf: this.store.nowIso(), projectionLagMs: 0 } as unknown as JsonValue;
  }

  /**
   * The single query entry: contract validation, registry gating, limit clamps
   * and organization routing stay here; every read model is module-owned and
   * reached by a one-line dispatch.
   */
  async executeQuery(actor: ActorContext, raw: unknown, headers?: Headers): Promise<JsonValue> {
    const s = this.store;
    const check = validate("QueryRequest", raw);
    if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", check.errors.join("; "));
    const q = raw as { queryType: string; workspaceId?: string; resourceId?: string; limit?: number; commandId?: string };
    if (isOrganizationQuery(q)) return executeOrganizationQuery(s, this.auth, actor, raw, headers ?? new Headers());
    if (!isKnownQuery(q.queryType)) throw new BrainDomainError("INVALID_CONTRACT", `unknown query ${q.queryType}`);
    // stream.* queries own their clamps (tail ≤ 200, search ≤ 50, compare
    // ≤ 500×4); the generic clamp would silently cap stream.tail at 100.
    const limit = q.queryType.startsWith("stream.")
      ? Math.max(Math.floor(Number(q.limit ?? 100)) || 100, 1)
      : Math.min(Math.max(q.limit ?? 50, 1), 100);
    const workspaces = (): string[] => (q.workspaceId ? [q.workspaceId] : orgWorkspaces(s, actor));
    const requireRead = (): void => { if (q.workspaceId) requireWorkspaceRead(s, actor, q.workspaceId); };
    switch (q.queryType) {
      case "platform.health":
        return this.envelope(q.queryType, platformHealth(s, this.memoryProbe));
      case "workspace.context": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        return this.envelope(q.queryType, workspaceContext(s, actor, q.workspaceId));
      }
      case "jobs.list": {
        requireRead();
        const filters = q as typeof q & { states?: string[]; search?: string; cursor?: string };
        const page = listJobs(s, actor, workspaces(), limit, { states: filters.states, search: filters.search, cursor: filters.cursor });
        return this.envelope(q.queryType, page.snapshot, page.cursor);
      }
      case "job.get":
        return this.envelope(q.queryType, getJob(s, actor, String(q.resourceId)));
      case "job.explain":
        return this.envelope(q.queryType, explainJob(s, actor, String(q.resourceId)) as unknown as JsonValue);
      case "runners.list":
        return this.envelope(q.queryType, listRunners(s, actor, limit));
      case "runner.get":
        return this.envelope(q.queryType, getRunner(s, actor, String(q.resourceId)));
      case "approvals.list": {
        requireRead();
        return this.envelope(q.queryType, listApprovals(s, actor, workspaces(), limit));
      }
      case "approval.get": {
        requireRead();
        return this.envelope(q.queryType, getApproval(s, actor, workspaces(), String(q.resourceId)));
      }
      case "configDrafts.list": case "configDrafts.get": case "configDrafts.impact": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        return this.envelope(q.queryType, this.drafts.query(actor, q.queryType, q.workspaceId, q.resourceId));
      }
      case "integrations.list": case "integrations.repositories": {
        return this.envelope(q.queryType, this.integrations.query(actor, q.queryType, q.resourceId));
      }
      case "documents.list": case "documents.get": case "documents.search": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        return this.envelope(q.queryType, this.documents.query(actor, q.queryType, q.workspaceId, q.resourceId, limit, (raw as { search?: string }).search));
      }
      case "sessions.list": case "session.get": case "delegations.list": case "workItemMessages.list": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const snapshot = this.sessions.query(actor, q.queryType, q.workspaceId, q.resourceId, limit);
        if (q.queryType !== "session.get") return this.envelope(q.queryType, snapshot);
        // Interruption semantics: the console renders exactly one suggested
        // operation from these facts and enables only commands that exist.
        this.stream.project();
        const sessionId = String(q.resourceId);
        const continuation = continuationFacts(this.store, { organizationId: actor.organizationId, workspaceId: q.workspaceId, sessionId });
        const extended = { ...(snapshot as unknown as Record<string, JsonValue>), streamCursor: this.stream.headForSession(sessionId), continuation } as unknown as JsonValue;
        return this.envelope(q.queryType, extended);
      }
      case "knowledgeAssets.list": case "capabilityCandidates.list": case "capitalizationRuns.list": case "toolCandidates.list": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        return this.envelope(q.queryType, this.capitalization.query(actor, q.queryType, q.workspaceId, limit));
      }
      case "automations.list": case "automations.occurrences": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        return this.envelope(q.queryType, this.jobProtocol.automations.query(actor, q.queryType, q.workspaceId, q.resourceId, limit));
      }
      case "objectives.list": case "objectives.get": case "plans.get": case "workItems.list": case "workItems.get": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        return this.envelope(q.queryType, this.work.query(actor, q.queryType, q.workspaceId, q.resourceId, limit));
      }
      case "board.get": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        return this.envelope(q.queryType, this.board.query(actor, q.workspaceId));
      }
      case "command.get": {
        const commandId = String((raw as { commandId?: string }).commandId ?? q.resourceId ?? "");
        return this.envelope(q.queryType, commandReceipt(s, actor, commandId));
      }
      case "memory.search": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const mq = (raw as { memoryQuery: import("@brain/contracts").MemoryQuery }).memoryQuery;
        const found = this.memory.search(mq, { organizationId: actor.organizationId, workspaceId: q.workspaceId });
        return this.envelope(q.queryType, found as unknown as JsonValue);
      }
      case "search.global": {
        requireRead();
        const matches = textMatcher((q as typeof q & { search: string }).search.trim());
        const results: Array<Record<string, JsonValue>> = [];
        for (const workspaceId of workspaces().slice(0, 25)) {
          results.push(
            ...searchJobs(s, actor.organizationId, workspaceId, matches),
            ...searchApprovals(s, actor.organizationId, workspaceId, matches),
            ...searchSessions(s, actor.organizationId, workspaceId, matches),
            ...searchArtifacts(s, actor.organizationId, workspaceId, matches),
            ...searchReleaseDocuments(s, actor.organizationId, workspaceId, matches, s.nowIso()),
          );
        }
        return this.envelope(q.queryType, { items: results.slice(0, limit) } as unknown as JsonValue);
      }
      case "today":
        return this.envelope(q.queryType, today(s, actor, orgWorkspaces(s, actor), limit));
      case "bridge":
        return this.envelope(q.queryType, bridge(s, actor, orgWorkspaces(s, actor)));
      case "tools.list": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        return this.envelope(q.queryType, this.capitalization.query(actor, q.queryType, q.workspaceId, limit));
      }
      case "tickets.list": case "incidents.list": case "delivery.list": case "decisions.list": case "members.list": case "audit.list": {
        requireRead();
        return this.envelope(q.queryType, listPack(s, actor, q.queryType, q.workspaceId));
      }
      case "ticket.get": case "incident.get": case "delivery.get":
        return this.envelope(q.queryType, getPack(s, actor, q.queryType, q.workspaceId, String(q.resourceId ?? "")));
      case "evidence.get": {
        requireRead();
        return this.envelope(q.queryType, getPack(s, actor, q.queryType, q.workspaceId, String(q.resourceId ?? "")));
      }
      case "sla.summary": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const periodStart = Date.parse(String((raw as { periodStart?: string }).periodStart ?? "")) || 0;
        const periodEnd = Date.parse(String((raw as { periodEnd?: string }).periodEnd ?? "")) || s.now();
        return this.envelope(q.queryType, slaSummary(s, actor, q.workspaceId, periodStart, periodEnd));
      }
      case "stream.tail": case "stream.search": case "stream.context": case "stream.compare": {
        // Projection-on-read: seeded source rows surface without waiting for
        // the maintenance tick. Watermark-guarded, so this is cheap.
        this.stream.project();
        const filters = this.streamFiltersOf(raw);
        switch (q.queryType) {
          case "stream.tail":
            return this.envelope(q.queryType, this.stream.read(actor, filters, (raw as { limit?: number }).limit) as unknown as JsonValue);
          case "stream.search": {
            const search = String((raw as { search?: string }).search ?? "");
            if (!search.trim()) throw new BrainDomainError("INVALID_ARGUMENT", "search text required");
            return this.envelope(q.queryType, this.stream.search(actor, { ...filters, search }, (raw as { limit?: number }).limit) as unknown as JsonValue);
          }
          case "stream.context": {
            const eventId = String((raw as { eventId?: string }).eventId ?? q.resourceId ?? "");
            return this.envelope(q.queryType, this.stream.context(actor, eventId));
          }
          default: {
            const compare = raw as { jobId?: string; attemptIds?: readonly string[] };
            const jobId = String(compare.jobId ?? q.resourceId ?? "");
            return this.envelope(q.queryType, this.stream.compare(actor, jobId, compare.attemptIds ?? [], (compare as { limit?: number }).limit));
          }
        }
      }
      case "live.status": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        return this.envelope(q.queryType, liveStatus(s, actor, q.workspaceId));
      }
      case "artifacts.list": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const f = raw as { jobId?: string; runId?: string; workItemId?: string; state?: string; classification?: string };
        return this.envelope(q.queryType, listArtifacts(s, actor, q.workspaceId, f));
      }
      case "artifacts.history": {
        const h = raw as { artifactId?: string; digest?: string; resourceId?: string };
        const ref = (h.artifactId ?? h.resourceId) ? { artifactId: String(h.artifactId ?? h.resourceId) } : h.digest ? { digest: h.digest } : {};
        return this.envelope(q.queryType, artifactHistory(s, actor, ref));
      }
      case "artifacts.diff": {
        const d = raw as { leftId?: string; rightId?: string; maxBytes?: number };
        if (!d.leftId || !d.rightId) throw new BrainDomainError("INVALID_ARGUMENT", "leftId and rightId required");
        return this.envelope(q.queryType, diffArtifacts(s, actor, d.leftId, d.rightId, Number(d.maxBytes ?? 262_144)));
      }
      case "agents.list": case "workflows.list": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        return this.envelope(q.queryType, releaseDefinitions(s, actor.organizationId, q.queryType.startsWith("agents.") ? "agents" : "workflows"));
      }
      case "agents.get": case "workflows.get": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        return this.envelope(q.queryType, releaseDefinitions(s, actor.organizationId, q.queryType.startsWith("agents.") ? "agents" : "workflows", String(q.resourceId)));
      }
      case "config.explain": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        return this.envelope(q.queryType, configExplain(s, actor.organizationId, String((raw as { pointer?: string }).pointer ?? "")));
      }
      default:
        throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `query ${q.queryType} not implemented`);
    }
  }

  private streamFiltersOf(raw: unknown): StreamFilters {
    const q = raw as { workspaceId?: string; sessionId?: string; jobId?: string; runId?: string; attemptId?: string; emitters?: unknown; severities?: unknown; after?: unknown; before?: unknown };
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 8) : undefined;
    const emitters = strings(q.emitters);
    const severities = strings(q.severities);
    return {
      ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      ...(q.jobId ? { jobId: q.jobId } : {}),
      ...(q.runId ? { runId: q.runId } : {}),
      ...(q.attemptId ? { attemptId: q.attemptId } : {}),
      ...(emitters ? { emitters } : {}),
      ...(severities ? { severities } : {}),
      ...(typeof q.after === "number" && Number.isFinite(q.after) && q.after > 0 ? { after: Math.floor(q.after) } : {}),
      // stream.search pages descending: `before` (the previous page's
      // nextCursor) is the exclusive upper bound of the next, older page.
      ...(typeof q.before === "number" && Number.isFinite(q.before) && q.before > 0 ? { before: Math.floor(q.before) } : {}),
    };
  }

  // --- outbox projector + events feed ---
  projectOutbox(): number {
    const s = this.store;
    let done = 0;
    const due = s.control.prepare("SELECT event_id, destination FROM outbox_deliveries WHERE state IN ('pending','processing') AND next_attempt_at_ms<=? LIMIT 100").all(s.now()) as Array<{ event_id: string; destination: string }>;
    for (const d of due) {
      const ev = s.control.prepare("SELECT organization_id, workspace_id, aggregate_id, event_type, payload_json, payload_digest, cursor FROM events WHERE event_id=?").get(d.event_id) as Record<string, unknown> | undefined;
      if (!ev) continue;
      if (d.destination.startsWith("workspace:") && ev["workspace_id"]) {
        const ws = s.workspaceDb(String(ev["workspace_id"]), String(ev["organization_id"]));
        const prior = ws.prepare("SELECT payload_digest FROM inbox WHERE source_id='control' AND event_id=?").get(d.event_id) as { payload_digest: string } | undefined;
        if (prior && prior.payload_digest !== String(ev["payload_digest"])) {
          s.control.prepare("UPDATE outbox_deliveries SET state='parked', last_error='digest collision' WHERE event_id=? AND destination=?").run(d.event_id, d.destination);
          continue;
        }
        if (!prior) {
          ws.prepare("INSERT INTO inbox(source_id, event_id, payload_digest, applied_at_ms) VALUES ('control',?,?,?)").run(d.event_id, String(ev["payload_digest"]), s.now());
          if (String(ev["event_type"]).startsWith("job.")) {
            const job = s.control.prepare("SELECT state, version, queue_reason FROM jobs WHERE id=?").get(String(ev["aggregate_id"])) as { state: string; version: number; queue_reason: string | null } | undefined;
            if (job) ws.prepare("INSERT INTO job_projection(job_id, source_version, source_cursor, state, queue_reason, updated_at_ms) VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET source_version=excluded.source_version, source_cursor=excluded.source_cursor, state=excluded.state, queue_reason=excluded.queue_reason, updated_at_ms=excluded.updated_at_ms")
              .run(String(ev["aggregate_id"]), job.version, Number(ev["cursor"]), job.state, job.queue_reason, s.now());
          }
        }
      }
      s.control.prepare("UPDATE outbox_deliveries SET state='delivered', delivered_at_ms=? WHERE event_id=? AND destination=?").run(s.now(), d.event_id, d.destination);
      done++;
    }
    for (const workspace of s.control.prepare("SELECT id,organization_id FROM workspaces WHERE status='active' ORDER BY id LIMIT 100").all() as Array<{id:string;organization_id:string}>) {
      const ws=s.workspaceDb(workspace.id,workspace.organization_id);
      for (const pending of ws.prepare("SELECT id FROM verification_verdicts WHERE finalized_at_ms IS NULL ORDER BY created_at_ms,id LIMIT 100").all() as Array<{id:string}>) {
        this.evidence.finalize(workspace.organization_id,workspace.id,pending.id);
        done++;
      }
      // A workspace evidence commit can precede evaluator job admission. Retry
      // the same execution key after a crash rather than create a second job.
      for (const run of ws.prepare("SELECT DISTINCT r.id FROM workflow_runs r JOIN evidence_bundles b ON json_extract(b.manifest_json,'$.workflowRunId')=r.id WHERE r.state IN ('running','suspended') AND b.state='submitted' ORDER BY r.id LIMIT 100").all() as Array<{id:string}>) {
        this.workflows.evidenceSubmitted(workspace.organization_id,workspace.id,run.id);
      }
    }
    return done;
  }

  /**
   * Stream-backed event frames: the SSE source is the projected execution
   * stream with the global stream_seq cursor; scoping happens in SQL before
   * the page limit (organization rows plus member workspaces).
   */
  listEvents(actor: ActorContext, afterCursor: number, filters: StreamFilters = {}, limit = 100): Array<Record<string, JsonValue>> {
    this.stream.project();
    const after = afterCursor > 0 ? { after: Math.floor(afterCursor) } : {};
    const page = this.stream.read(actor, { ...filters, ...after }, limit);
    return page.items.map((record) => frameOf(record));
  }

  health(): { ready: boolean; detail: string } {
    try {
      this.store.control.prepare("SELECT 1").get();
      return { ready: true, detail: "control.db reachable" };
    } catch {
      return { ready: false, detail: "control.db unavailable" };
    }
  }

  async searchMemoryAsync(actor: ActorContext, workspaceId: string, mq: import("@brain/contracts").MemoryQuery): Promise<import("@brain/contracts").JsonValue> {
    requireWorkspaceRead(this.store, actor, workspaceId);
    const client = TencentDbClient.fromEnv();
    if (client) {
      try {
        const results = await client.search(mq, actor.actorId);
        // Brain re-checks tenant separation after vendor filtering.
        const scoped = results.filter((r) => r.scope.organizationId === actor.organizationId);
        return this.envelope("memory.search", { results: scoped, degraded: false } as unknown as import("@brain/contracts").JsonValue);
      } catch {
        throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "TencentDB memory search failed; the managed runtime does not fall back to local memory", { retryable: true });
      }
    }
    const found = this.memory.search(mq, { organizationId: actor.organizationId, workspaceId });
    return this.envelope("memory.search", { ...found, degraded: true, reason: "TencentDB not configured; local scoped store used" } as unknown as import("@brain/contracts").JsonValue);
  }
}
