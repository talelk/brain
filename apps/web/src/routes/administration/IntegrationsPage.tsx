import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Select, EmptyState } from "@talelk/newui-molecules";
import type { GitConnection, GitProposal, GitProvider, IntegrationRepository, RepositoryBinding } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack, TechnicalDetails } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { FormSheet } from "../../ui/components/BrainForm";
import { IconTile } from "../../ui/components/primitives";import { WorkspaceSection } from "../../ui/components/Domain";
import { StatGrid } from "@talelk/newui-organisms";
import { GitGuideChecklist } from "../../ui/components/GitGuide";
import { WebhookEndpoints } from "../../ui/components/WebhookEndpoints";
import { t } from "../../i18n";
/** The Git providers Brain can open pull requests with; the owner picks one per connection, it is never worked out from the address. */
const PROVIDER_OPTIONS: ReadonlyArray<{ value: GitProvider; label: string }> = [
  { value: "github", label: "GitHub" }, { value: "github-enterprise", label: "GitHub Enterprise" }, { value: "gitlab", label: "GitLab" }, { value: "gitea", label: "Gitea" },
];
const providerLabel = (provider: GitProvider): string => PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;

interface IntegrationView {
  connections: GitConnection[];
  bindings: RepositoryBinding[];
  proposals: GitProposal[];
}

export default function IntegrationsPage(): JSX.Element {
  const app = useApp();
  const [name, setName] = createSignal("");
  const [provider, setProvider] = createSignal<GitProvider | "">("");
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
  });
  const repositories = createScopedRead<{ items: IntegrationRepository[]; status: GitConnection["status"]; detail?: string }>({
    scope: app.scope,
    load: async (_scope, signal) => {
      if (!selectedConnection()) return { snapshot: { items: [], status: "pending" }, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: IntegrationRepository[]; status: GitConnection["status"]; detail?: string }; asOf: string; sourceWatermark: number }>({ queryType: "integrations.repositories", resourceId: selectedConnection() }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
  });

  /** Nothing connected yet: one explanation and one next step instead of four zeroes and two empty boxes. */
  const firstUse = () => integrations.state().status === "empty-authorized";

  async function refresh(): Promise<void> {
    await Promise.all([integrations.refresh({ force: true }), repositories.refresh({ force: true })]);
  }

  async function connect(): Promise<void> {
    setAttempted(true);
    const chosen = provider();
    if (busy() || !name().trim() || !chosen || !repositoryUrl().trim()) return;
    setBusy(true); setError("");
    try {
      const created = await app.run("integration.connect", { name: name().trim(), provider: chosen, repositoryUrl: repositoryUrl().trim(), ...(username().trim() ? { username: username().trim() } : {}), ...(token() ? { token: token() } : {}) });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      setToken(""); setProvider(""); setAttempted(false); setConnectOpen(false);
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

  return <BrainPage title={t("adm.integrations.a788")} description={t("adm.connect-brain-to-your-git-reposi.7331")}
    actions={<Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => { setError(""); setConnectOpen(true); }}>{t("adm.connect-remote.d2cb")}</Button>}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title={t("adm.integration-action-failed.ec34")} description={error()} /></Show>
      <Show when={firstUse()}><div class="flex flex-col items-center gap-3 rounded-card border border-outline-gray-1 bg-surface-elevation-1 px-4 py-10 text-center">
        <IconTile icon="lucide-plug" tone="gray" />
        <h2 class="text-base-medium">{t("adm.no-repository-is-connected.5698")}</h2>
        <p class="brain-readable max-w-xl text-interface text-ink-gray-7">{t("adm.brain-works-without-this-connect.fa97")}</p>
        <ol class="max-w-xl list-decimal ps-5 text-start text-interface text-ink-gray-7"><li>{t("adm.git-provider.first-step")}</li><li>{t("adm.verify-it-brain-checks-the-real.6da6")}</li><li>{t("adm.bind-a-repository-to-a-workspace.f5e6")}</li></ol>
        <Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => { setError(""); setConnectOpen(true); }}>{t("adm.connect-a-repository.5b95")}</Button>
      </div></Show>
      <Show when={!firstUse()}><StatGrid compact stats={[
        { label: t("adm.connections.8f35"), value: String(integrations.state().data?.connections.length ?? 0), hint: t("adm.configured-remotes.f337"), icon: "lucide-plug" },
        { label: t("adm.verified.aed3"), value: String(integrations.state().data?.connections.filter((connection) => connection.status === "verified").length ?? 0), hint: t("adm.tested-and-working.950d"), icon: "lucide-circle-check" },
        { label: t("adm.bindings.9673"), value: String(integrations.state().data?.bindings.length ?? 0), hint: t("adm.repositories-linked-to-a-workspa.4061"), icon: "lucide-link" },
        { label: t("adm.proposed-changes.ef93"), value: String(integrations.state().data?.proposals.length ?? 0), hint: t("adm.nothing-is-pushed-until-reviewed.acf8"), icon: "lucide-git-pull-request" },
      ]} /></Show>
      <GitGuideChecklist connections={integrations.state().data?.connections ?? []} />
      <div class="brain-detail-stack">
        <Show when={!firstUse()}><WorkspaceSection title={t("adm.configured-connections.3cc7")} description={t("adm.configured-authenticated-and-wor.fa11")}>
          <ScreenRegion state={integrations.state()} onRetry={() => void integrations.refresh()} emptyTitle={t("adm.no-git-connections.fba9")} emptyDescription={t("adm.use-connect-remote-to-add-one-cr.2549")}>
            <div class="brain-queue"><For each={integrations.state().data?.connections}>{(connection) => <article class="flex gap-3 border-b border-outline-gray-1 py-3">
              <IconTile icon="lucide-git-branch" tone={connection.status === "verified" ? "green" : connection.status === "failed" ? "red" : "amber"} />
              <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-words text-base-medium">{connection.name}</h3><p class="mt-1 break-all text-caption text-ink-gray-6" data-git-provider={connection.provider}>{providerLabel(connection.provider)} · {connection.repositoryUrl}</p></div><StatusBadge kind="connection" status={connection.status} /></div>
              <dl class="mt-2 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 text-interface"><div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("adm.last-checked.ada1")}</dt><dd class="mt-1"><Show when={connection.lastVerifiedAt} fallback="Not verified"><DateText value={connection.lastVerifiedAt} /></Show></dd></div><div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("adm.authorized-scope.f42a")}</dt><dd class="mt-1 break-words">Remote credentials encrypted; never returned to browser</dd></div></dl>
              <Show when={connection.detail}><div class="mt-3"><Alert theme="red" variant="outline" title={t("adm.connection-check-failed.c5ce")} description={connection.detail} /></div></Show>
              <div class="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy()} onClick={() => void verify(connection.connectionId)}>{t("adm.verify-remote.de48")}</Button><Button size="sm" variant="ghost" onClick={() => { setSelectedConnection(connection.connectionId); setRepositoryKey(""); void repositories.refresh({ force: true }); }}>{t("adm.bind-repository.c836")}</Button></div>
              </div>
            </article>}</For></div>
          </ScreenRegion>
        </WorkspaceSection></Show>
        <FormSheet open={Boolean(selectedConnection())} onClose={() => setSelectedConnection("")} title={t("adm.bind-a-verified-repository.bebe")} centered description={t("adm.configuration-and-project-bindin.9a2a")}
          submit={t("adm.bind-repository.c836")} icon="lucide-link" busy={busy()} disabled={!repositoryKey() || repositories.state().data?.status !== "verified"} onSubmit={bind} error={error()} errorTitle={t("adm.repository-binding-failed.470f")}>
          <ScreenRegion state={repositories.state()} onRetry={() => void repositories.refresh()} emptyTitle={t("adm.no-verified-remote.2fca")} emptyDescription={t("adm.test-the-connection-successfully.7a8c")}>
            <div class="flex flex-col gap-4"><Select label={t("adm.repository.3123")} value={repositoryKey()} options={(repositories.state().data?.items ?? []).map((repository) => ({ value: repository.repositoryKey, label: `${repository.displayName} · ${repository.defaultBranch}` }))} onValueChange={(value) => setRepositoryKey(value ?? "")} /><Select label={t("adm.binding-class.2846")} value={kind()} options={[{ value: "configuration", label: t("adm.configuration.7541") }, { value: "project", label: t("adm.project.f6f4") }]} onValueChange={(value) => setKind((value ?? "configuration") as "configuration" | "project")} /><Select label={t("adm.required-access.fda3")} value={access()} options={[{ value: "read", label: t("adm.read-only.601d") }, { value: "write", label: t("adm.read-and-write.6106") }]} onValueChange={(value) => setAccess((value ?? "read") as "read" | "write")} /><TextInput label={t("adm.workspace.4ca0")} value={app.workspaceId()} readonly /></div>
          </ScreenRegion>
        </FormSheet>
        <Show when={!firstUse()}><WorkspaceSection title={t("adm.repository-bindings.8d6d")} description={t("adm.meaningful-target-scope-and-stat.5bb0")}>
          <Show when={integrations.state().data?.bindings.length} fallback={<EmptyState size="sm" icon="lucide-link" title={t("adm.no-repository-bindings.d92f")} description={t("adm.verify-a-connection-and-bind-a-r.101c")} />}><div class="brain-queue"><For each={integrations.state().data?.bindings}>{(binding) => <div class="min-w-0 border-b border-outline-gray-1 py-2.5"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="min-w-0 break-all">{binding.repositoryKey}</strong><StatusBadge kind="connection" status={binding.status} /></div><p class="mt-1 break-words text-caption text-ink-gray-6">{binding.kind} · {binding.access} · {binding.workspaceId}</p><Show when={binding.detail}><p class="mt-1 break-words text-caption text-ink-red-7">{binding.detail}</p></Show></div>}</For></div></Show>
        </WorkspaceSection>
        <TechnicalDetails label={t("adm.git-ref-proposals.4e17")}><Show when={integrations.state().data?.proposals.length} fallback={<p>{t("adm.no-ref-change-proposals-yet.f15e")}</p>}><ul class="flex flex-col gap-2"><For each={integrations.state().data?.proposals}>{(proposal) => <li class="min-w-0 break-words text-caption"><strong>{proposal.kind} proposal</strong> · <span class="break-all">{proposal.sourceEventId}</span><p class="break-all text-ink-gray-6">{proposal.digest}</p></li>}</For></ul></Show></TechnicalDetails></Show>
      <WebhookEndpoints />
      <FormSheet open={connectOpen()} onClose={() => setConnectOpen(false)} title={t("adm.connect-a-git-remote.a2d4")} centered description={t("adm.one-connection-per-remote-reposi.c69b")}
        submit={t("adm.connect-remote.d2cb")} icon="lucide-plus" busy={busy()} onSubmit={connect} error={error()} errorTitle={t("adm.connection-failed.202c")}>
        <TextInput label={t("adm.connection-name.5584")} value={name()} onInput={(event) => setName(event.currentTarget.value)} required error={attempted() && !name().trim() ? "Name this connection." : undefined} placeholder={t("adm.configuration-repository.6521")} />
        <Select label={t("adm.git-provider.label")} value={provider() || null} options={[...PROVIDER_OPTIONS]} placeholder={t("adm.git-provider.choose")} required description={t("adm.git-provider.hint")}
          error={attempted() && !provider() ? t("adm.git-provider.required") : false} onValueChange={(value) => setProvider((value ?? "") as GitProvider | "")} />
        <TextInput label={t("adm.remote-repository-url.9cc9")} value={repositoryUrl()} onInput={(event) => setRepositoryUrl(event.currentTarget.value)} required error={attempted() && !repositoryUrl().trim() ? "Enter the remote repository URL." : undefined} placeholder="https://git.example.test/team/brain.git" /><TextInput label={t("adm.http-username-optional.3a74")} value={username()} onInput={(event) => setUsername(event.currentTarget.value)} /><TextInput label={t("adm.http-token-optional.d8b0")} type="password" value={token()} onInput={(event) => setToken(event.currentTarget.value)} />
        <Alert theme="blue" variant="outline" title={t("adm.credential-boundary.3275")} description={t("adm.the-token-is-used-only-for-the-s.2188")} />
      </FormSheet>
      </div>
    </PageStack>
  </BrainPage>;
}
