import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { GitConnection, GitProposal, IntegrationRepository, RepositoryBinding } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack, TechnicalDetails } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { RefreshButton } from "../../ui/components/primitives";
import { EmptyPreview, FactStrip, WorkspaceSection } from "../../ui/components/Domain";

interface IntegrationView {
  connections: GitConnection[];
  bindings: RepositoryBinding[];
  proposals: GitProposal[];
}

export default function IntegrationsPage(): JSX.Element {
  const app = useApp();
  const [name, setName] = createSignal("");
  const [repositoryUrl, setRepositoryUrl] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [token, setToken] = createSignal("");
  const [selectedConnection, setSelectedConnection] = createSignal("");
  const [repositoryKey, setRepositoryKey] = createSignal("");
  const [kind, setKind] = createSignal<"configuration" | "project">("configuration");
  const [access, setAccess] = createSignal<"read" | "write">("write");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const integrations = createScopedRead<IntegrationView>({
    scope: app.scope,
    load: async (_scope, signal) => {
      const response = await query<{ snapshot: IntegrationView; asOf: string; sourceWatermark: number }>({ queryType: "integrations.list" }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.connections.length === 0,
    refreshMs: 3000,
  });
  const repositories = createScopedRead<{ items: IntegrationRepository[]; status: GitConnection["status"]; detail?: string }>({
    scope: app.scope,
    load: async (_scope, signal) => {
      if (!selectedConnection()) return { snapshot: { items: [], status: "pending" }, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: IntegrationRepository[]; status: GitConnection["status"]; detail?: string }; asOf: string; sourceWatermark: number }>({ queryType: "integrations.repositories", resourceId: selectedConnection() }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
    refreshMs: 3000,
  });

  async function refresh(): Promise<void> {
    await Promise.all([integrations.refresh({ force: true }), repositories.refresh({ force: true })]);
  }

  async function connect(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const created = await app.run("integration.connect", { name: name().trim(), repositoryUrl: repositoryUrl().trim(), ...(username().trim() ? { username: username().trim() } : {}), ...(token() ? { token: token() } : {}) });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      setSelectedConnection(created.resourceId); setToken("");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Connection failed"); }
    finally { setBusy(false); }
  }

  async function verify(connectionId: string): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const verified = await app.run("integration.verify", { connectionId });
      if (!verified.accepted) throw new Error(verified.detail);
      setSelectedConnection(connectionId);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Verification failed"); }
    finally { setBusy(false); }
  }

  async function bind(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const bound = await app.run("integration.bind", { connectionId: selectedConnection(), workspaceId: app.workspaceId(), kind: kind(), repositoryKey: repositoryKey(), access: access() });
      if (!bound.accepted) throw new Error(bound.detail);
      setRepositoryKey("");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Repository binding failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Integrations" description="See which Git remotes are configured, verified and usable before binding them to workspace configuration or projects."
    actions={<RefreshButton onClick={() => void refresh()} />}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Integration action failed" description={error()} /></Show>
      <FactStrip label="Integration summary" items={[
        { label: "Connections", value: String(integrations.state().data?.connections.length ?? 0), hint: "Configured remotes", icon: "lucide-plug" },
        { label: "Verified", value: String(integrations.state().data?.connections.filter((connection) => connection.status === "verified").length ?? 0), hint: "Protocol refs and push negotiated", icon: "lucide-circle-check" },
        { label: "Bindings", value: String(integrations.state().data?.bindings.length ?? 0), hint: "Workspace repository relationships", icon: "lucide-link" },
        { label: "Ref proposals", value: String(integrations.state().data?.proposals.length ?? 0), hint: "Inert until separately reviewed", icon: "lucide-git-pull-request" },
      ]} />
      <div class="brain-studio-layout"><div class="brain-detail-stack">
        <WorkspaceSection title="Configured connections" description="Configured, authenticated and workflow-usable are different states. Verification uses the real server response.">
          <ScreenRegion state={integrations.state()} onRetry={() => void integrations.refresh()} emptyTitle="No Git connections" emptyDescription="Use the guided New Git remote flow. Credentials stay hidden after creation.">
            <div class="brain-queue"><For each={integrations.state().data?.connections}>{(connection) => <article class="border-b border-outline-gray-1 py-4">
              <div class="flex flex-wrap items-start justify-between gap-2"><div><h3 class="text-base-medium">{connection.name}</h3><p class="mt-1 break-all text-caption text-ink-gray-6">{connection.repositoryUrl}</p></div><StatusBadge kind="connection" status={connection.status} /></div>
              <dl class="mt-3 grid gap-3 text-interface sm:grid-cols-2"><div><dt class="text-caption text-ink-gray-6">Last checked</dt><dd class="mt-1"><Show when={connection.lastVerifiedAt} fallback="Not verified"><DateText value={connection.lastVerifiedAt} /></Show></dd></div><div><dt class="text-caption text-ink-gray-6">Authorized scope</dt><dd class="mt-1">Remote credentials encrypted; never returned to browser</dd></div></dl>
              <Show when={connection.detail}><Alert theme="red" variant="outline" title="Connection check failed" description={connection.detail} /></Show>
              <div class="mt-3 flex flex-wrap gap-2"><Button size="lg" variant="outline" disabled={busy()} onClick={() => void verify(connection.connectionId)}>Verify remote</Button><Button size="lg" variant="ghost" onClick={() => { setSelectedConnection(connection.connectionId); setRepositoryKey(""); void repositories.refresh({ force: true }); }}>Bind repository</Button></div>
            </article>}</For></div>
          </ScreenRegion>
        </WorkspaceSection>
        <Show when={selectedConnection()}><WorkspaceSection title="Bind a verified repository" description="Configuration and project bindings are separate authority classes. No binding activates a release or mutates Git.">
          <ScreenRegion state={repositories.state()} onRetry={() => void repositories.refresh()} emptyTitle="No verified remote" emptyDescription="Test the connection successfully to inspect protocol refs and push capability.">
            <div class="brain-field-grid"><Select label="Repository" value={repositoryKey()} options={(repositories.state().data?.items ?? []).map((repository) => ({ value: repository.repositoryKey, label: `${repository.displayName} · ${repository.defaultBranch}` }))} onValueChange={(value) => setRepositoryKey(value ?? "")} /><Select label="Binding class" value={kind()} options={[{ value: "configuration", label: "Configuration" }, { value: "project", label: "Project" }]} onValueChange={(value) => setKind((value ?? "configuration") as "configuration" | "project")} /><Select label="Required access" value={access()} options={[{ value: "read", label: "Read only" }, { value: "write", label: "Read and write" }]} onValueChange={(value) => setAccess((value ?? "read") as "read" | "write")} /><TextInput label="Workspace" value={app.workspaceId()} readonly /></div>
            <Button size="lg" theme="blue" disabled={busy() || !repositoryKey() || repositories.state().data?.status !== "verified"} onClick={() => void bind()}>Bind repository</Button>
          </ScreenRegion>
        </WorkspaceSection></Show>
        <WorkspaceSection title="Repository bindings" description="Meaningful target, scope and state for existing relationships.">
          <Show when={integrations.state().data?.bindings.length} fallback={<EmptyPreview icon="lucide-link" title="No repository bindings" description="Verify a connection and bind a repository to make it available to its intended workflow." />}><div class="brain-queue"><For each={integrations.state().data?.bindings}>{(binding) => <div class="border-b border-outline-gray-1 py-3"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="break-all">{binding.repositoryKey}</strong><StatusBadge kind="connection" status={binding.status} /></div><p class="mt-1 text-caption text-ink-gray-6">{binding.kind} · {binding.access} · {binding.workspaceId}</p><Show when={binding.detail}><p class="text-caption text-ink-red-7">{binding.detail}</p></Show></div>}</For></div></Show>
        </WorkspaceSection>
        <TechnicalDetails label="Git ref proposals"><Show when={integrations.state().data?.proposals.length} fallback={<p>No ref-change proposals yet.</p>}><ul class="flex flex-col gap-2"><For each={integrations.state().data?.proposals}>{(proposal) => <li class="text-caption"><strong>{proposal.kind} proposal</strong> · {proposal.sourceEventId}<p class="break-all text-ink-gray-6">{proposal.digest}</p></li>}</For></ul></Show></TechnicalDetails>
      </div><WorkspaceSection title="New Git remote" description="One connection per remote repository. Optional HTTP credentials are encrypted at rest and never returned.">
        <div class="brain-field-grid"><TextInput label="Connection name" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="Configuration repository" /><TextInput label="Remote repository URL" value={repositoryUrl()} onInput={(event) => setRepositoryUrl(event.currentTarget.value)} placeholder="https://git.example.test/team/brain.git" /><TextInput label="HTTP username (optional)" value={username()} onInput={(event) => setUsername(event.currentTarget.value)} /><TextInput label="HTTP token (optional)" type="password" value={token()} onInput={(event) => setToken(event.currentTarget.value)} /></div>
        <Alert theme="blue" variant="outline" title="Credential boundary" description="The token is used only for the server-side Git connection. It is not displayed again or shared with workflows without an explicit binding." />
        <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !name().trim() || !repositoryUrl().trim()} onClick={() => void connect()}>Connect remote</Button>
      </WorkspaceSection></div>
    </PageStack>
  </BrainPage>;
}
