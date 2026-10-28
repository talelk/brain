import { readRuntimeConfig, type RuntimeConfig } from "../runtime-config";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionSubject, ActorContext, CommandEnvelope, CommandReceipt, HumanApprovalDecision, JsonValue,
} from "@brain/contracts";
import { approvalSubjectDigest, domainDigest, isKnownQuery, sha256Digest } from "@brain/contracts";
import { payloadValidator, validate } from "@brain/contracts/validate";
import { BrainDomainError } from "../domain/errors";
import { assertExpectedVersion, assertTransition } from "../domain/states";
import { evaluateRunner, rankRunners, type RunnerView } from "../domain/placement";
import { iso } from "../domain/clock";
import { Store, type BrainOptions } from "./store";
import { authorizeCommand, hasWorkspaceMembership, resolveActor, requireWorkspaceRead, scopesForPrincipal, type ResolvedActor } from "./authz";
import { compileRelease, type AgentInstruction, type SourceDoc, type ToolScript } from "../modules/configuration/index";
import { MastraWorkflowEngine, type WorkflowEnginePort } from "../modules/workflows/index";
import { MemoryStore, TencentDbClient } from "../modules/knowledge/index";
import { StepUpService } from "../modules/governance/index";
import { createBrainAuth, bootstrapIdentity, assertHumanIdentity, type BootstrapResult, type BrainAuth } from "../modules/identity/index";
import { quarantineRestoredAuthority, loadOrCreateVapidKeys, sendPush, encryptSubscription, decryptSubscription, type VapidKeys } from "../modules/operations/index";
import { EvidenceService } from "../modules/evidence/index";
import { readReleaseAgentInstructions, readReleaseToolScript } from "../modules/configuration/index";
import { acceptAttemptArtifact } from "../modules/evidence/index";
import {
  ackAttempt as jobsAckAttempt, attemptEvents as jobsAttemptEvents, authRunner, claim as jobsClaim,
  completeAttempt as jobsCompleteAttempt, enrollRunner, expireLeases as jobsExpireLeases, heartbeat,
  issueEnrollment, readExecutionArtifact as jobsReadExecutionArtifact, releaseAttempt as jobsReleaseAttempt,
  releaseReservation as jobsReleaseReservation, renewAttempt as jobsRenewAttempt, runnerChallenge,
  runScheduledDispatch,
  runnerHello, runnerView as jobsRunnerView,
} from "../modules/jobs/index";
import { issuePermit as governanceIssuePermit, validatePermit as governanceValidatePermit } from "../modules/governance/index";
import { revokeTrustDomain, verifyTrustDomain as governanceVerifyTrustDomain } from "../modules/governance/index";
// releaseReservation is used by reconcileJob above via the jobs module index.

export class Brain {
  readonly runtime: RuntimeConfig;
  readonly store: Store;
  readonly workflows: WorkflowEnginePort;
  readonly memory: MemoryStore;
  readonly auth: BrainAuth;
  readonly stepUp: StepUpService;
  readonly evidence: EvidenceService;

  constructor(opts: BrainOptions & { runtime?: RuntimeConfig }) {
    this.runtime = opts.runtime ?? readRuntimeConfig();
    this.store = new Store(opts);
    try {
      const authSecret = process.env["BRAIN_AUTH_SECRET"] ?? Buffer.from(this.store.pepper).toString("hex");
      this.auth = createBrainAuth(this.store.control, { secret: authSecret, baseURL: process.env["BRAIN_BASE_URL"] ?? "http://127.0.0.1:3000", requireTwoFactor: this.runtime.requireTwoFactor });
      this.auth.ensureTables();
      this.stepUp = new StepUpService(this.store, this.auth);
      this.memory = new MemoryStore(this.store);
      this.workflows = new MastraWorkflowEngine(this.store, this, join(this.store.dataDir, "mastra"));
      this.evidence = new EvidenceService(this.store, this.workflows);
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
    fetch(url, { signal: AbortSignal.timeout(1500) })
      .then(() => { this.memoryProbe = { status: "healthy", detail: "memory service reachable; local scoped store active (cross-service memory gate G04 not yet claimed)", checkedAt }; })
      .catch(() => { this.memoryProbe = { status: "unavailable", detail: `memory service unreachable at ${url}; local scoped store active`, checkedAt }; });
  }

  // --- bootstrap / directory ---
  bootstrap(raw: unknown, setupCredential: string): Promise<BootstrapResult> {
    return bootstrapIdentity(this.store, this.auth, raw, setupCredential);
  }

  resolveActor(headers: Headers, workspaceId?: string): Promise<ResolvedActor> {
    return resolveActor(this.store, this.auth, headers, workspaceId);
  }

  createWorkspace(actor: ActorContext, input: { workspaceId: string; slug: string }): void {
    const s = this.store;
    if (!actor.scopes.includes("config:activate") && !actor.scopes.includes("workspace:import")) {
      // Bootstrap owner path: organization-admin creates workspaces.
      throw new BrainDomainError("FORBIDDEN", "workspace creation requires organization administration");
    }
    s.inTx(s.control, () => {
      s.control.prepare("INSERT INTO workspaces(id, organization_id, slug, status) VALUES (?,?,?, 'active')")
        .run(input.workspaceId, actor.organizationId, input.slug);
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
    this.requireConfigurationAdmin(actor);
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
      s.control.prepare("INSERT OR IGNORE INTO config_releases(digest, organization_id, source_revision, compiler_digest, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?)")
        .run(compiled.digest, actor.organizationId, sourceRevision, compilerDigest, JSON.stringify({ manifest: compiled.manifest, workflows: compiled.workflows, agents: compiled.agents, evaluators: compiled.evaluators, schemas: compiled.schemas }), s.now());
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

  inspectRelease(actor: ActorContext, digest: string): JsonValue {
    this.requireConfigurationAdmin(actor);
    const row = this.store.control.prepare("SELECT digest,source_revision,manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(digest, actor.organizationId) as { digest: string; source_revision: string; manifest_json: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "config release not found");
    const active = this.activeRelease(actor.organizationId);
    return { digest: row.digest, sourceRevision: row.source_revision, expectedActiveDigest: active?.digest ?? null, ...JSON.parse(row.manifest_json) } as JsonValue;
  }

  activateRelease(actor: ActorContext, digest: string, expectedActiveDigest?: string | null): void {
    this.requireConfigurationAdmin(actor);
    const s = this.store;
    s.inTx(s.control, () => {
      const rel = s.control.prepare("SELECT digest FROM config_releases WHERE digest=? AND organization_id=?").get(digest, actor.organizationId);
      if (!rel) throw new BrainDomainError("NOT_FOUND", "config release not found");
      const cur = s.control.prepare("SELECT release_digest, version FROM active_config WHERE organization_id=?").get(actor.organizationId) as
        | { release_digest: string; version: number } | undefined;
      if (expectedActiveDigest !== undefined && (cur?.release_digest ?? null) !== expectedActiveDigest) {
        throw new BrainDomainError("CONFLICT", "active config changed; CAS failed");
      }
      if (cur) s.control.prepare("UPDATE active_config SET release_digest=?, version=version+1 WHERE organization_id=?").run(digest, actor.organizationId);
      else s.control.prepare("INSERT INTO active_config(organization_id, release_digest, version) VALUES (?,?,1)").run(actor.organizationId, digest);
      s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "config", aggregateId: digest, eventType: "config.activated", payload: { digest } });
    });
  }

  activeRelease(organizationId: string): { digest: string; manifest: string } | undefined {
    const row = this.store.control.prepare(`SELECT r.digest AS digest, r.manifest_json AS manifest FROM active_config a JOIN config_releases r ON r.digest=a.release_digest WHERE a.organization_id=?`)
      .get(organizationId) as { digest: string; manifest: string } | undefined;
    return row;
  }

  private requireConfigurationAdmin(actor: ActorContext): void {
    if (actor.kind !== "human" || !scopesForPrincipal(this.store, actor.actorId, actor.organizationId).includes("config:activate")) {
      throw new BrainDomainError("FORBIDDEN", "configuration changes require current organization administration");
    }
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
    ws.prepare("CREATE TABLE IF NOT EXISTS session_controls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT").run();
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
      s.control.exec("CREATE TABLE IF NOT EXISTS job_payloads(job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT");
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

  // --- command bus ---
  executeCommand(actor: ActorContext, raw: unknown, correlationId: string): { receipt: CommandReceipt; status: number } {
    const s = this.store;
    const check = validate("CommandEnvelope", raw);
    if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", `command invalid: ${check.errors.join("; ")}`);
    const cmd = raw as CommandEnvelope & { workspaceId?: string; payload: Record<string, unknown> };
    authorizeCommand(actor, cmd.commandType);
    const workspaceId = (cmd as { workspaceId?: string }).workspaceId;
    if (workspaceId) requireWorkspaceRead(s, actor, workspaceId);
    if (workspaceId && cmd.commandType === "workflow.dispatch") s.assertWorkspaceActive(workspaceId, actor.organizationId);
    if (cmd.commandType === "workflow.dispatch") {
      const p = cmd.payload as { workflow: { id: string }; input: JsonValue };
      const { workflow, configDigest } = this.workflowFromRelease(actor.organizationId, p.workflow.id);
      const release = s.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(configDigest, actor.organizationId) as { manifest_json: string };
      const schema = (JSON.parse(release.manifest_json) as { schemas?: Record<string, object> }).schemas?.[workflow.spec.inputSchemaRef];
      if (schema) {
        const result = payloadValidator(schema)(p.input);
        if (!result.ok) throw new BrainDomainError("INVALID_ARGUMENT", result.errors.join("; "));
      }
    }
    const requestDigest = domainDigest("brain:command:v1", raw as JsonValue);
    let receipt: CommandReceipt | undefined;
    let replayed = false;
    s.inTx(s.control, () => {
      const prior = s.control.prepare("SELECT request_digest, receipt_json FROM command_idempotency WHERE organization_id=? AND actor_id=? AND command_type=? AND idempotency_key=?")
        .get(actor.organizationId, actor.actorId, cmd.commandType, cmd.idempotencyKey) as { request_digest: string; receipt_json: string } | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "same idempotency key with different payload");
        receipt = JSON.parse(prior.receipt_json) as CommandReceipt;
        replayed = true;
        return;
      }
      const resourceId = this.applyCommand(actor, cmd);
      receipt = { commandId: cmd.commandId, accepted: true, outcome: workspaceId ? "queued" : "applied", ...(resourceId ? { resourceId } : {}) };
      s.control.prepare("INSERT INTO command_intents(command_id, workspace_id, request_json, state, created_at_ms) VALUES (?,?,?,?,?)")
        .run(cmd.commandId, workspaceId ?? null, JSON.stringify(raw), "applied", s.now());
      s.control.prepare("INSERT INTO command_idempotency(organization_id, actor_id, command_type, idempotency_key, request_digest, command_id, receipt_json, created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(actor.organizationId, actor.actorId, cmd.commandType, cmd.idempotencyKey, requestDigest, cmd.commandId, JSON.stringify(receipt), s.now());
      void correlationId;
    });
    if (!receipt) throw new BrainDomainError("INTERNAL_ERROR", "command produced no receipt");
    // Workspace effects that must happen outside the control transaction.
    if (!replayed) this.postApply(actor, cmd, receipt);
    return { receipt, status: receipt.outcome === "queued" ? 202 : 200 };
  }

  private applyCommand(actor: ActorContext, cmd: CommandEnvelope & { payload: Record<string, unknown> }): string | undefined {
    const s = this.store;
    const p = cmd.payload;
    const wsId = (cmd as { workspaceId?: string }).workspaceId;
    switch (cmd.commandType) {
      case "config.activate": {
        this.activateRelease(actor, String(p["configDigest"]), p["expectedActiveDigest"] === null ? null : String(p["expectedActiveDigest"]));
        return String(p["configDigest"]);
      }
      case "approval.request": {
        if (!wsId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const subject = p["subject"] as unknown as ActionSubject;
        if (subject.organizationId !== actor.organizationId || subject.workspaceId !== wsId) throw new BrainDomainError("FORBIDDEN", "subject scope mismatch");
        const digest = approvalSubjectDigest(subject as unknown as JsonValue);
        // E083: one live request per exact subject signature — a repeated
        // request for the identical subject returns the existing approval
        // instead of minting a duplicate reviewers must re-triage.
        const existing = s.control.prepare("SELECT id FROM approval_requests WHERE organization_id=? AND workspace_id=? AND subject_digest=? AND state='pending' ORDER BY created_at_ms ASC LIMIT 1")
          .get(actor.organizationId, wsId, digest) as { id: string } | undefined;
        if (existing) return existing.id;
        const id = s.id("apr");
        s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms) VALUES (?,?,?,?,?,?,'pending',?,?)`)
          .run(id, actor.organizationId, wsId, actor.actorId, digest, JSON.stringify(subject), Date.parse(subject.expiresAt) || (s.now() + 3600_000), s.now());
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId: wsId, aggregateType: "approval", aggregateId: id, eventType: "approval.requested", payload: { approvalId: id, subjectDigest: digest } });
        return id;
      }
      case "approval.revoke": {
        const row = s.control.prepare("SELECT state, version FROM approval_requests WHERE id=? AND organization_id=?").get(String(p["approvalId"]), actor.organizationId) as { state: string; version: number } | undefined;
        if (!row) throw new BrainDomainError("NOT_FOUND", "approval not found");
        if (row.state !== "pending" && row.state !== "approved") throw new BrainDomainError("CONFLICT", "approval cannot be revoked now");
        s.control.prepare("UPDATE approval_requests SET state='revoked', version=version+1 WHERE id=?").run(String(p["approvalId"]));
        s.control.prepare("UPDATE effect_permits SET state='revoked' WHERE approval_id=? AND state='issued'").run(String(p["approvalId"]));
        return String(p["approvalId"]);
      }
      case "runner.drain": case "runner.quarantine": {
        const next = cmd.commandType === "runner.drain" ? "draining" : "quarantined";
        const changed = s.control.prepare("UPDATE runners SET admin_state=? WHERE id=? AND organization_id=?").run(next, String(p["runnerId"]), actor.organizationId);
        if (changed.changes === 0) throw new BrainDomainError("NOT_FOUND", "runner not found");
        if (next === "quarantined") {
          s.control.prepare("UPDATE runner_sessions SET revoked_at_ms=? WHERE runner_id=? AND revoked_at_ms IS NULL").run(s.now(), String(p["runnerId"]));
          s.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1 WHERE id=?").run(actor.organizationId);
        }
        return String(p["runnerId"]);
      }
      case "member.grant": case "member.revoke": {
        if (!wsId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const principalId = String(p["principalId"]); const role = String(p["role"]);
        this.ensurePrincipal(actor.organizationId, principalId, "human");
        const wsRow = s.control.prepare("SELECT version FROM workspaces WHERE id=? AND organization_id=?").get(wsId, actor.organizationId) as { version: number } | undefined;
        if (!wsRow) throw new BrainDomainError("NOT_FOUND", "workspace not found");
        assertExpectedVersion(wsRow.version, (cmd as { expectedVersion?: number }).expectedVersion);
        if (cmd.commandType === "member.grant") {
          s.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,?,1,?,?) ON CONFLICT(workspace_id,principal_id,role) DO UPDATE SET revoked_at_ms=NULL, version=workspace_memberships.version+1")
            .run(wsId, actor.organizationId, principalId, role, actor.actorId, s.now());
        } else {
          s.control.prepare("UPDATE workspace_memberships SET revoked_at_ms=?, version=version+1 WHERE workspace_id=? AND principal_id=? AND role=?").run(s.now(), wsId, principalId, role);
        }
        s.control.prepare("UPDATE workspaces SET version=version+1 WHERE id=?").run(wsId);
        s.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1 WHERE id=?").run(actor.organizationId);
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId: wsId, aggregateType: "membership", aggregateId: principalId, eventType: cmd.commandType === "member.grant" ? "membership.granted" : "membership.revoked", payload: { principalId, role } });
        return principalId;
      }
      case "workspace.suspend": {
        if (!wsId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        s.control.prepare("UPDATE workspaces SET status='suspended', version=version+1 WHERE id=? AND organization_id=?").run(wsId, actor.organizationId);
        return wsId;
      }
      case "job.reconcile": {
        const job = s.control.prepare("SELECT state, version FROM jobs WHERE id=? AND organization_id=?").get(String(p["jobId"]), actor.organizationId) as { state: string; version: number } | undefined;
        if (!job) throw new BrainDomainError("NOT_FOUND", "job not found");
        if (job.state !== "outcome_unknown") throw new BrainDomainError("CONFLICT", "only outcome_unknown jobs can be reconciled");
        assertExpectedVersion(job.version, (cmd as { expectedVersion?: number }).expectedVersion);
        const id = s.id("rec");
        s.control.prepare("INSERT INTO reconciliation_requests(id, job_id, command_id, expected_version, state, next_observation_at_ms, created_at_ms) VALUES (?,?,?,?, 'pending', ?,?)")
          .run(id, String(p["jobId"]), cmd.commandId, (cmd as { expectedVersion?: number }).expectedVersion ?? job.version, s.now(), s.now());
        return id;
      }
      case "workflow.dispatch": case "workflow.cancel": case "board.create": case "board.move": case "board.comment":
      case "decision.record": case "session.steer": case "session.stop": case "tool.propose": case "tool.publish":
      case "memory.publish": case "memory.revoke": case "workspace.export": case "workspace.import": {
        // Applied in postApply (workspace DB / workflow start) to keep control tx short.
        return undefined;
      }
      default:
        throw new BrainDomainError("INVALID_CONTRACT", `unhandled command ${(cmd as { commandType: string }).commandType}`);
    }
  }

  private postApply(actor: ActorContext, cmd: CommandEnvelope & { payload: Record<string, unknown> }, receipt: CommandReceipt): void {
    const s = this.store;
    const p = cmd.payload;
    const wsId = (cmd as { workspaceId?: string }).workspaceId;
    const setResource = (id: string) => {
      (receipt as { resourceId?: string }).resourceId = id;
      s.control.prepare("UPDATE command_idempotency SET receipt_json=? WHERE organization_id=? AND actor_id=? AND command_type=? AND idempotency_key=?")
        .run(JSON.stringify(receipt), actor.organizationId, actor.actorId, cmd.commandType, cmd.idempotencyKey);
    };
    switch (cmd.commandType) {
      case "workflow.dispatch": {
        if (!wsId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const wfRef = p["workflow"] as { id: string };
        const { workflow, configDigest } = this.workflowFromRelease(actor.organizationId, wfRef.id);
        const { runId } = this.workflows.startRun({
          organizationId: actor.organizationId, workspaceId: wsId, actorId: actor.actorId,
          workflowId: wfRef.id, workflow, configDigest,
          runInput: (p["input"] ?? null) as JsonValue, executionKey: cmd.commandId,
        });
        // The receipt names the created aggregate: the run. The /jobs/:id
        // route resolves a run id to the run's current job, so the dispatch
        // deep link opens the work right away and follows it across steps.
        setResource(runId);
        break;
      }
      case "workflow.cancel": {
        if (!wsId) break;
        this.workflows.cancelRun(actor.organizationId, wsId, String(p["runId"]));
        s.control.prepare("UPDATE jobs SET state='cancelled', version=version+1 WHERE workflow_run_id=? AND state IN ('queued','offered')").run(String(p["runId"]));
        setResource(String(p["runId"]));
        break;
      }
      case "board.create": {
        if (!wsId) break;
        const ws = s.workspaceDb(wsId, actor.organizationId);
        const cardId = s.id("card");
        ws.prepare("INSERT INTO cards(id, title, state, criteria_json, created_at_ms) VALUES (?,?, 'todo', ?,?)")
          .run(cardId, String(p["title"]), JSON.stringify(p["criteria"] ?? []), s.now());
        setResource(cardId);
        break;
      }
      case "board.move": {
        if (!wsId) break;
        const ws = s.workspaceDb(wsId, actor.organizationId);
        const card = ws.prepare("SELECT state, version, evidence_digest, criteria_json FROM cards WHERE id=?").get(String(p["cardId"])) as { state: string; version: number; evidence_digest: string | null; criteria_json: string } | undefined;
        if (!card) throw new BrainDomainError("NOT_FOUND", "card not found");
        assertExpectedVersion(card.version, (cmd as { expectedVersion?: number }).expectedVersion);
        const next = String(p["status"]);
        // Explicit card↔evidence binding (T31/T37): Done requires naming a
        // verified bundle whose passed checks cover every card criterion.
        // Verdicts never attach to cards implicitly.
        const requestedDigest = p["evidenceDigest"] ? String(p["evidenceDigest"]) : undefined;
        const effectiveDigest = requestedDigest ?? card.evidence_digest ?? undefined;
        if (requestedDigest || next === "done") {
          if (!effectiveDigest) throw new BrainDomainError("EVIDENCE_MISSING", "Done requires verified evidence");
          const bundle = ws.prepare("SELECT state, manifest_json FROM evidence_bundles WHERE digest=?").get(effectiveDigest) as { state: string; manifest_json: string } | undefined;
          if (!bundle) throw new BrainDomainError("NOT_FOUND", "evidence bundle not found");
          if (bundle.state !== "verified") throw new BrainDomainError("EVIDENCE_MISSING", "evidence bundle is not verified");
          const verdict = ws.prepare("SELECT id FROM verification_verdicts WHERE bundle_digest=? AND outcome='verified' LIMIT 1").get(effectiveDigest);
          if (!verdict) throw new BrainDomainError("EVIDENCE_MISSING", "evidence bundle has no verified verdict");
          const manifest = JSON.parse(bundle.manifest_json) as { checks?: Array<{ criterionId: string; status: string }> };
          const passed = new Set((manifest.checks ?? []).filter((c) => c.status === "passed").map((c) => c.criterionId));
          const criteria = JSON.parse(card.criteria_json) as string[];
          const missing = criteria.filter((c) => !passed.has(c));
          if (missing.length > 0) throw new BrainDomainError("EVIDENCE_MISSING", `verified evidence does not cover criteria: ${missing.join(", ")}`);
        }
        ws.prepare("UPDATE cards SET state=?, evidence_digest=?, version=version+1 WHERE id=? AND version=?")
          .run(next, effectiveDigest ?? null, String(p["cardId"]), card.version);
        setResource(String(p["cardId"]));
        break;
      }
      case "board.comment": {
        if (!wsId) break;
        const ws = s.workspaceDb(wsId, actor.organizationId);
        if (!ws.prepare("SELECT 1 FROM cards WHERE id=?").get(String(p["cardId"]))) throw new BrainDomainError("NOT_FOUND", "card not found");
        const id = s.id("cmt");
        ws.prepare("INSERT INTO card_comments(id, card_id, actor_id, body, created_at_ms) VALUES (?,?,?,?,?)").run(id, String(p["cardId"]), actor.actorId, String(p["text"] ?? p["body"] ?? ""), s.now());
        setResource(id);
        break;
      }
      case "decision.record": {
        if (!wsId) break;
        const ws = s.workspaceDb(wsId, actor.organizationId);
        if (!ws.prepare("SELECT 1 FROM cards WHERE id=?").get(String(p["cardId"]))) throw new BrainDomainError("NOT_FOUND", "card not found");
        const id = s.id("dec");
        ws.prepare("INSERT INTO decisions(id, card_id, actor_id, decision, note, created_at_ms) VALUES (?,?,?,?,?,?)")
          .run(id, String(p["cardId"]), actor.actorId, String(p["decision"]), String(p["note"] ?? ""), s.now());
        setResource(id);
        break;
      }
      case "session.steer": case "session.stop": {
        // Live steer/stop requires a running harness session; record intent, runner applies on poll.
        if (!wsId) break;
        const ws = s.workspaceDb(wsId, actor.organizationId);
        // Steering a session that does not exist would silently queue forever;
        // refuse at intake so the sender sees the truth.
        if (!ws.prepare("SELECT 1 FROM sessions WHERE id=?").get(String(p["sessionId"]))) {
          throw new BrainDomainError("NOT_FOUND", `session ${String(p["sessionId"])} not found in this workspace`);
        }
        ws.prepare("CREATE TABLE IF NOT EXISTS session_controls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT").run();
        ws.prepare("INSERT INTO session_controls(id, session_id, kind, payload, created_at_ms) VALUES (?,?,?,?,?)")
          .run(s.id("ctl"), String(p["sessionId"]), cmd.commandType, JSON.stringify(p), s.now());
        setResource(String(p["sessionId"]));
        break;
      }
      case "tool.propose": {
        if (!wsId) break;
        const ws = s.workspaceDb(wsId, actor.organizationId);
        const pkg = p["package"] as { digest: string };
        const id = s.id("toolcand");
        ws.prepare("INSERT OR IGNORE INTO tool_candidates(id, signature, state, source_count, package_digest, created_at_ms) VALUES (?,?, 'quarantined', 3, ?,?)")
          .run(id, pkg.digest, pkg.digest, s.now());
        setResource(id);
        break;
      }
      case "tool.publish": {
        if (!actor.scopes.includes("tool:publish")) throw new BrainDomainError("FORBIDDEN", "tool publication requires tool publisher scope");
        const rel = p["release"] as { id: string; digest: string };
        s.control.exec("CREATE TABLE IF NOT EXISTS tool_releases(id TEXT PRIMARY KEY, digest TEXT NOT NULL, published_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT");
        s.control.prepare("INSERT OR REPLACE INTO tool_releases(id, digest, published_by, created_at_ms) VALUES (?,?,?,?)").run(rel.id, rel.digest, actor.actorId, s.now());
        setResource(rel.id);
        break;
      }
      case "memory.publish": {
        // Reviewed publication (T39): content is a digest-pinned CAS artifact,
        // backed by existing evidence artifacts, reviewed by a *different*
        // principal, under a redaction profile declared in the active release.
        const content = p["content"] as { artifactId: string; digest: string; bytes: number };
        const sourceWorkspaceId = String(p["sourceWorkspaceId"]);
        const reviewerId = String(p["reviewerId"]);
        if (reviewerId === actor.actorId) throw new BrainDomainError("FORBIDDEN", "memory reviewer must differ from the publisher");
        const reviewer = s.control.prepare("SELECT 1 FROM principals WHERE id=? AND organization_id=? AND disabled_at_ms IS NULL").get(reviewerId, actor.organizationId);
        if (!reviewer) throw new BrainDomainError("NOT_FOUND", "memory reviewer is not a principal in this organization");
        requireWorkspaceRead(s, actor, sourceWorkspaceId);
        const sourceWs = s.workspaceDb(sourceWorkspaceId, actor.organizationId);
        const contentRow = sourceWs.prepare("SELECT id, bytes FROM artifacts WHERE digest=?").get(content.digest) as { id: string; bytes: number } | undefined;
        if (!contentRow || contentRow.bytes !== content.bytes) throw new BrainDomainError("NOT_FOUND", "memory content artifact not found in source workspace");
        for (const evidenceDigest of (p["evidenceDigests"] as string[])) {
          if (!sourceWs.prepare("SELECT 1 FROM artifacts WHERE digest=?").get(evidenceDigest)) {
            throw new BrainDomainError("EVIDENCE_MISSING", `evidence artifact ${evidenceDigest} not found in source workspace`);
          }
        }
        const profile = p["redactionProfile"] as { id: string; digest: string };
        const rel = this.activeRelease(actor.organizationId);
        const relDocs = rel ? (((JSON.parse(rel.manifest) as { manifest?: { documents?: Array<Record<string, unknown>> } }).manifest?.documents) ?? []) : [];
        if (!relDocs.some((d) => d["id"] === profile.id && d["digest"] === profile.digest)) {
          throw new BrainDomainError("INVALID_CONTRACT", "redaction profile is not declared in the active release");
        }
        const casBytes = readFileSync(this.casPath(content.digest));
        if (sha256Digest(casBytes) !== content.digest) throw new BrainDomainError("CONFLICT", "memory content CAS digest mismatch");
        if (casBytes.length > 256 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "memory content exceeds 256 KiB");
        const scope = p["targetScope"] as { visibility: string; workspaceId?: string };
        const targetWorkspaceId = scope.visibility === "global-approved" ? null
          : scope.visibility === "workspace" ? String(scope.workspaceId)
          : (() => { throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `memory target scope ${scope.visibility} is not supported by the local store`); })();
        if (targetWorkspaceId) requireWorkspaceRead(s, actor, targetWorkspaceId);
        const id = this.memory.publish({
          organizationId: actor.organizationId, workspaceId: targetWorkspaceId,
          sourceId: String(p["candidateId"]), text: casBytes.toString("utf8"),
        });
        setResource(id);
        break;
      }
      case "memory.revoke": {
        this.memory.revoke(String(p["sourceId"]));
        setResource(String(p["sourceId"]));
        break;
      }
      case "workspace.export": case "workspace.import": {
        // Full bundle logic lives in operations backup; record an intent resource.
        setResource(wsId ?? actor.organizationId);
        break;
      }
      default: break;
    }
  }

  // --- approvals + step-up ---
  decideApproval(identity: ResolvedActor, approvalId: string, body: HumanApprovalDecision): { decisionId: string; state: string } {
    const s = this.store;
    assertHumanIdentity(this.store, this.auth, identity);
    const { actor: actorIn, sessionDigest } = identity;
    const wsRow = s.control.prepare("SELECT workspace_id FROM approval_requests WHERE id=? AND organization_id=?").get(approvalId, actorIn.organizationId) as { workspace_id: string } | undefined;
    if (!wsRow) throw new BrainDomainError("NOT_FOUND", "approval not found");
    const actor: ActorContext = { ...actorIn, workspaceId: wsRow.workspace_id, scopes: scopesForPrincipal(s, actorIn.actorId, actorIn.organizationId, wsRow.workspace_id) };
    if (!actor.scopes.includes("approval:decide")) throw new BrainDomainError("FORBIDDEN", "missing approval:decide scope");
    const check = validate("HumanApprovalDecision", body);
    if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", check.errors.join("; "));
    const requestDigest = domainDigest("brain:approval-decision:v1", body as unknown as JsonValue);
    let decisionId = "";
    let newState = "";
    let workspaceId = "";
    s.inTx(s.control, () => {
      const prior = s.control.prepare("SELECT request_digest, receipt_json FROM command_idempotency WHERE organization_id=? AND actor_id=? AND command_type='approval.decision' AND idempotency_key=?")
        .get(actor.organizationId, actor.actorId, body.idempotencyKey) as { request_digest: string; receipt_json: string } | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "decision key reused with different payload");
        const saved = JSON.parse(prior.receipt_json) as { decisionId: string; state: string };
        decisionId = saved.decisionId; newState = saved.state;
        const wr = s.control.prepare("SELECT workspace_id FROM approval_requests WHERE id=?").get(approvalId) as { workspace_id: string } | undefined;
        workspaceId = wr?.workspace_id ?? "";
        return;
      }
      const row = s.control.prepare("SELECT subject_digest, subject_json, state, version, expires_at_ms, workspace_id, requested_by FROM approval_requests WHERE id=? AND organization_id=?")
        .get(approvalId, actor.organizationId) as { subject_digest: string; subject_json: string; state: string; version: number; expires_at_ms: number; workspace_id: string; requested_by: string } | undefined;
      if (!row) throw new BrainDomainError("NOT_FOUND", "approval not found");
      workspaceId = row.workspace_id;
      if (!hasWorkspaceMembership(s, actor.actorId, actor.organizationId, row.workspace_id)) throw new BrainDomainError("NOT_FOUND", "approval not found");
      assertExpectedVersion(row.version, body.expectedVersion);
      if (row.subject_digest !== body.subjectDigest) throw new BrainDomainError("CONFLICT", "approval subject changed; refresh required");
      if (row.state === "pending" && row.expires_at_ms <= s.now()) {
        s.control.prepare("UPDATE approval_requests SET state='expired', version=version+1 WHERE id=?").run(approvalId);
        throw new BrainDomainError("APPROVAL_EXPIRED", "approval expired");
      }
      assertTransition("approval", row.state, body.decision === "approve" ? "approved" : "rejected");
      // Separation of duties: author cannot approve own high-risk request.
      const subject = JSON.parse(row.subject_json) as { operation?: string };
      if (body.decision === "approve" && row.requested_by === actor.actorId) {
        throw new BrainDomainError("FORBIDDEN", "separation of duties: requester cannot approve own action");
      }
      void subject;
      if (body.decision === "approve") {
        if (!body.stepUpEvidenceId) throw new BrainDomainError("APPROVAL_REQUIRED", "fresh step-up evidence required to approve");
        const ev = s.control.prepare("SELECT e.actor_id,e.auth_session_digest,e.subject_digest,e.expires_at_ms,e.decision_id,e.revoked_at_ms,e.auth_session_id,e.auth_user_id,e.factor_digest,e.auth_generation,e.method,c.approval_id FROM step_up_evidence e JOIN step_up_challenges c ON c.id=e.challenge_id WHERE e.id=?").get(body.stepUpEvidenceId) as
          | { actor_id: string; auth_session_digest: string; subject_digest: string; expires_at_ms: number; decision_id: string | null; revoked_at_ms: number | null; auth_session_id: string; auth_user_id: string; factor_digest: string | null; auth_generation: number; method: string; approval_id: string } | undefined;
        if (!ev || ev.approval_id !== approvalId || (this.auth.requireTwoFactor && ev.method !== "totp") || ev.revoked_at_ms || ev.expires_at_ms <= s.now() || ev.actor_id !== actor.actorId || ev.auth_session_digest !== sessionDigest || ev.subject_digest !== body.subjectDigest || ev.decision_id || ev.auth_generation !== actor.authGeneration || !this.auth.isSessionCurrent(ev.auth_user_id, ev.auth_session_id, s.now(), ev.factor_digest)) {
          throw new BrainDomainError("FORBIDDEN", "step-up evidence invalid, expired, or already used");
        }
      }
      decisionId = s.id("dec-human");
      newState = body.decision === "approve" ? "approved" : "rejected";
      s.control.prepare("INSERT INTO approval_decisions(id, approval_id, expected_version, actor_id, auth_evidence_ref, subject_digest, decision, note, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(decisionId, approvalId, body.expectedVersion, actor.actorId, body.stepUpEvidenceId ?? "session", body.subjectDigest, body.decision, body.note, s.now());
      if (body.stepUpEvidenceId) s.control.prepare("UPDATE step_up_evidence SET decision_id=? WHERE id=?").run(decisionId, body.stepUpEvidenceId);
      s.control.prepare("UPDATE approval_requests SET state=?, version=version+1 WHERE id=? AND version=?").run(newState, approvalId, body.expectedVersion);
      const receipt = { commandId: decisionId, accepted: true, outcome: "applied", resourceId: approvalId };
      s.control.prepare("INSERT INTO command_idempotency(organization_id, actor_id, command_type, idempotency_key, request_digest, command_id, receipt_json, created_at_ms) VALUES (?,?, 'approval.decision', ?,?,?,?,?)")
        .run(actor.organizationId, actor.actorId, body.idempotencyKey, requestDigest, decisionId, JSON.stringify({ ...receipt, decisionId, state: newState, subjectDigest: body.subjectDigest }), s.now());
      s.emit(s.control, { organizationId: actor.organizationId, workspaceId: row.workspace_id, aggregateType: "approval", aggregateId: approvalId, eventType: body.decision === "approve" ? "approval.approved" : "approval.rejected", payload: { approvalId, decisionId } });
    });
    if (workspaceId) this.workflows.wakeGate(actor.organizationId, workspaceId, approvalId, newState === "approved");
    return { decisionId, state: newState };
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

  // --- runner protocol (delegates to modules/jobs) ---
  issueEnrollment(actor: ActorContext, groupId: string): { token: string; expiresAt: string } {
    return issueEnrollment(this.store, actor, groupId);
  }

  enrollRunner(input: { token: string; publicKeyPem: string; runnerId: string }): { credential: string } {
    return enrollRunner(this.store, input);
  }

  runnerChallenge(runnerId: string, credential: string): { challengeId: string; nonce: string; expiresAt: string } {
    return runnerChallenge(this.store, runnerId, credential);
  }

  runnerHello(hello: Record<string, unknown>): { sessionToken: string; epoch: number; serverTime: string } {
    return runnerHello(this.store, hello);
  }

  authRunner(headers: Headers): { runnerId: string; epoch: number; organizationId: string } {
    return authRunner(this.store, headers);
  }

  heartbeat(runner: { runnerId: string; epoch: number }, body: Record<string, unknown>): { acceptedSequence: number } {
    return heartbeat(this.store, runner, body);
  }

  private runnerView(runnerId: string): RunnerView | undefined {
    return jobsRunnerView(this.store, runnerId);
  }

  claim(runner: { runnerId: string; epoch: number; organizationId: string }, requestId: string): JsonValue | null {
    return jobsClaim(this.store, { isEvaluatorEligible: (runnerId, jobId) => this.evidence.evaluatorEligible(runnerId, jobId) }, runner, requestId);
  }

  readExecutionArtifact(runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string): Uint8Array {
    return jobsReadExecutionArtifact(this.store, runner, attemptId);
  }

  ackAttempt(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return jobsAckAttempt(this.store, runner, attemptId, body);
  }

  renewAttempt(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return jobsRenewAttempt(this.store, runner, attemptId, body);
  }

  attemptEvents(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return jobsAttemptEvents(this.store, runner, attemptId, body);
  }

  issuePermit(runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return governanceIssuePermit(this.store, { auth: this.auth }, runner, attemptId, body);
  }

  validatePermit(token: string, invocationId: string): boolean {
    return governanceValidatePermit(this.store, { auth: this.auth }, token, invocationId);
  }

  completeAttempt(runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return jobsCompleteAttempt(this.store, { completeStep: (organizationId, workspaceId, runId, stepId, output, ok) => this.workflows.completeStep(organizationId, workspaceId, runId, stepId, output, ok) }, runner, attemptId, body);
  }

  releaseAttempt(runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>): JsonValue {
    return jobsReleaseAttempt(this.store, runner, attemptId, body);
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

  expireLeases(): number {
    return jobsExpireLeases(this.store);
  }

  // Declared Schedule documents in the active release, fired once per due
  // minute; the maintenance loop calls this alongside lease expiry.
  runScheduledDispatch(): { dispatched: number; skipped: number } {
    return runScheduledDispatch(this.store, {
      activeRelease: (organizationId) => this.activeRelease(organizationId),
      resolveWorkflow: (organizationId, workflowId) => this.workflowFromRelease(organizationId, workflowId),
      startRun: (input) => this.workflows.startRun(input as Parameters<WorkflowEnginePort["startRun"]>[0]),
    });
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
    const s = this.store;
    const row = s.control.prepare("SELECT workspace_id, digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(artifactId, actor.organizationId) as
      | { workspace_id: string; digest: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "artifact not found");
    requireWorkspaceRead(s, actor, row.workspace_id);
    const path = this.casPath(row.digest);
    if (!existsSync(path)) throw new BrainDomainError("EVIDENCE_MISSING", "artifact bytes missing");
    const bytes = readFileSync(path);
    if (sha256Digest(bytes) !== row.digest) throw new BrainDomainError("EVIDENCE_MISSING", "artifact bytes corrupted");
    return bytes;
  }

  // E090: CAS garbage collection. Referenced bytes (artifact associations)
  // and digests named by still-open uploads are always retained; only
  // unreferenced files older than the grace window are removed, so a sweep
  // racing a live upload or a backup can never take published evidence.
  casSweep(graceMs = 24 * 3600_000): { scanned: number; removed: number; retained: number } {
    const s = this.store;
    const referenced = new Set<string>();
    for (const r of s.control.prepare("SELECT digest FROM artifact_associations").all() as Array<{ digest: string }>) {
      referenced.add(r.digest.replace("sha256:", ""));
    }
    for (const r of s.control.prepare("SELECT expected_digest FROM artifact_uploads WHERE state='open' AND expires_at_ms>?").all(s.now()) as Array<{ expected_digest: string }>) {
      referenced.add(r.expected_digest.replace("sha256:", ""));
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
    return this.evidence.accept(runner,workspaceId,raw);
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
        s.control.prepare("UPDATE jobs SET state='verifying', version=version+1 WHERE id=? AND state='outcome_unknown'").run(input.jobId);
        s.control.prepare("UPDATE job_attempts SET state='verifying' WHERE job_id=? AND state='outcome_unknown'").run(input.jobId);
        s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE attempt_id IN (SELECT id FROM job_attempts WHERE job_id=?)").run(s.now(), input.jobId);
      } else if (input.outcome === "absent") {
        // The unknown attempt is terminally concluded (effect proven absent)
        // so the one-active-attempt index frees the job for a fresh attempt.
        const stale = s.control.prepare("SELECT id FROM job_attempts WHERE job_id=? AND state='outcome_unknown'").all(input.jobId) as Array<{ id: string }>;
        s.control.prepare("UPDATE jobs SET state='queued', version=version+1 WHERE id=? AND state='outcome_unknown'").run(input.jobId);
        s.control.prepare("UPDATE job_attempts SET state='failed' WHERE job_id=? AND state='outcome_unknown'").run(input.jobId);
        for (const a of stale) jobsReleaseReservation(this.store, a.id);
        s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE attempt_id IN (SELECT id FROM job_attempts WHERE job_id=?)").run(s.now(), input.jobId);
      }
      // conflicting/unknown: guard remains, job stays outcome_unknown
    });
    void workspaceId; void runId; void stepId;
    return { jobId: input.jobId, outcome: input.outcome } as unknown as JsonValue;
  }

  // Rule of Three (E076/E077): only *distinct* verified root operations
  // count toward a tool candidate — retries of one operation never do. The
  // third distinct observation creates exactly one quarantined candidate;
  // concurrent thirds race on the candidate signature primary key.
  recordToolObservation(input: {
    organizationId: string; workspaceId: string; signature: string;
    rootOperationId: string; packageDigest: string; verified: boolean;
  }): JsonValue {
    const s = this.store;
    const ws = s.workspaceDb(input.workspaceId, input.organizationId);
    let distinctRoots = 0;
    let candidateId: string | null = null;
    s.inTx(ws, () => {
      ws.prepare(`CREATE TABLE IF NOT EXISTS tool_observations(
        signature TEXT NOT NULL, root_operation_id TEXT NOT NULL, verified INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(signature, root_operation_id)) STRICT`).run();
      ws.prepare("INSERT OR IGNORE INTO tool_observations(signature, root_operation_id, verified, created_at_ms) VALUES (?,?,?,?)")
        .run(input.signature, input.rootOperationId, input.verified ? 1 : 0, s.now());
      const row = ws.prepare("SELECT COUNT(*) AS n FROM tool_observations WHERE signature=? AND verified=1").get(input.signature) as { n: number };
      distinctRoots = row.n;
      if (distinctRoots >= 3) {
        const existing = ws.prepare("SELECT id FROM tool_candidates WHERE signature=?").get(input.signature) as { id: string } | undefined;
        if (existing) {
          candidateId = existing.id;
          ws.prepare("UPDATE tool_candidates SET source_count=? WHERE signature=?").run(distinctRoots, input.signature);
        } else {
          candidateId = s.id("toolcand");
          ws.prepare("INSERT INTO tool_candidates(id, signature, state, source_count, package_digest, created_at_ms) VALUES (?,?, 'quarantined', ?,?,?)")
            .run(candidateId, input.signature, distinctRoots, input.packageDigest, s.now());
        }
      }
    });
    return { signature: input.signature, distinctVerifiedRoots: distinctRoots, candidateId } as unknown as JsonValue;
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
      ws.prepare(`CREATE TABLE IF NOT EXISTS source_observations(
        source_id TEXT NOT NULL, external_id TEXT NOT NULL, cursor TEXT NOT NULL,
        payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(source_id, external_id)) STRICT`).run();
      const prior = ws.prepare("SELECT payload_digest, state FROM source_observations WHERE source_id=? AND external_id=?")
        .get(input.sourceId, input.externalId) as { payload_digest: string; state: string } | undefined;
      if (prior) {
        if (prior.payload_digest === digest) { outcome = "duplicate"; return; }
        ws.prepare(`CREATE TABLE IF NOT EXISTS parked_observations(
          source_id TEXT NOT NULL, external_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
          payload_json TEXT NOT NULL, reason TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT`).run();
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
  private envelope(queryType: string, snapshot: JsonValue): JsonValue {
    const wm = this.store.control.prepare("SELECT COALESCE(MAX(cursor),0) AS m FROM events").get() as { m: number };
    return { queryType, snapshot, cursor: "", sourceWatermark: wm.m, asOf: this.store.nowIso(), projectionLagMs: 0 } as unknown as JsonValue;
  }

  private jobSnapshot(row: Record<string, unknown>): JsonValue {
    const attempts = this.store.control.prepare("SELECT id, runner_id, attempt_no, state, lease_expires_at_ms FROM job_attempts WHERE job_id=? ORDER BY attempt_no").all(String(row["id"])) as Array<Record<string, unknown>>;
    const ws = this.store.workspaceDb(String(row["workspace_id"]),String(row["organization_id"]));
    const runId = String(row["workflow_run_id"]);
    const hasOutputs = ws.prepare("SELECT 1 FROM sqlite_master WHERE name='step_outputs'").get();
    const outputs = hasOutputs ? ws.prepare("SELECT step_id,output_json FROM step_outputs WHERE run_id=?").all(runId) as {step_id:string;output_json:string}[] : [];
    const hasEvents = this.store.control.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_events'").get();
    const events = hasEvents ? this.store.control.prepare("SELECT e.event_json FROM attempt_events e JOIN job_attempts a ON a.id=e.attempt_id JOIN jobs j ON j.id=a.job_id WHERE j.organization_id=? AND j.workflow_run_id=? AND json_extract(e.event_json,'$.kind')='engine' ORDER BY j.created_at_ms DESC,e.seq DESC LIMIT 200").all(String(row["organization_id"]),runId) as {event_json:string}[] : [];
    const bundle = ws.prepare("SELECT digest FROM evidence_bundles WHERE json_extract(manifest_json,'$.workflowRunId')=? ORDER BY created_at_ms DESC LIMIT 1").get(runId) as {digest:string}|undefined;
    return {
      runOutputs: Object.fromEntries(outputs.map((entry) => [entry.step_id,JSON.parse(entry.output_json)])),
      engineEvents: events.reverse().map((entry) => (JSON.parse(entry.event_json) as {payload:JsonValue}).payload),
      ...(bundle ? { evidenceDigest: bundle.digest } : {}),
      jobId: String(row["id"]), organizationId: String(row["organization_id"]), workspaceId: String(row["workspace_id"]),
      workflowRunId: String(row["workflow_run_id"]), state: String(row["state"]), version: Number(row["version"]),
      queueReasons: ["queued","blocked"].includes(String(row["state"])) && row["queue_reason"] ? [String(row["queue_reason"])] : [],
      placement: JSON.parse(String(row["placement_json"])),
      attempts: attempts.map((a) => ({
        attemptId: String(a["id"]), number: Number(a["attempt_no"]), runnerId: String(a["runner_id"]), state: String(a["state"]),
        ...(a["lease_expires_at_ms"] != null ? { leaseExpiresAt: iso(Number(a["lease_expires_at_ms"])) } : {}),
      })),
      configDigest: String(row["config_digest"]), createdAt: iso(Number(row["created_at_ms"])),
    } as unknown as JsonValue;
  }

  /**
   * Resolve a /jobs/:id resource: a job id names one row, and a workflow run id
   * resolves to that run's current (newest) job — dispatch receipts name the
   * run, so a deep link opens the work and follows it across steps.
   */
  private jobRowFor(actor: ActorContext, resourceId: string): Record<string, unknown> | undefined {
    return this.store.control.prepare(
      "SELECT * FROM jobs WHERE organization_id=? AND (id=? OR workflow_run_id=?) ORDER BY created_at_ms DESC, id DESC LIMIT 1",
    ).get(actor.organizationId, resourceId, resourceId) as Record<string, unknown> | undefined;
  }

  executeQuery(actor: ActorContext, raw: unknown): JsonValue {
    const s = this.store;
    const check = validate("QueryRequest", raw);
    if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", check.errors.join("; "));
    const q = raw as { queryType: string; workspaceId?: string; resourceId?: string; limit?: number; commandId?: string };
    if (!isKnownQuery(q.queryType)) throw new BrainDomainError("INVALID_CONTRACT", `unknown query ${q.queryType}`);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const orgWorkspaces = (): string[] => (s.control.prepare(
      "SELECT workspace_id FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL",
    ).all(actor.organizationId, actor.actorId) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
    switch (q.queryType) {
      case "platform.health": {
        const pending = s.control.prepare("SELECT COUNT(*) AS c FROM outbox_deliveries WHERE state IN ('pending','processing')").get() as { c: number };
        const memory = this.memoryProbe;
        const services = [
          { id: "governor", status: "healthy", checkedAt: s.nowIso(), detail: "control.db reachable" },
          { id: "memory-local", status: memory.status, checkedAt: memory.checkedAt || s.nowIso(), detail: memory.detail },
        ];
        const status = services.some((svc) => svc.status === "unavailable") ? "degraded" : "healthy";
        return this.envelope(q.queryType, {
          status, services, pendingOutbox: pending.c, oldestOutboxAgeMs: 0, schemaVersion: "1",
        } as unknown as JsonValue);
      }
      case "workspace.context": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const wsRow = s.control.prepare("SELECT id, slug, status, version FROM workspaces WHERE id=?").get(q.workspaceId) as Record<string, unknown>;
        const rel = this.activeRelease(actor.organizationId);
        if (!rel) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "No active configuration release — stage and activate one in Settings to use this workspace.");
        const stored = JSON.parse(rel.manifest) as { manifest?: Record<string, unknown> };
        const m = stored.manifest ?? {};
        if (!m["irArtifact"] || !m["assets"] || !m["primitiveVersions"] || !m["compilerDigest"]) {
          throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "active release predates the current manifest shape; restage the release");
        }
        const relRow = s.control.prepare("SELECT source_revision, compiler_digest FROM config_releases WHERE digest=? AND organization_id=?").get(rel.digest, actor.organizationId) as { source_revision: string; compiler_digest: string };
        const jobCounts = s.control.prepare(`SELECT
          SUM(CASE WHEN state IN ('queued','leased','running','verifying') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN state='blocked' THEN 1 ELSE 0 END) AS blocked
          FROM jobs WHERE organization_id=? AND workspace_id=?`).get(actor.organizationId, q.workspaceId) as { active: number | null; blocked: number | null };
        const pendingApprovals = s.control.prepare("SELECT COUNT(*) AS c FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending'").get(actor.organizationId, q.workspaceId) as { c: number };
        const blockedJobs = jobCounts.blocked ?? 0;
        return this.envelope(q.queryType, {
          workspace: {
            workspaceId: q.workspaceId, displayName: String(wsRow["slug"]), status: String(wsRow["status"]),
            health: blockedJobs > 0 ? "degraded" : "healthy", observedAt: s.nowIso(),
            activeJobs: jobCounts.active ?? 0, pendingApprovals: pendingApprovals.c, blockedJobs, dailyMicroUsd: 0,
          },
          release: {
            releaseId: `rel-${rel.digest.slice(7, 23)}`, sourceRevision: relRow.source_revision,
            configDigest: rel.digest, compilerDigest: relRow.compiler_digest,
            irArtifact: m["irArtifact"], assets: m["assets"], primitiveVersions: m["primitiveVersions"],
          },
          allowedCommands: [...new Set(actor.scopes)],
          features: { web: "enabled", memory: "degraded", mastra: "enabled", tencentdb: process.env["BRAIN_TENCENTDB_URL"] ? "enabled" : "blocked" },
          ui: (() => {
            // Byte-bound to the release's declared BrainConfig document when
            // present; otherwise to the exact builtin defaults being served.
            const declared = (m["ui"] ?? null) as Record<string, unknown> | null;
            const docs = (m["documents"] ?? []) as Array<Record<string, unknown>>;
            const brainConfigDoc = docs.find((d) => d["kind"] === "BrainConfig");
            const defaults = { defaultTheme: "system", density: "compact", supportedLocales: ["en", "fr"], defaultLocale: "en", enabledChannels: ["web"] };
            const served = declared ? {
              defaultTheme: String(declared["defaultTheme"] ?? defaults.defaultTheme),
              density: String(declared["density"] ?? defaults.density),
              supportedLocales: (declared["supportedLocales"] as string[] | undefined) ?? defaults.supportedLocales,
              defaultLocale: String(declared["defaultLocale"] ?? defaults.defaultLocale),
              enabledChannels: (declared["enabledChannels"] as string[] | undefined) ?? defaults.enabledChannels,
            } : defaults;
            return {
              foundation: "newui",
              foundationManifestDigest: typeof declared?.["foundationManifestDigest"] === "string" ? String(declared["foundationManifestDigest"]) : brainConfigDoc ? String(brainConfigDoc["digest"]) : domainDigest("brain:ui-foundation:v1", served as unknown as JsonValue),
              ...served,
            };
          })(),
        } as unknown as JsonValue);
      }
      case "jobs.list": {
        const allowed = q.workspaceId ? [q.workspaceId] : orgWorkspaces();
        if (q.workspaceId) requireWorkspaceRead(s, actor, q.workspaceId);
        if (allowed.length === 0) return this.envelope(q.queryType, { items: [] } as unknown as JsonValue);
        const marks = allowed.map(() => "?").join(",");
        const rows = s.control.prepare(`SELECT * FROM jobs WHERE organization_id=? AND workspace_id IN (${marks}) ORDER BY created_at_ms DESC, id DESC LIMIT ?`)
          .all(actor.organizationId, ...allowed, limit) as Array<Record<string, unknown>>;
        return this.envelope(q.queryType, { items: rows.map((r) => this.jobSnapshot(r)) } as unknown as JsonValue);
      }
      case "job.get": {
        const row = this.jobRowFor(actor, String(q.resourceId));
        if (!row) throw new BrainDomainError("NOT_FOUND", "job or run not found");
        requireWorkspaceRead(s, actor, String(row["workspace_id"]));
        return this.envelope(q.queryType, this.jobSnapshot(row));
      }
      case "job.explain": {
        const row = this.jobRowFor(actor, String(q.resourceId));
        if (!row) throw new BrainDomainError("NOT_FOUND", "job or run not found");
        requireWorkspaceRead(s, actor, String(row["workspace_id"]));
        const placement = JSON.parse(String(row["placement_json"])) as import("@brain/contracts").Placement;
        const demand = placement.resources ?? { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 };
        const runners = (s.control.prepare("SELECT id FROM runners WHERE organization_id=?").all(actor.organizationId) as Array<{ id: string }>)
          .map((r) => this.runnerView(r.id)).filter((v): v is RunnerView => !!v)
          .sort(rankRunners)
          .map((v) => { const verdict = evaluateRunner(placement, demand, v, s.now()); return { runnerId: v.id, eligible: verdict.eligible, reasons: verdict.reasons }; });
        const anyEligible = runners.some((r) => r.eligible);
        // The primary reason derives from actual eligibility. A job that is
        // executing or verifying still reports the truth about the fleet: if no
        // runner is eligible right now, claiming READY would contradict the
        // eligibility table shown directly below it.
        const allOffline = runners.length > 0 && runners.every((r) => r.reasons.includes("runner-offline"));
        const primary = anyEligible ? "READY" : runners.length === 0 ? "WAITING_FOR_RUNNER" : allOffline ? "RUNNER_OFFLINE" : "INSUFFICIENT_CAPACITY";
        return this.envelope(q.queryType, {
          jobId: String(row["id"]), jobVersion: Number(row["version"]), evaluatedAt: s.nowIso(),
          primaryReason: primary, reasons: [primary], runners,
        } as unknown as JsonValue);
      }
      case "runners.list": case "runner.get": {
        const ids = q.queryType === "runner.get"
          ? [String(q.resourceId)]
          : (s.control.prepare("SELECT id FROM runners WHERE organization_id=? ORDER BY id LIMIT ?").all(actor.organizationId, limit) as Array<{ id: string }>).map((r) => r.id);
        const items = ids.map((id) => {
          const v = this.runnerView(id);
          if (!v) return null;
          const display = v.adminState === "disabled" ? "disabled" : v.adminState === "quarantined" ? "quarantined" : v.adminState === "draining" ? "draining" : !v.online ? "offline" : v.reserved.slots > 0 ? "busy" : "idle";
          return {
            runnerId: id, group: v.groupId, adminState: v.adminState, connectivity: v.online ? "online" : "offline",
            health: v.health, displayStatus: display, capacity: v.capacity,
            reserved: { cpuMillicores: v.reserved.cpuMillicores, memoryMb: v.reserved.memoryMb, diskMb: v.reserved.diskMb, slots: v.reserved.slots },
            observedFree: { cpuMillicores: Math.max(0, v.capacity.cpuMillicores - v.reserved.cpuMillicores), memoryMb: Math.max(0, v.capacity.memoryMb - v.reserved.memoryMb), diskMb: Math.max(0, v.capacity.diskMb - v.reserved.diskMb), slots: Math.max(0, v.capacity.slots - v.reserved.slots) },
            capabilities: [...v.capabilities.entries()].map(([capability, c]) => ({ capability, observedAt: s.nowIso(), source: "runner-probe", verified: c.verified, expiresAt: iso(c.expiresAtMs) })),
            engines: v.engines.map((e) => ({ id: e, version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: [] })),
            activeAttemptIds: [], lastSeenAt: s.nowIso(),
          };
        }).filter(Boolean);
        if (q.queryType === "runner.get") {
          if (items.length === 0) throw new BrainDomainError("NOT_FOUND", "runner not found");
          return this.envelope(q.queryType, items[0] as JsonValue);
        }
        return this.envelope(q.queryType, { items } as unknown as JsonValue);
      }
      case "approvals.list": case "approval.get": {
        const allowed = q.workspaceId ? [q.workspaceId] : orgWorkspaces();
        if (q.workspaceId) requireWorkspaceRead(s, actor, q.workspaceId);
        if (allowed.length === 0 && q.queryType === "approvals.list") return this.envelope(q.queryType, { items: [] } as unknown as JsonValue);
        const marks = allowed.map(() => "?").join(",");
        const rows = (q.queryType === "approval.get"
          ? s.control.prepare("SELECT * FROM approval_requests WHERE id=? AND organization_id=?").all(String(q.resourceId), actor.organizationId)
          : s.control.prepare(`SELECT * FROM approval_requests WHERE organization_id=? AND workspace_id IN (${marks}) ORDER BY expires_at_ms ASC LIMIT ?`).all(actor.organizationId, ...allowed, limit)) as Array<Record<string, unknown>>;
        const items = rows.map((r) => ({
          approvalId: String(r["id"]), organizationId: actor.organizationId, workspaceId: String(r["workspace_id"]),
          subject: JSON.parse(String(r["subject_json"])), subjectDigest: String(r["subject_digest"]),
          state: String(r["state"]), version: Number(r["version"]), requestedBy: String(r["requested_by"]),
          createdAt: iso(Number(r["created_at_ms"])), expiresAt: iso(Number(r["expires_at_ms"])),
        }));
        if (q.queryType === "approval.get") {
          if (items.length === 0 || !allowed.includes(String(rows[0]?.["workspace_id"]))) throw new BrainDomainError("NOT_FOUND", "approval not found");
          return this.envelope(q.queryType, items[0] as JsonValue);
        }
        return this.envelope(q.queryType, { items } as unknown as JsonValue);
      }
      case "board.get": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const ws = s.workspaceDb(q.workspaceId, actor.organizationId);
        const total = ws.prepare("SELECT COUNT(*) AS c FROM cards").get() as { c: number };
        const cards = ws.prepare("SELECT id, title, state, criteria_json, version, evidence_digest, created_at_ms FROM cards ORDER BY created_at_ms LIMIT 100").all() as Array<Record<string, unknown>>;
        return this.envelope(q.queryType, {
          workspaceId: q.workspaceId,
          totalCards: total.c,
          cards: cards.map((c) => {
            // Criterion status derives from the explicitly bound verified
            // bundle's manifest when present; otherwise it stays pending.
            let passed = new Set<string>();
            if (c["evidence_digest"]) {
              const bundle = ws.prepare("SELECT manifest_json, state FROM evidence_bundles WHERE digest=?").get(String(c["evidence_digest"])) as { manifest_json: string; state: string } | undefined;
              if (bundle?.state === "verified") {
                const manifest = JSON.parse(bundle.manifest_json) as { checks?: Array<{ criterionId: string; status: string }> };
                passed = new Set((manifest.checks ?? []).filter((x) => x.status === "passed").map((x) => x.criterionId));
              }
            }
            const criteria = JSON.parse(String(c["criteria_json"])) as string[];
            return {
              cardId: String(c["id"]), title: String(c["title"]), state: String(c["state"]),
              criteria: criteria.map((id) => ({ id, text: id, status: passed.has(id) ? "passed" : "pending" })),
              version: Number(c["version"]),
              ...(c["evidence_digest"] ? { evidenceDigest: String(c["evidence_digest"]) } : {}),
              updatedAt: iso(Number(c["created_at_ms"])),
            };
          }),
        } as unknown as JsonValue);
      }
      case "command.get": {
        const commandId = String((raw as { commandId?: string }).commandId ?? q.resourceId ?? "");
        const row = s.control.prepare("SELECT receipt_json FROM command_idempotency WHERE organization_id=? AND command_id=?").get(actor.organizationId, commandId) as { receipt_json: string } | undefined;
        const own = s.control.prepare("SELECT actor_id FROM command_idempotency WHERE organization_id=? AND command_id=?").get(actor.organizationId, commandId) as { actor_id: string } | undefined;
        if (!row || !own || own.actor_id !== actor.actorId) throw new BrainDomainError("NOT_FOUND", "command not found");
        return this.envelope(q.queryType, { commandId, receipt: JSON.parse(row.receipt_json), state: "applied" } as unknown as JsonValue);
      }
      case "memory.search": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const mq = (raw as { memoryQuery: import("@brain/contracts").MemoryQuery }).memoryQuery;
        const found = this.memory.search(mq, { organizationId: actor.organizationId, workspaceId: q.workspaceId });
        return this.envelope(q.queryType, found as unknown as JsonValue);
      }
      case "today": case "bridge": {
        const allowed = orgWorkspaces();
        const items: JsonValue[] = [];
        for (const wsId of allowed.slice(0, 25)) {
          const pending = s.control.prepare("SELECT id FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending' ORDER BY expires_at_ms LIMIT 5").all(actor.organizationId, wsId) as Array<{ id: string }>;
          for (const a of pending) {
            (items as unknown[]).push({ id: a.id, workspaceId: wsId, type: "approval", priority: 1, title: "Approval awaiting review", detail: a.id, resourceId: a.id, updatedAt: s.nowIso(), stale: false, nextAction: "review" });
          }
          const unknownJobs = s.control.prepare("SELECT id FROM jobs WHERE organization_id=? AND workspace_id=? AND state='outcome_unknown' LIMIT 5").all(actor.organizationId, wsId) as Array<{ id: string }>;
          for (const j of unknownJobs) {
            (items as unknown[]).push({ id: j.id, workspaceId: wsId, type: "job", priority: 1, title: "Outcome unknown — reconcile before retry", detail: j.id, resourceId: j.id, updatedAt: s.nowIso(), stale: false, nextAction: "reconcile" });
          }
        }
        if (q.queryType === "bridge") {
          // The contract's WorkspaceSummary: per-workspace counts the Bridge
          // screen renders, derived from the same rows workspace.context uses.
          const summaries = allowed.slice(0, 25).map((id) => {
            const wsRow = s.control.prepare("SELECT slug, status FROM workspaces WHERE id=? AND organization_id=?").get(id, actor.organizationId) as { slug: string; status: string } | undefined;
            const counts = s.control.prepare(`SELECT
              SUM(CASE WHEN state IN ('queued','leased','running','verifying') THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN state='blocked' THEN 1 ELSE 0 END) AS blocked
              FROM jobs WHERE organization_id=? AND workspace_id=?`).get(actor.organizationId, id) as { active: number | null; blocked: number | null };
            const pending = s.control.prepare("SELECT COUNT(*) AS c FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending'").get(actor.organizationId, id) as { c: number };
            const blocked = counts.blocked ?? 0;
            return {
              workspaceId: id, displayName: String(wsRow?.slug ?? id), status: String(wsRow?.status ?? "active"),
              health: blocked > 0 ? "degraded" : "healthy", observedAt: s.nowIso(),
              activeJobs: counts.active ?? 0, pendingApprovals: pending.c, blockedJobs: blocked, dailyMicroUsd: 0,
            };
          });
          return this.envelope(q.queryType, { items: summaries } as unknown as JsonValue);
        }
        return this.envelope(q.queryType, { items: items.slice(0, limit) } as unknown as JsonValue);
      }
      case "sessions.list": case "tickets.list": case "incidents.list": case "delivery.list": case "tools.list": case "decisions.list": case "members.list": case "audit.list": {
        if (q.workspaceId) requireWorkspaceRead(s, actor, q.workspaceId);
        return this.listPackQuery(actor, q.queryType, q.workspaceId);
      }
      case "session.get": case "ticket.get": case "incident.get": case "delivery.get": case "evidence.get": {
        return this.getPackQuery(actor, q.queryType, q.workspaceId, String(q.resourceId ?? ""));
      }
      case "sla.summary": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const ws = s.workspaceDb(q.workspaceId, actor.organizationId);
        const periodStart = Date.parse(String((raw as { periodStart?: string }).periodStart ?? "")) || 0;
        const periodEnd = Date.parse(String((raw as { periodEnd?: string }).periodEnd ?? "")) || s.now();
        const intervals = (ws.prepare("SELECT responsibility, started_at_ms, ended_at_ms, calendar_digest FROM sla_intervals").all() as Array<Record<string, unknown>>)
          .filter((i) => Number(i["started_at_ms"]) < periodEnd && Number(i["ended_at_ms"] ?? periodEnd) > periodStart);
        const now = s.now();
        const sumFor = (resp: string) => intervals.filter((i) => i["responsibility"] === resp)
          .reduce((acc, i) => acc + Math.max(0, Number(i["ended_at_ms"] ?? now) - Number(i["started_at_ms"])), 0);
        const starts = intervals.map((i) => Number(i["started_at_ms"]));
        const ends = intervals.map((i) => Number(i["ended_at_ms"] ?? now));
        return this.envelope(q.queryType, {
          workspaceId: q.workspaceId,
          calendarDigest: intervals[0] ? String(intervals[0]["calendar_digest"]) : domainDigest("brain:sla-calendar:v1", { intervals: 0 }),
          periodStart: iso(starts.length ? Math.min(...starts) : periodStart || now),
          periodEnd: iso(ends.length ? Math.max(...ends) : periodEnd),
          sampleCount: intervals.length,
          // No SLA target thresholds are declared in configuration yet, so
          // met-counts stay 0 rather than claiming attainment.
          responseMet: 0, resolutionMet: 0,
          keyrusMs: sumFor("keyrus"), clientWaitMs: sumFor("client"), hubWaitMs: sumFor("hub"),
          incompleteRecords: intervals.filter((i) => i["ended_at_ms"] == null).length,
          sourceWatermark: ends.length ? Math.max(...ends) : 0,
        } as unknown as JsonValue);
      }
      case "toolCandidates.list": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT","workspaceId required");
        requireWorkspaceRead(s,actor,q.workspaceId);
        const rows=s.workspaceDb(q.workspaceId,actor.organizationId).prepare("SELECT id,package_digest,state,created_at_ms FROM tool_candidates ORDER BY created_at_ms DESC LIMIT 100").all() as {id:string;package_digest:string;state:string;created_at_ms:number}[];
        return this.envelope(q.queryType,{items:rows.map((row)=>({release:{id:row.id,digest:row.package_digest},state:row.state,createdAt:iso(row.created_at_ms)}))} as unknown as JsonValue);
      }
      case "artifacts.list": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT","workspaceId required");
        requireWorkspaceRead(s,actor,q.workspaceId);
        const ws=s.workspaceDb(q.workspaceId,actor.organizationId);
        const rows=ws.prepare("SELECT id,digest,bytes,media_type,classification FROM artifacts WHERE state='verified' ORDER BY created_at_ms DESC,id LIMIT 100").all() as {id:string;digest:string;bytes:number;media_type:string;classification:string}[];
        return this.envelope(q.queryType,{items:rows.map((row)=>({artifactId:row.id,digest:row.digest,bytes:row.bytes,mediaType:row.media_type,classification:row.classification}))} as unknown as JsonValue);
      }
      case "agents.list": case "agents.get": case "workflows.list": case "workflows.get": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const release = this.activeRelease(actor.organizationId);
        if (!release) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "activate a configuration release first");
        const stored = JSON.parse(release.manifest) as { schemas?: Record<string, JsonValue>; agents?: Record<string, import("@brain/contracts").Agent>; workflows?: Record<string, import("@brain/contracts").Workflow>; manifest: { documents: Array<{ id: string; kind: string; digest: string }> } };
        const isAgent = q.queryType.startsWith("agents.");
        const entries = Object.values(isAgent ? stored.agents ?? {} : stored.workflows ?? {}).sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
        const items = entries.map((definition) => {
          const id = definition.metadata.id;
          const document = stored.manifest.documents.find((doc) => doc.kind === (isAgent ? "Agent" : "Workflow") && doc.id === id)!;
          const asset = isAgent ? readReleaseAgentInstructions(s, actor.organizationId, release.digest, id) : undefined;
          return { release: { id, digest: document.digest }, configDigest: release.digest, definition,
            ...(!isAgent ? { inputSchema: stored.schemas?.[(definition as import("@brain/contracts").Workflow).spec.inputSchemaRef] ?? null, outputSchema: stored.schemas?.[(definition as import("@brain/contracts").Workflow).spec.outputSchemaRef] ?? null } : {}),
            ...(asset ? { instructions: new TextDecoder().decode(asset.bytes), instructionsDigest: asset.instructionsDigest } : {}) };
        });
        if (q.queryType.endsWith(".list")) return this.envelope(q.queryType, { items } as unknown as JsonValue);
        const item = items.find((item) => item.release.id === q.resourceId);
        if (!item) throw new BrainDomainError("NOT_FOUND", "definition not found in the active release");
        return this.envelope(q.queryType, item as unknown as JsonValue);
      }
      case "config.explain": {
        if (!q.workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(s, actor, q.workspaceId);
        const rel = this.activeRelease(actor.organizationId);
        if (!rel) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "config explain requires an active release");
        const pointer = String((raw as { pointer?: string }).pointer ?? "");
        const stored = JSON.parse(rel.manifest) as Record<string, unknown>;
        const segments = pointer.split("/").filter(Boolean).map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
        let effective: unknown = stored;
        for (const seg of segments) {
          effective = (effective as Record<string, unknown> | undefined)?.[seg];
          if (effective === undefined) break;
        }
        const docs = ((stored["manifest"] as Record<string, unknown> | undefined)?.["documents"] ?? []) as Array<Record<string, unknown>>;
        const doc = docs.find((d) => segments.includes(String(d["id"])));
        return this.envelope(q.queryType, {
          pointer,
          effective: (effective ?? null) as JsonValue,
          sources: [{ path: doc ? String(doc["path"] ?? "active-release") : "active-release", line: 1, value: (effective ?? null) as JsonValue, rule: effective === undefined ? "absent-in-active-release" : "declared-in-active-release" }],
          configDigest: rel.digest,
        } as unknown as JsonValue);
      }
      default:
        throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `query ${q.queryType} not implemented`);
    }
  }

  // --- pack view mappers (contract views derived from stored rows only) ---
  private artifactRef(ws: ReturnType<Store["workspaceDb"]>, digest: string, fallbackId: string): Record<string, unknown> | undefined {
    const row = ws.prepare("SELECT id, bytes, media_type, classification FROM artifacts WHERE digest=? ORDER BY created_at_ms LIMIT 1").get(digest) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { artifactId: String(row["id"] ?? fallbackId), digest, bytes: Number(row["bytes"]), mediaType: String(row["media_type"]), classification: String(row["classification"]) };
  }

  private ticketView(workspaceId: string, r: Record<string, unknown>, detail: boolean, ws: ReturnType<Store["workspaceDb"]>): Record<string, unknown> {
    const observed = Number(r["observed_at_ms"]);
    const created = Number(r["created_at_ms"] ?? 0) || observed;
    const states = ["open", "pending", "resolved", "closed"];
    const base: Record<string, unknown> = {
      id: String(r["id"]), workspaceId, version: Number(r["version"] ?? 1), updatedAt: iso(observed),
      title: String(r["title"]), state: states.includes(String(r["state"])) ? String(r["state"]) : "open",
      priority: String(r["priority"] ?? "normal"), sourceVersion: String(r["source_version"]),
      // Evidence is ready only when a reviewed draft exists for this ticket.
      evidenceReady: !!ws.prepare("SELECT 1 FROM support_drafts WHERE ticket_id=? AND approval_id IS NOT NULL LIMIT 1").get(String(r["id"])),
      createdAt: iso(created),
    };
    if (detail) {
      const body = this.artifactRef(ws, String(r["body_digest"]), `ticket-body-${String(r["id"])}`);
      base["body"] = body ?? { artifactId: `ticket-body-${String(r["id"])}`, digest: String(r["body_digest"]), bytes: 0, mediaType: "text/plain", classification: "internal" };
      const draft = ws.prepare("SELECT content_digest, approval_id FROM support_drafts WHERE ticket_id=? ORDER BY version DESC LIMIT 1").get(String(r["id"])) as Record<string, unknown> | undefined;
      if (draft) {
        const ref = this.artifactRef(ws, String(draft["content_digest"]), `draft-${String(r["id"])}`);
        if (ref) base["draft"] = ref;
        if (draft["approval_id"]) base["approvalId"] = String(draft["approval_id"]);
      }
    }
    return base;
  }

  private incidentView(workspaceId: string, r: Record<string, unknown>, detail: boolean, ws: ReturnType<Store["workspaceDb"]>): Record<string, unknown> {
    const opened = Number(r["opened_at_ms"]);
    const latest = ws.prepare("SELECT MAX(observed_at_ms) AS observed, MAX(expires_at_ms) AS expires FROM observations WHERE incident_id=?").get(String(r["id"])) as { observed: number | null; expires: number | null };
    const observedAt = latest.observed ?? opened;
    const expiresAt = latest.expires ?? observedAt;
    const resolved = r["resolved_at_ms"] == null ? null : Number(r["resolved_at_ms"]);
    const title = String(r["title"] ?? "") || `${String(r["severity"])} incident: ${String(r["target_key"])}`;
    const base: Record<string, unknown> = {
      id: String(r["id"]), workspaceId, version: Number(r["version"]), updatedAt: iso(resolved ?? observedAt),
      title, state: String(r["state"]), severity: String(r["severity"]), targetKey: String(r["target_key"]),
      observedAt: iso(observedAt), expiresAt: iso(expiresAt), createdAt: iso(opened),
    };
    if (detail) {
      const obs = ws.prepare("SELECT observation_digest FROM observations WHERE incident_id=? ORDER BY observed_at_ms LIMIT 100").all(String(r["id"])) as Array<{ observation_digest: string }>;
      base["observations"] = obs.map((o) => this.artifactRef(ws, o.observation_digest, `observation-${o.observation_digest.slice(7, 19)}`)).filter(Boolean);
    }
    return base;
  }

  private deliveryView(workspaceId: string, r: Record<string, unknown>, ws: ReturnType<Store["workspaceDb"]>): Record<string, unknown> {
    const results = ws.prepare("SELECT criterion_id, outcome, evidence_digest FROM rubric_results WHERE dossier_id=?").all(String(r["id"])) as Array<Record<string, unknown>>;
    const statusMap: Record<string, string> = { passed: "passed", failed: "failed", incomplete: "inconclusive" };
    const evidenceDigests = [...new Set(results.map((x) => String(x["evidence_digest"])))];
    return {
      id: String(r["id"]), workspaceId, version: Number(r["version"]), updatedAt: iso(Number(r["created_at_ms"])),
      sourceRevision: String(r["source_revision"]), state: String(r["state"]),
      rubric: { id: "rubric", digest: String(r["rubric_digest"]) },
      criteria: results.map((x) => ({
        criterionId: String(x["criterion_id"]), checkId: String(x["criterion_id"]),
        status: statusMap[String(x["outcome"])] ?? "inconclusive", oracleDigest: String(r["rubric_digest"]),
        artifacts: [this.artifactRef(ws, String(x["evidence_digest"]), "rubric-evidence")].filter(Boolean),
        detail: `rubric outcome: ${String(x["outcome"])}`,
      })),
      evidence: evidenceDigests.map((dg) => this.artifactRef(ws, dg, "dossier-evidence")).filter(Boolean),
      createdAt: iso(Number(r["created_at_ms"])),
    };
  }

  private sessionView(r: Record<string, unknown>): Record<string, unknown> {
    const s = this.store;
    const job = s.control.prepare("SELECT step_id, workflow_run_id FROM jobs WHERE id=?").get(String(r["job_id"])) as Record<string, unknown> | undefined;
    const budget = s.control.prepare("SELECT micro_usd, settled_micro_usd FROM budget_reservations WHERE job_id=?").get(String(r["job_id"])) as Record<string, unknown> | undefined;
    const states = ["starting", "running", "waiting", "stopping", "stopped", "failed"];
    const updated = Number(r["updated_at_ms"] ?? 0) || s.now();
    return {
      sessionId: String(r["id"]), jobId: String(r["job_id"]), attemptId: String(r["attempt_id"]),
      engine: { id: String(r["engine_id"]), version: "1", adapterDigest: String(r["adapter_digest"]), features: [] },
      state: states.includes(String(r["state"])) ? String(r["state"]) : "running",
      task: job ? `step ${String(job["step_id"])} of run ${String(job["workflow_run_id"])}` : `job ${String(r["job_id"])}`,
      usedTokens: 0, usedMicroUsd: Number(budget?.["settled_micro_usd"] ?? 0), reservedMicroUsd: Number(budget?.["micro_usd"] ?? 0),
      lastEventSequence: Number(r["event_sequence"] ?? 0), updatedAt: iso(updated),
    };
  }

  private listPackQuery(actor: ActorContext, queryType: string, workspaceId?: string): JsonValue {
    const s = this.store;
    if (!workspaceId) return this.envelope(queryType, { items: [] } as unknown as JsonValue);
    const ws = s.workspaceDb(workspaceId, actor.organizationId);
    const table = { "tickets.list": "tickets", "incidents.list": "incidents", "delivery.list": "delivery_dossiers", "tools.list": "tool_candidates", "decisions.list": "decisions", "sessions.list": "sessions", "members.list": "", "audit.list": "" }[queryType] ?? "";
    if (queryType === "members.list") {
      const rows = s.control.prepare("SELECT principal_id, role, version, granted_at_ms, revoked_at_ms FROM workspace_memberships WHERE workspace_id=?").all(workspaceId) as Array<Record<string, unknown>>;
      const byPrincipal = new Map<string, { roles: string[]; version: number; createdAtMs: number; revoked: boolean }>();
      for (const r of rows) {
        const pid = String(r["principal_id"]);
        const cur = byPrincipal.get(pid) ?? { roles: [], version: 0, createdAtMs: Number(r["granted_at_ms"]), revoked: true };
        if (r["revoked_at_ms"] == null) { cur.roles.push(String(r["role"])); cur.revoked = false; }
        cur.version = Math.max(cur.version, Number(r["version"]));
        cur.createdAtMs = Math.min(cur.createdAtMs, Number(r["granted_at_ms"]));
        byPrincipal.set(pid, cur);
      }
      const items = [...byPrincipal.entries()].map(([principalId, g]) => ({
        id: `grant-${workspaceId}-${principalId}`, workspaceId, principalId,
        roles: g.roles, version: g.version, revoked: g.revoked, createdAt: iso(g.createdAtMs),
      }));
      return this.envelope(queryType, { items } as unknown as JsonValue);
    }
    if (queryType === "audit.list") {
      const rows = s.control.prepare("SELECT cursor, event_id, event_type, aggregate_id, payload_json, payload_digest, created_at_ms FROM events WHERE organization_id=? AND workspace_id=? ORDER BY cursor DESC LIMIT 50").all(actor.organizationId, workspaceId) as Array<Record<string, unknown>>;
      return this.envelope(queryType, { items: rows.map((r) => {
        let actorId = "system";
        try {
          const payload = JSON.parse(String(r["payload_json"])) as Record<string, unknown>;
          actorId = String(payload["actorId"] ?? payload["actorRef"] ?? payload["requestedBy"] ?? "system");
        } catch { /* payload is digest-bound; actor stays system */ }
        return { id: String(r["event_id"]), cursor: Number(r["cursor"]), actorId, action: String(r["event_type"]), resourceId: String(r["aggregate_id"]), occurredAt: iso(Number(r["created_at_ms"])), payloadDigest: String(r["payload_digest"]) };
      }) } as unknown as JsonValue);
    }
    if (queryType === "tools.list") {
      // The catalog is the active release's declared Tool documents.
      const rel = this.activeRelease(actor.organizationId);
      if (!rel) return this.envelope(queryType, { items: [] } as unknown as JsonValue);
      const stored = JSON.parse(rel.manifest) as { manifest?: { tools?: Array<Record<string, unknown>> } };
      const created = s.control.prepare("SELECT created_at_ms FROM config_releases WHERE digest=? AND organization_id=?").get(rel.digest, actor.organizationId) as { created_at_ms: number } | undefined;
      const items = (stored.manifest?.tools ?? []).map((t) => ({
        id: String(t["id"]), release: { id: String(t["id"]), digest: String(t["digest"]) }, status: "trusted",
        effectClass: String(t["effectClass"]), inputSchemaRef: String(t["inputSchemaRef"]), outputSchemaRef: String(t["outputSchemaRef"]),
        evidence: [], createdAt: iso(created?.created_at_ms ?? s.now()),
      }));
      return this.envelope(queryType, { items } as unknown as JsonValue);
    }
    if (!table) return this.envelope(queryType, { items: [] } as unknown as JsonValue);
    const rows = ws.prepare(`SELECT * FROM ${table} LIMIT 50`).all() as Array<Record<string, unknown>>;
    const mapRow = (r: Record<string, unknown>): Record<string, unknown> => {
      switch (queryType) {
        case "tickets.list": return this.ticketView(workspaceId, r, false, ws);
        case "incidents.list": return this.incidentView(workspaceId, r, false, ws);
        case "delivery.list": return this.deliveryView(workspaceId, r, ws);
        case "sessions.list": return this.sessionView(r);
        case "decisions.list": return {
          id: String(r["id"]), workspaceId, cardId: String(r["card_id"]), actorId: String(r["actor_id"]),
          decision: String(r["decision"]), note: String(r["note"] ?? ""), createdAt: iso(Number(r["created_at_ms"])),
        };
        default: return r;
      }
    };
    return this.envelope(queryType, { items: rows.map(mapRow) } as unknown as JsonValue);
  }

  private getPackQuery(actor: ActorContext, queryType: string, workspaceId: string | undefined, resourceId: string): JsonValue {
    const s = this.store;
    if (queryType === "evidence.get") {
      // resourceId is a bundle digest or bundle id; search caller workspaces.
      const candidates = workspaceId ? [workspaceId] : (s.control.prepare("SELECT workspace_id FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL").all(actor.organizationId, actor.actorId) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
      for (const wsId of candidates) {
        const ws = s.workspaceDb(wsId, actor.organizationId);
        const row = ws.prepare("SELECT manifest_json FROM evidence_bundles WHERE digest=? OR bundle_id=?").get(resourceId, resourceId) as { manifest_json: string } | undefined;
        if (row) {
          const verdict = ws.prepare("SELECT manifest_json FROM verification_verdicts WHERE bundle_digest=? ORDER BY created_at_ms DESC LIMIT 1").get(resourceId) as { manifest_json: string } | undefined;
          return this.envelope(queryType, { bundle: JSON.parse(row.manifest_json), ...(verdict ? { verdict: JSON.parse(verdict.manifest_json) } : {}) } as unknown as JsonValue);
        }
      }
      throw new BrainDomainError("NOT_FOUND", "evidence not found");
    }
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    requireWorkspaceRead(s, actor, workspaceId);
    const ws = s.workspaceDb(workspaceId, actor.organizationId);
    const table = { "session.get": "sessions", "ticket.get": "tickets", "incident.get": "incidents", "delivery.get": "delivery_dossiers" }[queryType] ?? "";
    if (!table) throw new BrainDomainError("NOT_FOUND", "resource not found");
    const row = ws.prepare(`SELECT * FROM ${table} WHERE id=?`).get(resourceId) as Record<string, unknown> | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "resource not found");
    const view = queryType === "ticket.get" ? this.ticketView(workspaceId, row, true, ws)
      : queryType === "incident.get" ? this.incidentView(workspaceId, row, true, ws)
      : queryType === "delivery.get" ? this.deliveryView(workspaceId, row, ws)
      : queryType === "session.get" ? this.sessionView(row)
      : row;
    return this.envelope(queryType, view as unknown as JsonValue);
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
      const hasInputs=ws.prepare("SELECT 1 FROM sqlite_master WHERE name='run_inputs'").get();
      if (hasInputs) for (const run of ws.prepare("SELECT DISTINCT r.id FROM workflow_runs r JOIN evidence_bundles b ON json_extract(b.manifest_json,'$.workflowRunId')=r.id WHERE r.state IN ('running','suspended') AND b.state='submitted' ORDER BY r.id LIMIT 100").all() as Array<{id:string}>) {
        this.workflows.evidenceSubmitted(workspace.organization_id,workspace.id,run.id);
      }
    }
    return done;
  }

  listEvents(actor: ActorContext, afterCursor: number, limit = 100): JsonValue {
    const rows = this.store.control.prepare(`SELECT cursor, event_id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json, created_at_ms
      FROM events WHERE organization_id=? AND cursor>? ORDER BY cursor ASC LIMIT ?`).all(actor.organizationId, afterCursor, limit) as Array<Record<string, unknown>>;
    const allowed = new Set((this.store.control.prepare("SELECT workspace_id FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL").all(actor.organizationId, actor.actorId) as Array<{ workspace_id: string }>).map((r) => r.workspace_id));
    return rows.filter((r) => !r["workspace_id"] || allowed.has(String(r["workspace_id"]))).map((r) => ({
      cursor: Number(r["cursor"]), eventId: String(r["event_id"]), type: String(r["event_type"]),
      aggregateId: String(r["aggregate_id"]), workspaceId: r["workspace_id"] ? String(r["workspace_id"]) : undefined,
      payload: JSON.parse(String(r["payload_json"])), createdAt: iso(Number(r["created_at_ms"])),
    })) as unknown as JsonValue;
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
        const found = this.memory.search(mq, { organizationId: actor.organizationId, workspaceId });
        return this.envelope("memory.search", { ...found, degraded: true, reason: "TencentDB unavailable; local scoped store used" } as unknown as import("@brain/contracts").JsonValue);
      }
    }
    const found = this.memory.search(mq, { organizationId: actor.organizationId, workspaceId });
    return this.envelope("memory.search", { ...found, degraded: true, reason: "TencentDB not configured; local scoped store used" } as unknown as import("@brain/contracts").JsonValue);
  }
}
