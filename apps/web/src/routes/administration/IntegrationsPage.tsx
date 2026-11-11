import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Select, EmptyState } from "@talelk/newui-molecules";
import type { GitConnection, GitProposal, IntegrationRepository, RepositoryBinding } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack, TechnicalDetails } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { FormSheet } from "../../ui/components/BrainForm";
import { IconTile } from "../../ui/components/primitives";import { WorkspaceSection } from "../../ui/components/Domain";
import { StatGrid } from "@talelk/newui-organisms";
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
  const [connectOpen, setConnectOpen] = createSignal(false);
  const [attempted, setAttempted] = createSignal(false);
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

  /** Nothing connected yet: one explanation and one next step instead of four zeroes and two empty boxes. */
  const firstUse = () => integrations.state().status === "empty-authorized";

  async function refresh(): Promise<void> {
    await Promise.all([integrations.refresh({ force: true }), repositories.refresh({ force: true })]);
  }

  async function connect(): Promise<void> {
    setAttempted(true);
    if (busy() || !name().trim() || !repositoryUrl().trim()) return;
    setBusy(true); setError("");
    try {
      const created = await app.run("integration.connect", { name: name().trim(), repositoryUrl: repositoryUrl().trim(), ...(username().trim() ? { username: username().trim() } : {}), ...(token() ? { token: token() } : {}) });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      setToken(""); setAttempted(false); setConnectOpen(false);
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
      setRepositoryKey(""); setSelectedConnection("");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Repository binding failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Integrations" description="Connect Brain to your Git repositories, then bind a repository to a workspace so its workflows can use it. Credentials are stored encrypted and never shown again."
    actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={() => void refresh()}>Refresh</Button><Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => { setError(""); setConnectOpen(true); }}>Connect remote</Button></>}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Integration action failed" description={error()} /></Show>
      <Show when={firstUse()}><div class="flex flex-col items-center gap-3 rounded-card border border-outline-gray-1 bg-surface-elevation-1 px-4 py-10 text-center">
        <IconTile icon="lucide-plug" tone="gray" />
        <h2 class="text-base-medium">No repository is connected</h2>
        <p class="brain-readable max-w-xl text-interface text-ink-gray-7">Brain works without this. Connect a repository when you want a workspace's workflows to read project files, or when you want Brain to propose changes to your configuration for review. Nothing is ever pushed without your approval.</p>
        <ol class="max-w-xl list-decimal ps-5 text-start text-interface text-ink-gray-7"><li>Choose Connect remote and give the repository URL (and a token if it is private).</li><li>Verify it: Brain checks the real server response.</li><li>Bind a repository to a workspace so its workflows can use it.</li></ol>
        <Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => { setError(""); setConnectOpen(true); }}>Connect a repository</Button>
      </div></Show>
      <Show when={!firstUse()}><StatGrid compact stats={[
        { label: "Connections", value: String(integrations.state().data?.connections.length ?? 0), hint: "Configured remotes", icon: "lucide-plug" },
        { label: "Verified", value: String(integrations.state().data?.connections.filter((connection) => connection.status === "verified").length ?? 0), hint: "Tested and working", icon: "lucide-circle-check" },
        { label: "Bindings", value: String(integrations.state().data?.bindings.length ?? 0), hint: "Repositories linked to a workspace", icon: "lucide-link" },
        { label: "Proposed changes", value: String(integrations.state().data?.proposals.length ?? 0), hint: "Nothing is pushed until reviewed", icon: "lucide-git-pull-request" },
      ]} /></Show>
      <div class="brain-detail-stack">
        <Show when={!firstUse()}><WorkspaceSection title="Configured connections" description="Configured, authenticated and workflow-usable are different states. Verification uses the real server response.">
          <ScreenRegion state={integrations.state()} onRetry={() => void integrations.refresh()} emptyTitle="No Git connections" emptyDescription="Use Connect remote to add one. Credentials stay hidden after creation.">
            <div class="brain-queue"><For each={integrations.state().data?.connections}>{(connection) => <article class="flex gap-3 border-b border-outline-gray-1 py-3">
              <IconTile icon="lucide-git-branch" tone={connection.status === "verified" ? "green" : connection.status === "failed" ? "red" : "amber"} />
              <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-words text-base-medium">{connection.name}</h3><p class="mt-1 break-all text-caption text-ink-gray-6">{connection.repositoryUrl}</p></div><StatusBadge kind="connection" status={connection.status} /></div>
              <dl class="mt-2 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 text-interface"><div class="min-w-0"><dt class="text-caption text-ink-gray-6">Last checked</dt><dd class="mt-1"><Show when={connection.lastVerifiedAt} fallback="Not verified"><DateText value={connection.lastVerifiedAt} /></Show></dd></div><div class="min-w-0"><dt class="text-caption text-ink-gray-6">Authorized scope</dt><dd class="mt-1 break-words">Remote credentials encrypted; never returned to browser</dd></div></dl>
              <Show when={connection.detail}><div class="mt-3"><Alert theme="red" variant="outline" title="Connection check failed" description={connection.detail} /></div></Show>
              <div class="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy()} onClick={() => void verify(connection.connectionId)}>Verify remote</Button><Button size="sm" variant="ghost" onClick={() => { setSelectedConnection(connection.connectionId); setRepositoryKey(""); void repositories.refresh({ force: true }); }}>Bind repository</Button></div>
              </div>
            </article>}</For></div>
          </ScreenRegion>
        </WorkspaceSection></Show>
        <FormSheet open={Boolean(selectedConnection())} onClose={() => setSelectedConnection("")} title="Bind a verified repository" centered description="Configuration and project bindings are separate authority classes. No binding activates a release or mutates Git."
          submit="Bind repository" icon="lucide-link" busy={busy()} disabled={!repositoryKey() || repositories.state().data?.status !== "verified"} onSubmit={bind} error={error()} errorTitle="Repository binding failed">
          <ScreenRegion state={repositories.state()} onRetry={() => void repositories.refresh()} emptyTitle="No verified remote" emptyDescription="Test the connection successfully to inspect protocol refs and push capability.">
            <div class="flex flex-col gap-4"><Select label="Repository" value={repositoryKey()} options={(repositories.state().data?.items ?? []).map((repository) => ({ value: repository.repositoryKey, label: `${repository.displayName} · ${repository.defaultBranch}` }))} onValueChange={(value) => setRepositoryKey(value ?? "")} /><Select label="Binding class" value={kind()} options={[{ value: "configuration", label: "Configuration" }, { value: "project", label: "Project" }]} onValueChange={(value) => setKind((value ?? "configuration") as "configuration" | "project")} /><Select label="Required access" value={access()} options={[{ value: "read", label: "Read only" }, { value: "write", label: "Read and write" }]} onValueChange={(value) => setAccess((value ?? "read") as "read" | "write")} /><TextInput label="Workspace" value={app.workspaceId()} readonly /></div>
          </ScreenRegion>
        </FormSheet>
        <Show when={!firstUse()}><WorkspaceSection title="Repository bindings" description="Meaningful target, scope and state for existing relationships.">
          <Show when={integrations.state().data?.bindings.length} fallback={<EmptyState size="sm" icon="lucide-link" title="No repository bindings" description="Verify a connection and bind a repository to make it available to its intended workflow." />}><div class="brain-queue"><For each={integrations.state().data?.bindings}>{(binding) => <div class="min-w-0 border-b border-outline-gray-1 py-2.5"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="min-w-0 break-all">{binding.repositoryKey}</strong><StatusBadge kind="connection" status={binding.status} /></div><p class="mt-1 break-words text-caption text-ink-gray-6">{binding.kind} · {binding.access} · {binding.workspaceId}</p><Show when={binding.detail}><p class="mt-1 break-words text-caption text-ink-red-7">{binding.detail}</p></Show></div>}</For></div></Show>
        </WorkspaceSection>
        <TechnicalDetails label="Git ref proposals"><Show when={integrations.state().data?.proposals.length} fallback={<p>No ref-change proposals yet.</p>}><ul class="flex flex-col gap-2"><For each={integrations.state().data?.proposals}>{(proposal) => <li class="min-w-0 break-words text-caption"><strong>{proposal.kind} proposal</strong> · <span class="break-all">{proposal.sourceEventId}</span><p class="break-all text-ink-gray-6">{proposal.digest}</p></li>}</For></ul></Show></TechnicalDetails></Show>
      <FormSheet open={connectOpen()} onClose={() => setConnectOpen(false)} title="Connect a Git remote" centered description="One connection per remote repository. Optional HTTP credentials are encrypted at rest and never returned."
        submit="Connect remote" icon="lucide-plus" busy={busy()} onSubmit={connect} error={error()} errorTitle="Connection failed">
        <TextInput label="Connection name" value={name()} onInput={(event) => setName(event.currentTarget.value)} required error={attempted() && !name().trim() ? "Name this connection." : undefined} placeholder="Configuration repository" /><TextInput label="Remote repository URL" value={repositoryUrl()} onInput={(event) => setRepositoryUrl(event.currentTarget.value)} required error={attempted() && !repositoryUrl().trim() ? "Enter the remote repository URL." : undefined} placeholder="https://git.example.test/team/brain.git" /><TextInput label="HTTP username (optional)" value={username()} onInput={(event) => setUsername(event.currentTarget.value)} /><TextInput label="HTTP token (optional)" type="password" value={token()} onInput={(event) => setToken(event.currentTarget.value)} />
        <Alert theme="blue" variant="outline" title="Credential boundary" description="The token is used only for the server-side Git connection. It is not displayed again or shared with workflows without an explicit binding." />
      </FormSheet>
      </div>
    </PageStack>
  </BrainPage>;
}
