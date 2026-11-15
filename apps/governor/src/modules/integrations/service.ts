import { domainDigest } from "@brain/contracts";
import type { ActorContext, GitConnection, GitProposal, GitProvider, IntegrationRepository, JsonValue, RepositoryBinding } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { decryptGitCredentials, encryptGitCredentials } from "./crypto";
import { checkProviderFitsHost, gitProviderLabel, parseGitProvider } from "./git-provider";
import { protocolClient, type RemoteSnapshot } from "./providers";
import { HostedPullRequestApi, pushProposalBranch, type ProposedFile, type PullRequestApi } from "./pull-request";

export interface IntegrationCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

type ConnectionRow = {
  id: string; organization_id: string; name: string; provider: GitProvider;
  base_url: string; encrypted_credentials: string; status: GitConnection["status"]; detail: string | null;
  repositories_json: string; remote_refs_json: string; created_by: string; created_at_ms: number; updated_at_ms: number; last_verified_at_ms: number | null;
};
type BindingRow = {
  id: string; connection_id: string; workspace_id: string; kind: RepositoryBinding["kind"];
  repository_key: string; access: RepositoryBinding["access"]; status: RepositoryBinding["status"];
  detail: string | null; created_by: string; created_at_ms: number; updated_at_ms: number; last_verified_at_ms: number | null;
};
type ProposalRow = {
  id: string; binding_id: string; source_event_id: string; digest: string; kind: GitProposal["kind"];
  payload_json: string; state: GitProposal["state"]; created_at_ms: number;
};

function remoteUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrainDomainError("INVALID_ARGUMENT", "Git remote must be an absolute HTTP(S) URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new BrainDomainError("FORBIDDEN", "Git remote requires HTTPS except for a loopback test service");
  if (url.username || url.password || url.search || url.hash) throw new BrainDomainError("INVALID_ARGUMENT", "Git remote cannot contain credentials, query or fragment");
  return url.toString().replace(/\/$/u, "");
}

function optionalSecret(value: unknown, field: string, minimumLength: number): string | undefined {
  if (value === undefined || value === "") return undefined;
  const text = String(value);
  if (text.length < minimumLength || text.length > 256 * 1024) throw new BrainDomainError("INVALID_ARGUMENT", `${field} must be bounded`);
  return text;
}

export class IntegrationService {
  private connection(actor: ActorContext, id: string): ConnectionRow {
    const row = this.store.control.prepare("SELECT * FROM git_connections WHERE id=? AND organization_id=?").get(id, actor.organizationId) as ConnectionRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "Git connection not found");
    return row;
  }

  constructor(private readonly store: Store) {}

  private pullRequestApi: PullRequestApi = new HostedPullRequestApi();
  /** Tests and embedders point the provider call somewhere else; production calls the API of the connection's own Git provider. */
  usePullRequestApi(api: PullRequestApi): void { this.pullRequestApi = api; }

  /** The newest verified write binding of a project repository of this workspace: where a pull request may be opened. */
  private pullRequestBinding(organizationId: string, workspaceId: string): (BindingRow & { provider: GitProvider; base_url: string; encrypted_credentials: string; connection_id: string; repositories_json: string }) | undefined {
    return this.store.control.prepare(`SELECT b.*, c.provider, c.base_url, c.encrypted_credentials, c.repositories_json FROM repository_bindings b JOIN git_connections c ON c.id=b.connection_id
      WHERE c.organization_id=? AND b.workspace_id=? AND b.kind='project' AND b.access='write' AND b.status='verified' AND c.status='verified' ORDER BY b.created_at_ms DESC LIMIT 1`).get(organizationId, workspaceId) as never;
  }

  /** A plain reason when this workspace cannot open pull requests yet, else undefined. */
  pullRequestTargetProblem(organizationId: string, workspaceId: string): string | undefined {
    return this.pullRequestBinding(organizationId, workspaceId) ? undefined : "this workspace has no verified Git repository it may write to (Administration > Integrations: connect a repository, then bind it to this workspace as a project with write access)";
  }

  /**
   * Opens a pull request in the workspace's bound project repository: a new branch with the proposed files, then the provider's request.
   * Runs only for an approved call (the caller holds a started permit). Returns the address; the token is never part of any result or error.
   */
  async openPullRequest(organizationId: string, workspaceId: string, input: { title: string; body: string; branch: string; files: readonly ProposedFile[] }): Promise<{ url: string; number: number; branch: string; commit: string }> {
    const binding = this.pullRequestBinding(organizationId, workspaceId);
    if (!binding) throw new BrainDomainError("FORBIDDEN", this.pullRequestTargetProblem(organizationId, workspaceId) ?? "no repository");
    const credentials = decryptGitCredentials(this.store.pepper, organizationId, binding.connection_id, binding.encrypted_credentials);
    const scrub = (message: string): string => (credentials.token ? message.split(credentials.token).join("[hidden]") : message);
    const repositories = JSON.parse(binding.repositories_json) as IntegrationRepository[];
    const base = repositories.find((repository) => repository.repositoryKey === binding.repository_key)?.defaultBranch ?? "main";
    try {
      const pushed = await pushProposalBranch(binding.repository_key, credentials, { base, head: input.branch, message: input.title, files: input.files });
      const opened = await this.pullRequestApi.open({ provider: binding.provider, remoteUrl: binding.repository_key, credentials, base, head: input.branch, title: input.title, body: input.body });
      return { url: opened.url, number: opened.number, branch: input.branch, commit: pushed.commitOid };
    } catch (error) {
      throw new BrainDomainError("INTERNAL_ERROR", scrub(error instanceof Error ? error.message : "the pull request could not be opened").slice(0, 300));
    }
  }

  /** Guided setup of a Git connection: what is done, what is next and why a step failed, in words an owner can act on. */
  private guide(actor: ActorContext, connectionId: string | undefined): JsonValue {
    type Step = { id: string; title: string; state: "done" | "todo" | "failed"; advice: string };
    const steps: Step[] = [];
    if (!connectionId) {
      steps.push({ id: "connect", title: "Add a Git connection", state: "todo", advice: "Choose the Git provider (GitHub, GitHub Enterprise, GitLab or Gitea), enter the repository address (https), a user name if your Git host asks for one, and an access token with permission to push branches and open pull requests. The token is stored encrypted and is never shown again." });
      return { ready: false, steps } as unknown as JsonValue;
    }
    const connection = this.connection(actor, connectionId);
    const repositories = JSON.parse(connection.repositories_json) as IntegrationRepository[];
    const bindings = (this.store.control.prepare("SELECT b.* FROM repository_bindings b WHERE b.connection_id=?").all(connectionId) as BindingRow[]);
    const verified = connection.status === "verified";
    steps.push({ id: "connect", title: "Git connection added", state: "done", advice: `Connected to ${connection.base_url} as ${gitProviderLabel(connection.provider)}; pull requests are opened through its API.` });
    steps.push({
      id: "verify", title: "Brain can reach the repository and the token is accepted",
      state: verified ? "done" : connection.status === "failed" ? "failed" : "todo",
      advice: verified ? "The repository answered and accepted the token." : connection.status === "failed" ? `Verification failed: ${connection.detail ?? "no detail"}. Check the address, that the token has not expired, and that it can read and push this repository, then choose Verify again.` : "Verification is running; it takes a few seconds.",
    });
    const repository = repositories[0];
    steps.push({
      id: "write", title: "The token may push", state: !verified ? "todo" : repository?.permissions.write ? "done" : "failed",
      advice: !verified ? "Waiting for verification." : repository?.permissions.write ? "The remote accepts pushes with this token." : "The token can read but not push. Create a token with write (repository contents) and pull request permission.",
    });
    const writeBinding = bindings.find((binding) => binding.kind === "project" && binding.access === "write");
    steps.push({
      id: "bind", title: "Repository bound to a workspace for pull requests",
      state: writeBinding?.status === "verified" ? "done" : writeBinding?.status === "failed" ? "failed" : "todo",
      advice: writeBinding?.status === "verified" ? "A workspace may open pull requests in this repository." : writeBinding ? `The binding is ${writeBinding.status}${writeBinding.detail ? `: ${writeBinding.detail}` : ""}.` : "Bind the repository to the workspace as a project with write access; that is what lets an approved call open a pull request.",
    });
    return { connectionId, ready: steps.every((step) => step.state === "done"), steps } as unknown as JsonValue;
  }

  private assertOrgRead(actor: ActorContext): void {
    if (!actor.scopes.includes("platform:read")) throw new BrainDomainError("FORBIDDEN", "integration administration requires platform:read");
  }

  private static connectionView(row: ConnectionRow): GitConnection {
    return {
      connectionId: row.id, organizationId: row.organization_id, name: row.name, provider: row.provider, repositoryUrl: row.base_url,
      status: row.status, ...(row.detail ? { detail: row.detail } : {}), createdBy: row.created_by,
      createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
      ...(row.last_verified_at_ms ? { lastVerifiedAt: iso(row.last_verified_at_ms) } : {}),
    };
  }

  private static bindingView(row: BindingRow): RepositoryBinding {
    return {
      bindingId: row.id, connectionId: row.connection_id, workspaceId: row.workspace_id, kind: row.kind,
      repositoryKey: row.repository_key, access: row.access, status: row.status,
      ...(row.detail ? { detail: row.detail } : {}), createdBy: row.created_by,
      createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
      ...(row.last_verified_at_ms ? { lastVerifiedAt: iso(row.last_verified_at_ms) } : {}),
    };
  }

  apply(actor: ActorContext, command: IntegrationCommand): string {
    switch (command.commandType) {
      case "integration.connect": return this.connect(actor, command.payload);
      case "integration.verify": return this.queueVerification(actor, String(command.payload["connectionId"]));
      case "integration.bind": return this.bind(actor, command.payload);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported integration command ${command.commandType}`);
    }
  }

  private connect(actor: ActorContext, payload: Readonly<Record<string, unknown>>): string {
    const id = this.store.id("git");
    const provider = parseGitProvider(payload["provider"]);
    const url = remoteUrl(String(payload["repositoryUrl"] ?? ""));
    checkProviderFitsHost(provider, new URL(url));
    const username = optionalSecret(payload["username"], "username", 1);
    const token = optionalSecret(payload["token"], "token", 8);
    const encrypted = encryptGitCredentials(this.store.pepper, actor.organizationId, id, { ...(username ? { username } : {}), ...(token ? { token } : {}) });
    this.store.inTx(this.store.control, () => {
      const now = this.store.now();
      this.store.control.prepare(`INSERT INTO git_connections(id,organization_id,name,provider,base_url,encrypted_credentials,status,repositories_json,remote_refs_json,created_by,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,'pending','[]','{}',?,?,?)`).run(id, actor.organizationId, String(payload["name"]), provider, url, encrypted, actor.actorId, now, now);
      this.store.emit(this.store.control, { organizationId: actor.organizationId, aggregateType: "integration", aggregateId: id, eventType: "integration.connected", payload: { connectionId: id } });
    });
    this.queueVerification(actor, id);
    return id;
  }

  private queueVerification(actor: ActorContext, connectionId: string): string {
    this.connection(actor, connectionId);
    this.store.inTx(this.store.control, () => {
      this.store.control.prepare("INSERT INTO verification_requests(id,connection_id,state,requested_at_ms) SELECT ?,?,'pending',? WHERE NOT EXISTS (SELECT 1 FROM verification_requests WHERE connection_id=? AND state='pending')")
        .run(this.store.id("verify"), connectionId, this.store.now(), connectionId);
      this.store.control.prepare("UPDATE git_connections SET status='pending',detail=NULL,updated_at_ms=? WHERE id=?").run(this.store.now(), connectionId);
    });
    return connectionId;
  }

  private bind(actor: ActorContext, payload: Readonly<Record<string, unknown>>): string {
    const connection = this.connection(actor, String(payload["connectionId"]));
    if (connection.status !== "verified") throw new BrainDomainError("CONFLICT", "verify the Git connection before binding repositories");
    const workspaceId = String(payload["workspaceId"]);
    const workspace = this.store.control.prepare("SELECT id FROM workspaces WHERE id=? AND organization_id=?").get(workspaceId, actor.organizationId);
    if (!workspace) throw new BrainDomainError("NOT_FOUND", "workspace not found");
    const kind = String(payload["kind"]);
    if (kind !== "configuration" && kind !== "project") throw new BrainDomainError("INVALID_ARGUMENT", "repository kind must be configuration or project");
    const access = String(payload["access"]);
    if (access !== "read" && access !== "write") throw new BrainDomainError("INVALID_ARGUMENT", "repository access must be read or write");
    const repositoryKey = String(payload["repositoryKey"]);
    const repositories = JSON.parse(connection.repositories_json) as IntegrationRepository[];
    if (!repositories.some((repository) => repository.repositoryKey === repositoryKey)) throw new BrainDomainError("FORBIDDEN", "repository is outside the verified connection remote");
    const id = this.store.id("binding");
    this.store.inTx(this.store.control, () => {
      const now = this.store.now();
      this.store.control.prepare(`INSERT INTO repository_bindings(id,connection_id,workspace_id,kind,repository_key,access,status,created_by,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,'pending',?,?,?)`).run(id, connection.id, workspaceId, kind, repositoryKey, access, actor.actorId, now, now);
      this.store.control.prepare("INSERT INTO verification_requests(id,connection_id,state,requested_at_ms) SELECT ?,?,'pending',? WHERE NOT EXISTS (SELECT 1 FROM verification_requests WHERE connection_id=? AND state='pending')")
        .run(this.store.id("verify"), connection.id, now, connection.id);
      this.store.emit(this.store.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "repositoryBinding", aggregateId: id, eventType: "integration.bound", payload: { bindingId: id, connectionId: connection.id, kind, repositoryKey, access } });
    });
    return id;
  }

  async verifyPending(): Promise<{ verified: number; failed: number }> {
    const requests = this.store.control.prepare("SELECT id,connection_id FROM verification_requests WHERE state='pending' ORDER BY requested_at_ms,id LIMIT 10").all() as Array<{ id: string; connection_id: string }>;
    let verified = 0;
    let failed = 0;
    for (const request of requests) {
      const connection = this.store.control.prepare("SELECT * FROM git_connections WHERE id=?").get(request.connection_id) as ConnectionRow | undefined;
      if (!connection) {
        this.store.control.prepare("UPDATE verification_requests SET state='failed',completed_at_ms=? WHERE id=?").run(this.store.now(), request.id);
        failed++;
        continue;
      }
      try {
        const credentials = decryptGitCredentials(this.store.pepper, connection.organization_id, connection.id, connection.encrypted_credentials);
        const client = protocolClient(connection.base_url, credentials);
        const snapshot = await client.discover();
        const bindings = this.store.control.prepare("SELECT * FROM repository_bindings WHERE connection_id=?").all(connection.id) as BindingRow[];
        const checked = new Map<string, RemoteSnapshot>();
        for (const binding of bindings) checked.set(binding.id, await client.verifyRepository(binding.repository_key));
        const previousRefs = JSON.parse(connection.remote_refs_json) as Record<string, string>;
        this.store.inTx(this.store.control, () => {
          const now = this.store.now();
          this.store.control.prepare("UPDATE git_connections SET status='verified',detail=NULL,repositories_json=?,remote_refs_json=?,last_verified_at_ms=?,updated_at_ms=? WHERE id=?")
            .run(JSON.stringify([snapshot.repository]), JSON.stringify(snapshot.refs), now, now, connection.id);
          for (const binding of bindings) {
            this.store.control.prepare("UPDATE repository_bindings SET status='verified',detail=NULL,last_verified_at_ms=?,updated_at_ms=? WHERE id=?").run(now, now, binding.id);
            this.store.emit(this.store.control, { organizationId: connection.organization_id, workspaceId: binding.workspace_id, aggregateType: "repositoryBinding", aggregateId: binding.id, eventType: "integration.verified", payload: { bindingId: binding.id, repositoryKey: binding.repository_key, access: binding.access } });
            if (connection.last_verified_at_ms) this.proposeRefChanges(connection, binding, previousRefs, snapshot.refs);
          }
          this.store.control.prepare("UPDATE verification_requests SET state='complete',completed_at_ms=? WHERE id=?").run(now, request.id);
        });
        verified++;
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 500) : "Git verification failed";
        this.store.inTx(this.store.control, () => {
          const now = this.store.now();
          this.store.control.prepare("UPDATE git_connections SET status='failed',detail=?,updated_at_ms=? WHERE id=?").run(detail, now, connection.id);
          this.store.control.prepare("UPDATE repository_bindings SET status='failed',detail=?,updated_at_ms=? WHERE connection_id=?").run(detail, now, connection.id);
          this.store.control.prepare("UPDATE verification_requests SET state='failed',completed_at_ms=? WHERE id=?").run(now, request.id);
        });
        failed++;
      }
    }
    return { verified, failed };
  }

  private proposeRefChanges(connection: ConnectionRow, binding: BindingRow, previous: Record<string, string>, current: Record<string, string>): void {
    for (const ref of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (ref === "HEAD") continue;
      const oldOid = previous[ref] ?? null;
      const newOid = current[ref] ?? null;
      if (oldOid === newOid) continue;
      const sourceEventId = `${ref}@${newOid ?? "deleted"}`;
      const digest = domainDigest("brain:git-ref-change:v1", { repositoryKey: binding.repository_key, ref, oldOid, newOid });
      const proposalId = this.store.id("proposal");
      const inserted = this.store.control.prepare("INSERT OR IGNORE INTO git_proposals(id,binding_id,source_event_id,digest,kind,payload_json,state,created_at_ms) VALUES (?,?,?,?,?,?,'proposed',?)")
        .run(proposalId, binding.id, sourceEventId, digest, binding.kind, JSON.stringify({ repositoryKey: binding.repository_key, ref, oldOid, newOid }), this.store.now());
      if (inserted.changes === 1) this.store.emit(this.store.control, { organizationId: connection.organization_id, workspaceId: binding.workspace_id, aggregateType: "gitProposal", aggregateId: proposalId, eventType: "integration.proposed", payload: { proposalId, bindingId: binding.id, sourceEventId, digest } });
    }
  }

  async publishConfiguration(actor: ActorContext, bindingId: string, documents: readonly import("../configuration/compiler").SourceDoc[], message: string): Promise<{ commitOid: string; documents: import("../configuration/compiler").SourceDoc[] }> {
    const row = this.store.control.prepare("SELECT b.*,c.organization_id,c.base_url,c.encrypted_credentials FROM repository_bindings b JOIN git_connections c ON c.id=b.connection_id WHERE b.id=? AND c.organization_id=?").get(bindingId, actor.organizationId) as (BindingRow & { organization_id: string; base_url: string; encrypted_credentials: string }) | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "repository binding not found");
    if (row.kind !== "configuration" || row.access !== "write" || row.status !== "verified") throw new BrainDomainError("FORBIDDEN", "configuration publication requires a verified write binding");
    const credentials = decryptGitCredentials(this.store.pepper, row.organization_id, row.connection_id, row.encrypted_credentials);
    return protocolClient(row.base_url, credentials).publishFiles(documents, message);
  }

  query(actor: ActorContext, queryType: string, resourceId?: string): JsonValue {
    this.assertOrgRead(actor);
    if (queryType === "integrations.list") {
      const connections = (this.store.control.prepare("SELECT * FROM git_connections WHERE organization_id=? ORDER BY name,id LIMIT 100").all(actor.organizationId) as ConnectionRow[]).map(IntegrationService.connectionView);
      const bindings = (this.store.control.prepare("SELECT b.* FROM repository_bindings b JOIN git_connections c ON c.id=b.connection_id WHERE c.organization_id=? ORDER BY b.created_at_ms DESC,b.id LIMIT 100").all(actor.organizationId) as BindingRow[]).map(IntegrationService.bindingView);
      const proposals = (this.store.control.prepare("SELECT p.* FROM git_proposals p JOIN repository_bindings b ON b.id=p.binding_id JOIN git_connections c ON c.id=b.connection_id WHERE c.organization_id=? ORDER BY p.created_at_ms DESC,p.id LIMIT 100").all(actor.organizationId) as ProposalRow[]).map((row): GitProposal => ({
        proposalId: row.id, bindingId: row.binding_id, sourceEventId: row.source_event_id, digest: row.digest,
        kind: row.kind, state: row.state, payload: JSON.parse(row.payload_json) as JsonValue, createdAt: iso(row.created_at_ms),
      }));
      return { connections, bindings, proposals } as unknown as JsonValue;
    }
    if (queryType === "integrations.guide") return this.guide(actor, resourceId);
    if (queryType === "integrations.repositories") {
      const connection = this.connection(actor, String(resourceId ?? ""));
      return { items: JSON.parse(connection.repositories_json) as IntegrationRepository[], status: connection.status, ...(connection.detail ? { detail: connection.detail } : {}) } as unknown as JsonValue;
    }
    throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `unsupported integration query ${queryType}`);
  }
}
