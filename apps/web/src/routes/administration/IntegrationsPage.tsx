import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import type { GitConnection, GitProposal, IntegrationRepository, RepositoryBinding } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { RefreshButton } from "../../ui/components/primitives";

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
      const created = await app.run("integration.connect", {
        name: name().trim(), repositoryUrl: repositoryUrl().trim(),
        ...(username().trim() ? { username: username().trim() } : {}), ...(token() ? { token: token() } : {}),
      });
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
      const bound = await app.run("integration.bind", {
        connectionId: selectedConnection(), workspaceId: app.workspaceId(), kind: kind(), repositoryKey: repositoryKey(), access: access(),
      });
      if (!bound.accepted) throw new Error(bound.detail);
      setRepositoryKey("");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Repository binding failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Integrations" description="Connect Git remotes through the TypeScript Git protocol client, verify ref and push access, and bind configuration or project repositories without exposing credentials."
    actions={<RefreshButton onClick={() => void refresh()} />}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Integration action failed" description={error()} /></Show>
      <Section title="New Git remote" description="Each connection is one remote repository. Optional HTTP credentials are encrypted at rest and never returned to the browser." surface="card">
        <div class="brain-field-grid">
          <TextInput label="Connection name" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="Configuration repository" />
          <TextInput label="Remote repository URL" value={repositoryUrl()} onInput={(event) => setRepositoryUrl(event.currentTarget.value)} placeholder="https://git.example.test/team/brain.git" />
          <TextInput label="HTTP username (optional)" value={username()} onInput={(event) => setUsername(event.currentTarget.value)} />
          <TextInput label="HTTP token (optional)" type="password" value={token()} onInput={(event) => setToken(event.currentTarget.value)} />
        </div>
        <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !name().trim() || !repositoryUrl().trim()} onClick={() => void connect()}>Connect remote</Button>
      </Section>

      <Section title="Connections" description="Verification uses Git protocol refs and push negotiation, not a hosting provider's repository API." surface="card">
        <ScreenRegion state={integrations.state()} onRetry={() => void integrations.refresh()} emptyTitle="No Git connections" emptyDescription="Connect a remote above; credentials stay hidden after creation.">
          <div class="flex flex-col gap-3"><For each={integrations.state().data?.connections}>{(connection) => <article class="rounded-card border border-outline-gray-2 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div><strong>{connection.name}</strong><span class="ms-2 break-all text-caption text-ink-gray-6">{connection.repositoryUrl}</span></div>
              <StatusBadge kind="connection" status={connection.status} />
            </div>
            <Show when={connection.detail}><p class="mt-2 text-caption text-ink-red-7">{connection.detail}</p></Show>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy()} onClick={() => void verify(connection.connectionId)}>Verify remote</Button>
              <Button size="sm" variant="ghost" onClick={() => { setSelectedConnection(connection.connectionId); setRepositoryKey(""); void repositories.refresh({ force: true }); }}>Bind repository</Button>
            </div>
          </article>}</For></div>
        </ScreenRegion>
      </Section>

      <Show when={selectedConnection()}>
        <Section title="Bind a repository" description="Configuration and project bindings are separate authority classes. No binding activates a release or mutates Git." surface="card">
          <ScreenRegion state={repositories.state()} onRetry={() => void repositories.refresh()} emptyTitle="No verified remote" emptyDescription="Verify the connection to inspect its protocol refs and push capability.">
            <div class="brain-field-grid">
              <Select label="Repository" value={repositoryKey()} options={(repositories.state().data?.items ?? []).map((repository) => ({ value: repository.repositoryKey, label: `${repository.displayName} · ${repository.defaultBranch}` }))} onValueChange={(value) => setRepositoryKey(value ?? "")} />
              <Select label="Binding class" value={kind()} options={[{ value: "configuration", label: "Configuration" }, { value: "project", label: "Project" }]} onValueChange={(value) => setKind((value ?? "configuration") as "configuration" | "project")} />
              <Select label="Required access" value={access()} options={[{ value: "read", label: "Read only" }, { value: "write", label: "Read and write" }]} onValueChange={(value) => setAccess((value ?? "read") as "read" | "write")} />
              <TextInput label="Workspace" value={app.workspaceId()} readonly />
            </div>
            <Button size="lg" theme="blue" disabled={busy() || !repositoryKey() || repositories.state().data?.status !== "verified"} onClick={() => void bind()}>Bind repository</Button>
          </ScreenRegion>
        </Section>
      </Show>

      <div class="grid gap-4 xl:grid-cols-2">
        <Section title="Repository bindings" surface="card">
          <Show when={integrations.state().data?.bindings.length} fallback={<p class="text-ink-gray-7">No repositories bound yet.</p>}>
            <ul class="flex flex-col gap-2"><For each={integrations.state().data?.bindings}>{(binding) => <li class="rounded-control border border-outline-gray-2 p-3">
              <div class="flex flex-wrap items-center justify-between gap-2"><strong class="break-all">{binding.repositoryKey}</strong><StatusBadge kind="connection" status={binding.status} /></div>
              <p class="text-caption text-ink-gray-6">{binding.kind} · {binding.access} · {binding.workspaceId}</p>
              <Show when={binding.detail}><p class="text-caption text-ink-red-7">{binding.detail}</p></Show>
            </li>}</For></ul>
          </Show>
        </Section>
        <Section title="Git ref proposals" description="Verified ref transitions create inert proposals only. No direct active configuration change is possible here." surface="card">
          <Show when={integrations.state().data?.proposals.length} fallback={<p class="text-ink-gray-7">No ref-change proposals yet.</p>}>
            <ul class="flex flex-col gap-2"><For each={integrations.state().data?.proposals}>{(proposal) => <li class="rounded-control border border-outline-gray-2 p-3 text-caption">
              <strong>{proposal.kind} proposal</strong><span class="ms-2 text-ink-gray-6">{proposal.sourceEventId}</span>
              <p class="break-all text-ink-gray-6">{proposal.digest}</p>
            </li>}</For></ul>
          </Show>
        </Section>
      </div>
    </PageStack>
  </BrainPage>;
}
