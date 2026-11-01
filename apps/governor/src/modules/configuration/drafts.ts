import { domainDigest } from "@brain/contracts";
import type { ActorContext, ConfigurationDraft, DraftRevision, JsonValue, PublicationProposal, ValidationRun } from "@brain/contracts";
import { stringify } from "yaml";
import type { Store } from "../../application/store";
import { requireWorkspaceRead, scopesForPrincipal } from "../../application/authz";
import { assertExpectedVersion } from "../../domain/states";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { compileRelease, parseRestrictedYaml, type AgentInstruction, type SourceDoc, type ToolScript } from "./compiler";
import { normalizeDocuments, workflowDocument } from "./serialize";
import { diffDocuments } from "./diff";
import { impactDocuments } from "./impact";

export interface ConfigurationDraftCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly expectedVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReleaseAssets {
  readonly scripts: readonly ToolScript[];
  readonly instructions: readonly AgentInstruction[];
  readonly schemas: readonly SourceDoc[];
}

export interface ConfigurationDraftDeps {
  activeDocuments(organizationId: string): SourceDoc[];
  activeAssets(organizationId: string): SourceDoc[];
  publishConfiguration(actor: ActorContext, bindingId: string, documents: readonly SourceDoc[], message: string): Promise<{ commitOid: string; documents: SourceDoc[] }>;
  stageRelease(actor: ActorContext, documents: readonly SourceDoc[], assets: ReleaseAssets, sourceRevision: string): { digest: string };
}

type DraftRow = {
  id: string; organization_id: string; workspace_id: string; title: string; kind: string;
  state: ConfigurationDraft["state"]; current_revision_id: string; binding_id: string | null;
  created_by: string; version: number; created_at_ms: number; updated_at_ms: number;
};
type RevisionRow = {
  id: string; draft_id: string; revision: number; digest: string; documents_json: string; assets_json: string;
  source: DraftRevision["source"]; created_by: string; created_at_ms: number;
};
type ValidationRow = {
  id: string; draft_id: string; revision_id: string; kind: ValidationRun["kind"];
  status: ValidationRun["status"]; diagnostics_json: string; created_at_ms: number;
};
type PublicationRow = {
  id: string; draft_id: string; revision_id: string; binding_id: string; state: PublicationProposal["state"];
  commit_oid: string | null; release_digest: string | null; error: string | null;
  requested_by: string; requested_at_ms: number; completed_at_ms: number | null;
};

function slug(title: string, fallback: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

function normalizeAssets(assets: readonly SourceDoc[]): SourceDoc[] {
  const paths = new Set<string>();
  for (const asset of assets) {
    if (!asset.path || asset.path.startsWith("/") || asset.path.includes("\\") || asset.path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new BrainDomainError("INVALID_CONTRACT", `asset path escapes the release: ${asset.path}`);
    }
    if (!/\.(md|json|sh)$/u.test(asset.path)) throw new BrainDomainError("INVALID_CONTRACT", `unsupported release asset: ${asset.path}`);
    if (Buffer.byteLength(asset.text, "utf8") > 1024 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", `release asset exceeds 1 MiB: ${asset.path}`);
    const key = asset.path.toLowerCase();
    if (paths.has(key)) throw new BrainDomainError("INVALID_CONTRACT", `duplicate release asset: ${asset.path}`);
    paths.add(key);
  }
  return assets.map((asset) => ({ path: asset.path, text: asset.text })).sort((left, right) => left.path.localeCompare(right.path));
}

function defaultDraft(title: string, kind: string): { documents: SourceDoc[]; assets: SourceDoc[] } {
  const id = slug(title, `new-${kind.toLowerCase()}`);
  if (kind === "Workflow") {
    return { documents: [workflowDocument(id, {
      echo: {
        kind: "dispatch", needs: [], input: { message: { source: "input", pointer: "/message" } }, timeoutSeconds: 30,
        uses: { type: "tool", release: { id: "fixture.echo", digest: `sha256:${"0".repeat(64)}` } },
        runsOn: { all: ["os:linux", "tool:bash", "isolation:ephemeral-container"], resources: { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 }, isolation: "ephemeral-container" },
        effectClass: "read",
      },
    })], assets: [] };
  }
  const documents = [{ path: `${kind.toLowerCase()}s/${id}.yaml`, text: stringify({
    apiVersion: "brain.keyrus/v1", kind, metadata: { id, ...(kind === "Agent" ? { version: "1.0.0" } : {}) },
    spec: kind === "Agent" ? {
      instructionsPath: `agents/${id}.md`, tools: [],
      engine: { anyOf: ["pi"], features: ["start", "events", "cancel"] },
      maxTurns: 12, maxChildren: 0, maxDepth: 0, maxTokens: 100000, maxMicroUsd: 0,
    } : {},
  }) }];
  return { documents, assets: kind === "Agent" ? [{ path: `agents/${id}.md`, text: `# ${title}\n\nDescribe the agent's read-only purpose, expected output and acceptance conditions.\n` }] : [] };
}

function releaseAssets(documents: readonly SourceDoc[], assets: readonly SourceDoc[]): ReleaseAssets {
  const instructions: AgentInstruction[] = [];
  const scripts: ToolScript[] = [];
  for (const document of documents) {
    const value = parseRestrictedYaml(document.text, document.path);
    const id = String((value["metadata"] as { id?: string } | undefined)?.id ?? "");
    const spec = value["spec"] as Record<string, unknown> | undefined;
    if (value["kind"] === "Agent") {
      const path = String(spec?.["instructionsPath"] ?? "");
      const instruction = assets.find((asset) => asset.path === path);
      if (instruction) instructions.push({ agentId: id, path, text: instruction.text });
    }
    if (value["kind"] === "Tool" && typeof spec?.["entrypoint"] === "string") {
      const entrypoint = spec["entrypoint"];
      const script = assets.find((asset) => asset.path === entrypoint || asset.path.endsWith(`/${entrypoint}`));
      if (script) scripts.push({ toolId: id, entrypoint, bytesBase64: Buffer.from(script.text, "utf8").toString("base64") });
    }
  }
  return { instructions, scripts, schemas: assets.filter((asset) => asset.path.startsWith("schemas/") && asset.path.endsWith(".json")) };
}

export class ConfigurationDraftService {
  constructor(private readonly store: Store, private readonly deps: ConfigurationDraftDeps) {}

  private db(actor: ActorContext, workspaceId: string): void {
    requireWorkspaceRead(this.store, actor, workspaceId);
  }

  private row(actor: ActorContext, workspaceId: string, id: string): DraftRow {
    this.db(actor, workspaceId);
    const row = this.store.control.prepare("SELECT * FROM config_drafts WHERE id=? AND organization_id=? AND workspace_id=?").get(id, actor.organizationId, workspaceId) as DraftRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "configuration draft not found");
    return row;
  }

  private revision(draft: DraftRow): RevisionRow {
    const row = this.store.control.prepare("SELECT * FROM config_draft_revisions WHERE id=? AND draft_id=?").get(draft.current_revision_id, draft.id) as RevisionRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "configuration draft revision not found");
    return row;
  }

  private static documents(revision: RevisionRow): SourceDoc[] {
    return JSON.parse(revision.documents_json) as SourceDoc[];
  }

  private static assets(revision: RevisionRow): SourceDoc[] {
    return JSON.parse(revision.assets_json) as SourceDoc[];
  }

  private static draft(row: DraftRow): ConfigurationDraft {
    return {
      draftId: row.id, organizationId: row.organization_id, workspaceId: row.workspace_id,
      title: row.title, kind: row.kind, state: row.state, currentRevisionId: row.current_revision_id,
      ...(row.binding_id ? { bindingId: row.binding_id } : {}), createdBy: row.created_by,
      version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  private static revisionView(row: RevisionRow): DraftRevision {
    return {
      revisionId: row.id, draftId: row.draft_id, revision: row.revision, digest: row.digest,
      documents: JSON.parse(row.documents_json) as SourceDoc[], assets: JSON.parse(row.assets_json) as SourceDoc[], source: row.source,
      createdBy: row.created_by, createdAt: iso(row.created_at_ms),
    };
  }

  private static validation(row: ValidationRow): ValidationRun {
    return {
      validationRunId: row.id, draftId: row.draft_id, revisionId: row.revision_id, kind: row.kind,
      status: row.status, diagnostics: JSON.parse(row.diagnostics_json) as ValidationRun["diagnostics"], createdAt: iso(row.created_at_ms),
    };
  }

  private static publication(row: PublicationRow): PublicationProposal {
    return {
      publicationId: row.id, draftId: row.draft_id, revisionId: row.revision_id, bindingId: row.binding_id,
      state: row.state, ...(row.commit_oid ? { commitOid: row.commit_oid } : {}),
      ...(row.release_digest ? { releaseDigest: row.release_digest } : {}), ...(row.error ? { error: row.error } : {}),
      createdBy: row.requested_by, createdAt: iso(row.requested_at_ms), ...(row.completed_at_ms ? { completedAt: iso(row.completed_at_ms) } : {}),
    };
  }

  apply(actor: ActorContext, command: ConfigurationDraftCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    switch (command.commandType) {
      case "configDraft.create": return this.create(actor, workspaceId, command.payload);
      case "configDraft.update": return this.update(actor, workspaceId, command.payload, command.expectedVersion);
      case "configDraft.validate": return this.validate(actor, workspaceId, command.payload, "validate");
      case "configDraft.test": return this.validate(actor, workspaceId, command.payload, "test");
      case "configDraft.publish": return this.publish(actor, workspaceId, command.payload, command.expectedVersion);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported configuration draft command ${command.commandType}`);
    }
  }

  private create(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    this.db(actor, workspaceId);
    const title = String(payload["title"]);
    const kind = String(payload["kind"] ?? "Workflow");
    let { documents, assets } = payload["documents"]
      ? { documents: payload["documents"] as SourceDoc[], assets: (payload["assets"] as SourceDoc[] | undefined) ?? [] }
      : defaultDraft(title, kind);
    const source = payload["sourceDefinition"] as { kind?: string; id?: string; mode?: string } | undefined;
    if (source) {
      if (payload["documents"] || source.kind !== kind || (source.mode !== "edit" && source.mode !== "duplicate")) throw new BrainDomainError("INVALID_ARGUMENT", "source definition must match the draft kind and mode");
      const sourceDocument = this.deps.activeDocuments(actor.organizationId).find((document) => {
        const value = parseRestrictedYaml(document.text, document.path);
        return value["kind"] === kind && String((value["metadata"] as { id?: string } | undefined)?.id ?? "") === source.id;
      });
      if (!sourceDocument) throw new BrainDomainError("NOT_FOUND", `${kind} ${source.id} is not in the active release`);
      documents = [sourceDocument];
      const value = parseRestrictedYaml(sourceDocument.text, sourceDocument.path);
      const instructionPath = String((value["spec"] as Record<string, unknown> | undefined)?.["instructionsPath"] ?? "");
      assets = this.deps.activeAssets(actor.organizationId).filter((asset) => asset.path === instructionPath);
      if (source.mode === "duplicate") {
        const id = slug(title, `new-${kind.toLowerCase()}`);
        value["metadata"] = { ...(value["metadata"] as Record<string, unknown>), id };
        const spec = value["spec"] as Record<string, unknown>;
        if (kind === "Agent") {
          const nextInstructionPath = `agents/${id}.md`;
          spec["instructionsPath"] = nextInstructionPath;
          assets = assets.map((asset) => ({ path: nextInstructionPath, text: asset.text }));
        }
        documents = [{ path: sourceDocument.path.replace(/[^/]+$/u, `${id}.yaml`), text: stringify(value) }];
      }
    }
    documents = normalizeDocuments(documents);
    assets = normalizeAssets(assets);
    const id = this.store.id("draft");
    const revisionId = this.store.id("revision");
    const digest = domainDigest("brain:configuration-draft:v1", { documents, assets } as unknown as JsonValue);
    this.store.inTx(this.store.control, () => {
      const now = this.store.now();
      this.store.control.prepare("INSERT INTO config_drafts(id,organization_id,workspace_id,title,kind,state,current_revision_id,binding_id,created_by,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)")
        .run(id, actor.organizationId, workspaceId, title, kind, revisionId, payload["bindingId"] ? String(payload["bindingId"]) : null, actor.actorId, now, now);
      this.store.control.prepare("INSERT INTO config_draft_revisions(id,draft_id,revision,digest,documents_json,assets_json,source,created_by,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(revisionId, id, 1, digest, JSON.stringify(documents), JSON.stringify(assets), payload["documents"] || source ? "yaml" : "visual", actor.actorId, now);
    });
    return id;
  }

  private update(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const draft = this.row(actor, workspaceId, String(payload["draftId"]));
    if (draft.state === "publishing" || draft.state === "published") throw new BrainDomainError("CONFLICT", "published drafts cannot be edited; create a new draft");
    assertExpectedVersion(draft.version, expectedVersion);
    const documents = normalizeDocuments(payload["documents"] as SourceDoc[]);
    const assets = normalizeAssets((payload["assets"] as SourceDoc[] | undefined) ?? ConfigurationDraftService.assets(this.revision(draft)));
    const revisionId = this.store.id("revision");
    const digest = domainDigest("brain:configuration-draft:v1", { documents, assets } as unknown as JsonValue);
    this.store.inTx(this.store.control, () => {
      const current = this.store.control.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM config_draft_revisions WHERE draft_id=?").get(draft.id) as { revision: number };
      const now = this.store.now();
      this.store.control.prepare("INSERT INTO config_draft_revisions(id,draft_id,revision,digest,documents_json,assets_json,source,created_by,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(revisionId, draft.id, current.revision + 1, digest, JSON.stringify(documents), JSON.stringify(assets), payload["source"] === "visual" ? "visual" : "yaml", actor.actorId, now);
      this.store.control.prepare("UPDATE config_drafts SET current_revision_id=?,state='draft',version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(revisionId, now, draft.id, draft.version);
    });
    return revisionId;
  }

  private validate(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, kind: ValidationRun["kind"]): string {
    const draft = this.row(actor, workspaceId, String(payload["draftId"]));
    const revision = this.revision(draft);
    const diagnostics: Array<ValidationRun["diagnostics"][number]> = [];
    try {
      const documents = ConfigurationDraftService.documents(revision);
      const assets = ConfigurationDraftService.assets(revision);
      const paths = new Set([...documents, ...assets].map((document) => document.path));
      const baseDocuments = this.deps.activeDocuments(actor.organizationId).filter((document) => !paths.has(document.path));
      const baseAssets = this.deps.activeAssets(actor.organizationId).filter((document) => !paths.has(document.path));
      const mergedDocuments = [...baseDocuments, ...documents];
      const mergedAssets = [...baseAssets, ...assets];
      const compiledAssets = releaseAssets(mergedDocuments, mergedAssets);
      compileRelease(mergedDocuments, `sha256:${"0".repeat(64)}`, compiledAssets.scripts, compiledAssets.instructions, compiledAssets.schemas);
      diagnostics.push({ code: "COMPILE_OK", message: "The exact draft revision and its pinned assets compile with the active release.", severity: "info" });
      if (kind === "test") diagnostics.push({ code: "GRAPH_OK", message: "Workflow graphs and dependency gates pass structural dry-run checks.", severity: "info" });
    } catch (error) {
      diagnostics.push({ code: "COMPILE_FAILED", message: error instanceof Error ? error.message.slice(0, 1000) : "Compilation failed", severity: "error" });
    }
    const status = diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "failed" : "passed";
    const id = this.store.id("validation");
    this.store.inTx(this.store.control, () => {
      const now = this.store.now();
      this.store.control.prepare("INSERT INTO validation_runs(id,draft_id,revision_id,kind,status,diagnostics_json,created_at_ms) VALUES (?,?,?,?,?,?,?)")
        .run(id, draft.id, revision.id, kind, status, JSON.stringify(diagnostics), now);
      this.store.control.prepare("UPDATE config_drafts SET state=?,version=version+1,updated_at_ms=? WHERE id=?").run(status === "passed" ? "valid" : "invalid", now, draft.id);
    });
    return id;
  }

  private publish(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const draft = this.row(actor, workspaceId, String(payload["draftId"]));
    assertExpectedVersion(draft.version, expectedVersion);
    const bindingId = String(payload["bindingId"] ?? draft.binding_id ?? "");
    if (!bindingId) throw new BrainDomainError("INVALID_ARGUMENT", "a verified configuration write binding is required");
    const revision = this.revision(draft);
    const valid = this.store.control.prepare("SELECT 1 FROM validation_runs WHERE draft_id=? AND revision_id=? AND status='passed'").get(draft.id, revision.id);
    if (!valid) throw new BrainDomainError("CONFLICT", "the current revision must pass validation before publication");
    const id = this.store.id("publication");
    this.store.inTx(this.store.control, () => {
      const now = this.store.now();
      this.store.control.prepare("INSERT INTO publication_requests(id,draft_id,revision_id,binding_id,state,requested_by,requested_at_ms) VALUES (?,?,?,?,'queued',?,?)")
        .run(id, draft.id, revision.id, bindingId, actor.actorId, now);
      this.store.control.prepare("UPDATE config_drafts SET state='publishing',binding_id=?,version=version+1,updated_at_ms=? WHERE id=?").run(bindingId, now, draft.id);
    });
    return id;
  }

  async publishPending(): Promise<{ published: number; failed: number }> {
    const requests = this.store.control.prepare("SELECT * FROM publication_requests WHERE state='queued' ORDER BY requested_at_ms,id LIMIT 10").all() as PublicationRow[];
    let published = 0;
    let failed = 0;
    for (const request of requests) {
      const draft = this.store.control.prepare("SELECT * FROM config_drafts WHERE id=?").get(request.draft_id) as DraftRow;
      const revision = this.store.control.prepare("SELECT * FROM config_draft_revisions WHERE id=?").get(request.revision_id) as RevisionRow;
      const actor: ActorContext = {
        kind: "human", actorId: request.requested_by, organizationId: draft.organization_id, workspaceId: draft.workspace_id,
        scopes: scopesForPrincipal(this.store, request.requested_by, draft.organization_id, draft.workspace_id),
        authMethod: "session", authGeneration: 1,
      };
      try {
        const documents = ConfigurationDraftService.documents(revision);
        const assets = ConfigurationDraftService.assets(revision);
        const result = await this.deps.publishConfiguration(actor, request.binding_id, [...documents, ...assets], `Publish ${draft.title} revision ${revision.revision}`);
        const paths = new Set([...documents, ...assets].map((document) => document.path));
        const committedDocuments = result.documents.filter((document) => documents.some((candidate) => candidate.path === document.path));
        const committedAssets = result.documents.filter((document) => assets.some((candidate) => candidate.path === document.path));
        const mergedDocuments = [...this.deps.activeDocuments(actor.organizationId).filter((document) => !paths.has(document.path)), ...committedDocuments];
        const mergedAssets = [...this.deps.activeAssets(actor.organizationId).filter((document) => !paths.has(document.path)), ...committedAssets];
        const release = this.deps.stageRelease(actor, mergedDocuments, releaseAssets(mergedDocuments, mergedAssets), `sha1:${result.commitOid}`);
        this.store.inTx(this.store.control, () => {
          const now = this.store.now();
          this.store.control.prepare("UPDATE publication_requests SET state='compiled',commit_oid=?,release_digest=?,completed_at_ms=? WHERE id=?").run(result.commitOid, release.digest, now, request.id);
          this.store.control.prepare("UPDATE config_drafts SET state='published',version=version+1,updated_at_ms=? WHERE id=?").run(now, draft.id);
          this.store.emit(this.store.control, { organizationId: draft.organization_id, workspaceId: draft.workspace_id, aggregateType: "configurationDraft", aggregateId: draft.id, eventType: "configDraft.published", payload: { draftId: draft.id, publicationId: request.id, commitOid: result.commitOid, releaseDigest: release.digest } });
        });
        published++;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 1000) : "Publication failed";
        this.store.inTx(this.store.control, () => {
          const now = this.store.now();
          this.store.control.prepare("UPDATE publication_requests SET state='failed',error=?,completed_at_ms=? WHERE id=?").run(message, now, request.id);
          this.store.control.prepare("UPDATE config_drafts SET state='failed',version=version+1,updated_at_ms=? WHERE id=?").run(now, draft.id);
        });
        failed++;
      }
    }
    return { published, failed };
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, resourceId?: string): JsonValue {
    this.db(actor, workspaceId);
    if (queryType === "configDrafts.list") {
      const rows = this.store.control.prepare("SELECT * FROM config_drafts WHERE organization_id=? AND workspace_id=? ORDER BY updated_at_ms DESC,id LIMIT 100").all(actor.organizationId, workspaceId) as DraftRow[];
      return { items: rows.map(ConfigurationDraftService.draft) } as unknown as JsonValue;
    }
    const draft = this.row(actor, workspaceId, String(resourceId));
    const revisions = (this.store.control.prepare("SELECT * FROM config_draft_revisions WHERE draft_id=? ORDER BY revision DESC LIMIT 100").all(draft.id) as RevisionRow[]).map(ConfigurationDraftService.revisionView);
    const current = revisions[0];
    if (!current) throw new BrainDomainError("NOT_FOUND", "configuration draft revision not found");
    const currentRevision = this.revision(draft);
    const documents = ConfigurationDraftService.documents(currentRevision);
    const assets = ConfigurationDraftService.assets(currentRevision);
    const activePaths = new Set(documents.map((document) => document.path));
    const base = this.deps.activeDocuments(actor.organizationId).filter((document) => !activePaths.has(document.path));
    const comparisonBase = base.filter((document) => activePaths.has(document.path));
    if (queryType === "configDrafts.impact") return impactDocuments(comparisonBase, documents) as unknown as JsonValue;
    if (queryType === "configDrafts.get") {
      const validations = (this.store.control.prepare("SELECT * FROM validation_runs WHERE draft_id=? ORDER BY created_at_ms DESC,id LIMIT 100").all(draft.id) as ValidationRow[]).map(ConfigurationDraftService.validation);
      const publications = (this.store.control.prepare("SELECT * FROM publication_requests WHERE draft_id=? ORDER BY requested_at_ms DESC,id LIMIT 100").all(draft.id) as PublicationRow[]).map(ConfigurationDraftService.publication);
      const assetPaths = new Set(assets.map((asset) => asset.path));
      const baseAssets = this.deps.activeAssets(actor.organizationId).filter((asset) => assetPaths.has(asset.path));
      return {
        draft: ConfigurationDraftService.draft(draft), revisions, validations, publications,
        diff: diffDocuments([...comparisonBase, ...baseAssets], [...documents, ...assets]), impact: impactDocuments(comparisonBase, documents),
      } as unknown as JsonValue;
    }
    throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `unsupported configuration draft query ${queryType}`);
  }
}
