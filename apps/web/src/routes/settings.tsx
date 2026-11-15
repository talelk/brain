import { DiagnosticExport } from "../ui/components/DiagnosticExport";
import { BrainForm } from "../ui/components/BrainForm";
import { LocalModelSetup } from "../ui/components/LocalModelSetup";
import { governor } from "../data/client";
import { useApp } from "../ui/app-context";
import { AuthenticatorEnrollment } from "../ui/components/Authentication";
import { PasskeyControls } from "../ui/components/PasskeyControls";
import { NotificationPreferences } from "../ui/components/NotificationPreferences";
import { PushDeviceControl } from "../ui/components/PushDevice";
import { WorkSettings } from "../ui/components/EngineAdmin";
import { ChatIdentities } from "../ui/components/ChatIdentities";
import { OrganizationAuthPolicy, OrganizationInvitations, OrganizationMemberSelect, OrganizationPeople } from "../ui/components/OrganizationAdmin";
import type { JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import { Badge, Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Pagination, Select, EmptyState, Timeline } from "@talelk/newui-molecules";
import { A, useSearchParams } from "@solidjs/router";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import type { AuditEntry, HealthView, MemberGrantView, ConfigExplanation, OrganizationSessionView } from "@brain/contracts";
import { DateText, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { formatDateTime, formatRelative } from "../ui/format";
import { sendTestEmail } from "../data/engine";
import { t, tn, tOr, type MessageKey } from "../i18n";
import { auditSentence } from "../ui/audit-text";
import { ActionFeedback } from "../ui/components/ActionFeedback";
import { Freshness, WorkspaceSection } from "../ui/components/Domain";import { StatusBadge, statusTheme } from "../ui/components/StatusBadge";
import { StatusIcon } from "../ui/viz/StatusIcon";
import { StatGrid } from "@talelk/newui-organisms";

const SETTINGS_PAGE_SIZE = 25;

const PAGE_KEYS: Readonly<Record<string, { title: MessageKey; description: MessageKey }>> = {
  setup: { title: "admin.page.setup.title", description: "admin.page.setup.description" },
  security: { title: "admin.page.security.title", description: "admin.page.security.description" },
  people: { title: "admin.page.people.title", description: "admin.page.people.description" },
  invitations: { title: "admin.page.invitations.title", description: "admin.page.invitations.description" },
  policy: { title: "admin.page.policy.title", description: "policy.page.description" },
  work: { title: "work.page.title", description: "work.page.description" },
  health: { title: "admin.page.health.title", description: "admin.page.health.description" },
  members: { title: "admin.page.members.title", description: "admin.page.members.description" },
  release: { title: "admin.page.release.title", description: "admin.page.release.description" },
};

export function SettingsScreen(props: {
  workspaceId: string;
  members: MemberGrantView[];
  audit: AuditEntry[];
  health?: HealthView;
  explanation?: ConfigExplanation;
  state: ScreenState<{ members: MemberGrantView[]; audit: AuditEntry[]; health?: HealthView }>;
  onRefresh: () => void;
  canAdminister: boolean;
  onGrant: (principalId: string, role: string, reason: string) => Promise<void>;
  onRevoke: (principalId: string, role: string, reason: string) => Promise<void>;
  onActivate: (configDigest: string, expectedActiveDigest: string | null) => Promise<void>;
  activeConfigDigest?: string;
  viewerId?: string;
  viewerName?: string;
}): JSX.Element {
  const app = useApp();
  const organizationAdmin = () => Boolean(app.identity()?.actor.scopes.includes("config:activate"));
  const identityAdmin = () => Boolean(app.identity()?.actor.scopes.includes("identity:read"));
  const [searchParams] = useSearchParams();
  const tab = () => typeof searchParams.tab === "string" ? searchParams.tab : "security";
  const [accessOpen, setAccessOpen] = createSignal(false);
  const [principalId, setPrincipalId] = createSignal("");
  const [role, setRole] = createSignal("viewer");
  const [reason, setReason] = createSignal("");
  const [memberPage, setMemberPage] = createSignal(1);
  const [auditPage, setAuditPage] = createSignal(1);
  const principalName = (member: MemberGrantView) => member.displayName ?? (member.principalId === props.viewerId ? props.viewerName : undefined) ?? "Person without a name on file";
  const page = () => { const keys = PAGE_KEYS[tab()] ?? PAGE_KEYS["security"]!; return { title: t(keys.title), description: t(keys.description) }; };
  const memberPageCount = () => Math.max(1, Math.ceil(props.members.length / SETTINGS_PAGE_SIZE));
  const currentMemberPage = () => Math.min(memberPage(), memberPageCount());
  const memberRows = () => props.members.slice((currentMemberPage() - 1) * SETTINGS_PAGE_SIZE, currentMemberPage() * SETTINGS_PAGE_SIZE);
  const auditPageCount = () => Math.max(1, Math.ceil(props.audit.length / SETTINGS_PAGE_SIZE));
  const currentAuditPage = () => Math.min(auditPage(), auditPageCount());
  const auditRows = () => props.audit.slice((currentAuditPage() - 1) * SETTINGS_PAGE_SIZE, currentAuditPage() * SETTINGS_PAGE_SIZE);
  return <BrainPage title={page().title} description={page().description}>
    <PageStack>
      <Show when={tab() === "setup" && organizationAdmin()}><LocalModelSetup /></Show>
      <Show when={tab() === "security"}><SecurityPage /></Show>
      <Show when={tab() === "people" && identityAdmin()}><OrganizationPeople /><ChatIdentities /></Show>
      <Show when={tab() === "invitations" && identityAdmin()}><OrganizationInvitations /></Show>
      <Show when={tab() === "policy" && identityAdmin()}><OrganizationAuthPolicy /></Show>
      <Show when={tab() === "work" && organizationAdmin()}><WorkSettings /></Show>
      <Show when={tab() === "health"}><PageStack>
                <HealthVerdict health={props.health} />
        <WorkspaceSection title={t("health.services.title")} description={t("health.services.description")}>
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle={t("health.unavailable.title")} emptyDescription={t("health.unavailable.description")} onRetry={props.onRefresh}>
            <div class="grid gap-3 md:grid-cols-2"><For each={props.health?.services ?? []}>{(service) => <article class="min-w-0 border-y border-outline-gray-1 py-3"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="flex min-w-0 items-center gap-2 break-words text-base-medium"><StatusIcon state={service.status} theme={statusTheme("health", service.status)} class="size-4" />{serviceName(service.id)}</h3><StatusBadge kind="health" status={service.status} /></div><p class="mt-1.5 break-words text-interface text-ink-gray-7">{service.detail}</p><p class="mt-1.5 text-caption text-ink-gray-6">{t("health.checked", { when: "" })}<DateText value={service.checkedAt} /></p><Show when={service.id === "email" && service.status !== "disabled"}><EmailTest /></Show></article>}</For></div>
            
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title={t("health.activity.title")} description={t("health.activity.description")}>
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle={t("health.activity.empty.title")} emptyDescription={t("health.activity.empty.description")} onRetry={props.onRefresh}>
            <Show when={props.audit.length === 0}><p class="brain-empty-inline">{t("health.activity.empty.title")}. {t("health.activity.empty.description")}</p></Show>
            <Timeline items={auditRows().map((entry) => ({ id: String(entry.cursor), title: <span class="block whitespace-normal break-words">{auditSentence(entry)}</span>, description: <span class="break-words" title={entry.resourceId}>{entry.actingFor ? t("health.activity.by-agent", { name: app.personName(entry.actingFor) }) : t("health.activity.by", { name: app.personName(entry.actorId) })}</span>, timestamp: <span class="whitespace-nowrap"><DateText value={entry.occurredAt} /></span>, icon: "lucide-history" }))} />
            <Show when={auditPageCount() > 1}><Pagination.Root aria-label={t("health.activity.pagination")} class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={props.audit.length} pageSize={SETTINGS_PAGE_SIZE} page={currentAuditPage()} onPageChange={setAuditPage}>
              <Pagination.Range />
              <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
            </Pagination.Root></Show>
          </ScreenRegion>
        </WorkspaceSection>
        <Show when={organizationAdmin()}><DiagnosticExport /></Show>
      </PageStack></Show>
      <Show when={tab() === "members"}><WorkspaceSection title={t("adm.who-has-access.b825")} description={t("adm.being-in-the-organization-does-n.8ff7")} actions={props.canAdminister ? <Button variant="solid" theme="blue" iconLeft="lucide-user-plus" onClick={() => setAccessOpen(true)}>{t("adm.manage-access.a86d")}</Button> : undefined}>
        <RoleLegend />
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle={t("adm.nobody-has-access-yet.0c8b")} emptyDescription={t("adm.use-manage-access-to-give-someon.cf98")} onRetry={props.onRefresh}>
          <div class="grid gap-3 md:grid-cols-2"><For each={memberRows()}>{(member) => <article class="min-w-0 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-words text-base-medium">{principalName(member)}</h3><p class="mt-0.5 break-all text-caption text-ink-gray-6">{member.email ?? `ID ${member.principalId}`}</p></div><StatusBadge status={member.revoked ? "revoked" : "active"} /></div><div class="mt-2 flex flex-wrap gap-1.5"><For each={member.roles}>{(role) => <Badge variant="outline" theme="blue" label={role} />}</For></div><dl class="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 text-caption"><div class="min-w-0"><dt class="text-ink-gray-6">{t("adm.granted.43b1")}</dt><dd class="mt-0.5 break-words"><DateText value={member.createdAt} /></dd></div><div class="min-w-0"><dt class="text-ink-gray-6">{t("adm.status.bae7")}</dt><dd class="mt-0.5">{member.revoked ? t("adm.access-revoked.7d42") : t("adm.has-access.c3ed")}</dd></div></dl></article>}</For></div>
          <Show when={memberPageCount() > 1}><Pagination.Root aria-label={t("adm.workspace-access-pagination.98da")} class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={props.members.length} pageSize={SETTINGS_PAGE_SIZE} page={currentMemberPage()} onPageChange={setMemberPage}>
            <Pagination.Range />
            <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
          </Pagination.Root></Show>
        </ScreenRegion>
      </WorkspaceSection></Show>
      <Show when={tab() === "release" && searchParams.from === "today"}><p class="m-0"><A href={`/w/${props.workspaceId}/today`} class="inline-flex min-h-8 items-center gap-1 text-interface font-medium text-ink-blue-8 hover:underline"><span class="lucide-arrow-left size-4" aria-hidden="true" />{t("adm.back-to-today-when-you-are-done.98f2")}</A></p></Show>
      <Show when={tab() === "release"}><WorkspaceSection title={t("adm.active-and-available-releases.a25b")} description={t("adm.pick-a-release-check-what-is-in.4dbd")}><Show when={organizationAdmin()} fallback={<p class="text-interface text-ink-gray-7">{t("adm.only-an-organization-administrat.6266")}</p>}><InspectRelease activeConfigDigest={props.activeConfigDigest} onActivate={props.onActivate} /></Show></WorkspaceSection></Show>
      <Show when={tab() === "release" && organizationAdmin() && props.explanation}><TechnicalDetails label={t("adm.where-the-workflow-settings-come.de8e")}><PageStack><Show when={props.explanation}><div class="grid gap-3 lg:grid-cols-2"><KeyValue label={t("adm.pointer.bc5d")} value={<span class="break-all">{props.explanation!.pointer}</span>} /><KeyValue label={t("adm.active-digest.8341")} value={<code class="break-all">{props.explanation!.configDigest}</code>} orientation="vertical" /><For each={props.explanation!.sources}>{(source) => <KeyValue label={`Rule (${source.rule})`} value={<span class="break-all">{source.path}:{source.line}</span>} orientation="vertical" />}</For></div></Show></PageStack></TechnicalDetails></Show>
      <Show when={tab() === "security"}><WorkspaceSection title={t("adm.notifications.753a")} description={t("adm.attention-hints-never-replace-si.e9dc")}><PushDeviceControl /><NotificationPreferences /></WorkspaceSection></Show>
      <Dialog.Root open={accessOpen()} onOpenChange={setAccessOpen}><Dialog.Content size="md"><Dialog.Header><Dialog.Title>{t("adm.manage-workspace-access.12c3")}</Dialog.Title><Dialog.Description>{t("adm.grant-or-revoke-one-role-for-an.071c")}</Dialog.Description></Dialog.Header><BrainForm bare label={t("adm.manage-workspace-access.12c3")} onSubmit={() => { if (principalId().trim() && reason().trim()) { void props.onGrant(principalId().trim(), role(), reason().trim()); setAccessOpen(false); } }}><div class="my-3 flex flex-col gap-3"><OrganizationMemberSelect value={principalId()} onChange={setPrincipalId} /><Select label={t("adm.role.c3f1")} value={role()} options={[{ value: "viewer", label: t("adm.viewer.dbad") }, { value: "operator", label: t("adm.operator.d0e6") }, { value: "workspace-lead", label: t("adm.workspace-lead.897b") }, { value: "approver", label: t("adm.approver.f18f") }]} onValueChange={(value) => setRole(value ?? "viewer")} /><TextInput label={t("adm.reason.f219")} required value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /><Alert theme="amber" variant="outline" title={t("adm.scope-and-consequence.bc9a")} description={`${role()} access applies to workspace ${props.workspaceId}. Revocation stops new reads and writes; it does not delete organization membership.`} /></div><Dialog.Footer class="flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setAccessOpen(false)}>{t("adm.cancel.77df")}</Button><Button variant="outline" theme="red" disabled={!principalId().trim() || !reason().trim()} onClick={() => { void props.onRevoke(principalId().trim(), role(), reason().trim()); setAccessOpen(false); }}>{t("adm.revoke.0be7")}</Button><Button type="submit" variant="solid" theme="blue" disabled={!principalId().trim() || !reason().trim()}>{t("adm.grant.c023")}</Button></Dialog.Footer></BrainForm></Dialog.Content></Dialog.Root>
    </PageStack>
  </BrainPage>;
}

const serviceName = (id: string): string => tOr(`health.service.${id.toLowerCase()}`, id.replace(/[-_]/gu, " "));

/** A test email to the signed-in person: Brain's email service is judged by how the last delivery went. */
function EmailTest(): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; text: string }>();
  async function send(): Promise<void> {
    if (busy()) return;
    setBusy(true); setResult(undefined);
    try {
      const sent = await sendTestEmail();
      setResult(sent.sent ? { ok: true, text: t("health.email.sent") } : { ok: false, text: t("health.email.failed", { reason: sent.reason }) });
    } catch (cause) { setResult({ ok: false, text: t("health.email.failed", { reason: cause instanceof Error ? cause.message : "" }) }); } finally { setBusy(false); }
  }
  return <div class="mt-2 flex flex-col items-start gap-1.5" data-email-test>
    <Button size="sm" variant="outline" iconLeft="lucide-mail" loading={busy()} disabled={busy()} onClick={() => void send()}>{t("health.email.test")}</Button>
    <Show when={result()}>{(outcome) => <p role={outcome().ok ? "status" : "alert"} class={`m-0 text-caption ${outcome().ok ? "text-ink-green-8" : "text-ink-red-8"}`}>{outcome().text}</p>}</Show>
  </div>;
}

/** One overall verdict before any detail: healthy, needs a look, or unknown. Disabled optional services do not count against it. */
function HealthVerdict(props: { health?: HealthView }): JSX.Element {
  const verdict = () => {
    const health = props.health;
    if (!health) return { theme: "gray" as const, title: t("health.verdict.unknown.title"), text: t("health.verdict.unknown.text") };
    const bad = health.services.filter((service) => service.status !== "healthy" && service.status !== "disabled");
    if (health.status === "healthy" && bad.length === 0) return { theme: "green" as const, title: t("health.verdict.ok.title"), text: t("health.verdict.ok.text", { n: health.services.length }) };
    return { theme: "amber" as const, title: t("health.verdict.attention.title"), text: `${bad.length ? `${tn("health.verdict.notHealthy", bad.length, { names: bad.map((service) => serviceName(service.id)).join(", ") })} ` : ""}${health.pendingOutbox > 0 ? `${t("health.verdict.outbox", { n: health.pendingOutbox, seconds: Math.round(health.oldestOutboxAgeMs / 1000) })} ` : ""}${t("health.verdict.details")}` };
  };
  return <Alert theme={verdict().theme} variant="outline" title={verdict().title} description={verdict().text} />;
}

const ROLE_HELP: [string, string][] = [
  ["Viewer", "can read missions, outputs and logs"],
  ["Operator", "can also start, steer and stop work"],
  ["Approver", "can approve or reject actions that ask for it"],
  ["Workspace lead", "can also manage who has access"],
];

function RoleLegend(): JSX.Element {
  return <dl class="mb-3 grid gap-x-6 gap-y-1 text-caption text-ink-gray-7 sm:grid-cols-2" aria-label={t("adm.what-each-role-can-do.679a")}><For each={ROLE_HELP}>{([name, text]) => <div><dt class="inline font-medium text-ink-gray-9">{name}</dt> <dd class="inline">{text}</dd></div>}</For></dl>;
}

const KIND_LABEL: Record<string, string> = { Workflow: "Workflows", Agent: "Agents", Tool: "Tools", Evaluator: "Checks", Policy: "Policies", Workspace: "Workspaces", WorkspaceType: "Workspace types", RunnerGroup: "Runner groups" };
function ReleaseContents(props: { documents: { id: string; kind: string }[] }): JSX.Element {
  const groups = () => {
    const byKind = new Map<string, string[]>();
    for (const document of props.documents) byKind.set(document.kind, [...byKind.get(document.kind) ?? [], document.id]);
    return [...byKind.entries()].map(([kind, ids]) => ({ label: KIND_LABEL[kind] ?? kind, ids: ids.sort() })).sort((x, y) => x.label.localeCompare(y.label));
  };
  return <dl class="mt-2 grid gap-3 sm:grid-cols-2"><For each={groups()}>{(group) => <div class="min-w-0"><dt class="text-interface font-medium text-ink-gray-9">{group.label} ({group.ids.length})</dt><dd class="break-words text-caption text-ink-gray-7">{group.ids.join(", ")}</dd></div>}</For></dl>;
}

type StoredPolicy = {
  layers: string[]; provenance: Record<string, string>;
  effective: { allowedOperations: string[] | null; deniedOperations: string[]; maxRuntimeSeconds: number | null; minimumIsolation: string; separationOfDuties: boolean; productionHumanApproval: string };
};

/** The policy a release carries (ADR 0064): what each rule is now, and the layer that set it. */
function ReleasePolicy(props: { policy: StoredPolicy | null | undefined }): JSX.Element {
  const rows = (policy: StoredPolicy): Array<{ id: string; label: string; value: string; layer: string | undefined }> => {
    const effective = policy.effective;
    return [
      { id: "allowed", label: t("release.policy.allowed"), value: effective.allowedOperations === null ? t("release.policy.allowedAny") : effective.allowedOperations.length ? effective.allowedOperations.join(", ") : t("release.policy.allowedNone"), layer: policy.provenance["allowedOperations"] },
      { id: "denied", label: t("release.policy.denied"), value: effective.deniedOperations.length ? effective.deniedOperations.join(", ") : t("release.policy.deniedNone"), layer: policy.provenance["deniedOperations"] },
      { id: "runtime", label: t("release.policy.runtime"), value: effective.maxRuntimeSeconds === null ? t("release.policy.runtimeNone") : t("release.policy.runtimeSeconds", { seconds: effective.maxRuntimeSeconds }), layer: policy.provenance["maxRuntimeSeconds"] },
      { id: "isolation", label: t("release.policy.isolation"), value: effective.minimumIsolation, layer: policy.provenance["minimumIsolation"] },
      { id: "production", label: t("release.policy.production"), value: t("release.policy.productionValue"), layer: policy.provenance["productionHumanApproval"] },
      { id: "duties", label: t("release.policy.duties"), value: effective.separationOfDuties ? t("release.policy.dutiesOn") : t("release.policy.dutiesOff"), layer: policy.provenance["separationOfDuties"] },
    ];
  };
  return <div class="border-y border-outline-gray-1 py-3" data-release-policy>
    <h3 class="text-base-medium">{t("release.policy.title")}</h3>
    <Show when={props.policy} fallback={<p class="mt-2 text-interface text-ink-gray-7">{t("release.policy.none")}</p>}>{(policy) => <>
      <p class="mt-2 break-words text-caption text-ink-gray-7">{t("release.policy.layers")}: {policy().layers.join(" → ")}</p>
      <dl class="mt-2 grid gap-3 sm:grid-cols-2"><For each={rows(policy())}>{(row) => <div class="min-w-0" data-policy-rule={row.id}><dt class="text-interface font-medium text-ink-gray-9">{row.label}</dt><dd class="break-words text-caption text-ink-gray-7">{row.value}{row.layer ? <span class="block text-ink-gray-6">{t("release.policy.setBy", { layer: row.layer })}</span> : null}</dd></div>}</For></dl>
    </>}</Show>
  </div>;
}

function InspectRelease(props: { activeConfigDigest?: string; onActivate: (digest: string, expectedActiveDigest: string | null) => Promise<void> }) {
  type ReleaseSummary = { digest: string; sourceRevision: string; createdAt: string; active: boolean; agents: number; workflows: number; assets: number };
  const [digest, setDigest] = createSignal("");
  const [releases, setReleases] = createSignal<ReleaseSummary[]>([]);
  const [inspection, setInspection] = createSignal<{ digest: string; expectedActiveDigest: string | null; manifest: { documents?: { id: string; kind: string; path: string }[]; effectivePolicy?: StoredPolicy | null } }>();
  const [error, setError] = createSignal<{ text: string; tone: "error" | "success" }>(); const [busy, setBusy] = createSignal(false);
  async function loadReleases() {
    try { const result = await governor<{ items: ReleaseSummary[] }>("/v1/config/releases"); setReleases(result.items); if (!digest() && result.items[0]) setDigest(result.items[0].digest); }
    catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Could not list releases. Press Refresh to try again.", tone: "error" }); }
  }
  onMount(() => void loadReleases());
  async function inspect() {
    setBusy(true); setInspection(undefined);
    try { setInspection(await governor(`/v1/config/releases/${encodeURIComponent(digest())}`)); }
    catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Could not open this release. Press Refresh and pick it again.", tone: "error" }); }
    finally { setBusy(false); }
  }
  const current = () => releases().find((release) => release.digest === digest());
  const active = () => releases().find((release) => release.active);
  return <PageStack>
    <StatGrid compact stats={[
      { label: t("adm.active-release.7ccf"), value: <span title={active()?.sourceRevision} class="text-base">{active() ? `${active()!.workflows} workflows · ${active()!.agents} agents` : "None yet"}</span>, hint: active() ? `Compiled ${formatRelative(active()!.createdAt)}` : "New work cannot start until one is activated", icon: "lucide-rocket" },
      { label: t("adm.available.7c62"), value: String(releases().length), hint: t("adm.compiled-releases-ready-to-inspe.0406"), icon: "lucide-package" },
      { label: t("adm.selected.9a97"), value: current()?.active ? "Already active" : current() ? t("adm.not-active.c1a5") : t("adm.none.6eef"), hint: current() ? `${current()!.workflows} workflows · ${current()!.agents} agents` : "Choose a release below", icon: "lucide-scan-search" },
    ]} />
    <div class="grid gap-2 border-y border-outline-gray-1 py-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end"><Select label={t("adm.release.d41f")} value={digest() || null} options={releases().map((release) => ({ value: release.digest, label: `${formatDateTime(release.createdAt)} · ${release.workflows} workflows, ${release.agents} agents${release.active ? " (active)" : ""}`, description: `Build ${release.digest.replace(/^sha256:/u, "").slice(0, 8)}` }))} onValueChange={(value) => { setDigest(value ?? ""); setInspection(undefined); }} /><Button size="sm" variant="outline" class="justify-self-start" onClick={() => void loadReleases()}>{t("adm.refresh.56e3")}</Button><Button variant="outline" class="justify-self-start" onClick={() => void inspect()} disabled={!digest() || busy()} loading={busy()}>{t("adm.see-what-is-inside.ead7")}</Button></div>
    <Show when={current()}>{(release) => <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-7"><span class="min-w-0 break-all" title={release().sourceRevision}>Source version {release().sourceRevision.replace(/^sha256:/u, "").slice(0, 12)}</span><span>{release().assets} supporting files</span><Freshness value={release().createdAt} label={t("adm.compiled.1487")} /></div>}</Show>
    <Show when={!releases().length && !error()}><EmptyState size="sm" icon="lucide-package" title={t("adm.no-releases-compiled-yet.392c")} description={t("adm.compile-the-starter-directory-wi.6d93")} /></Show>
    <Show when={inspection()} keyed>{(release) => <PageStack><div class="border-y border-outline-gray-1 py-3"><h3 class="text-base-medium">{t("adm.what-this-release-contains.0f70")}</h3><ReleaseContents documents={release.manifest.documents ?? []} /></div><ReleasePolicy policy={release.manifest.effectivePolicy} /><TechnicalDetails label={t("adm.technical-details-manifest-and-d.71b7")}><p class="break-all">{release.digest}</p><pre class="brain-readable mt-3 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all text-caption">{JSON.stringify(release.manifest, null, 2)}</pre></TechnicalDetails><Alert theme="amber" variant="outline" title={t("adm.activating-changes-what-new-work.0cd4")} description={t("adm.new-missions-and-tasks-will-use.d2a1")} /><Button variant="solid" theme="blue" iconLeft="lucide-check" class="self-start" disabled={busy()} onClick={async () => { setBusy(true); setError(undefined); try { await props.onActivate(release.digest, release.expectedActiveDigest); setInspection(undefined); setError({ text: t("adm.this-release-is-now-active-new-w.b902"), tone: "success" }); await loadReleases(); } catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Activation failed. Press Refresh, check which release is active, and try again.", tone: "error" }); } finally { setBusy(false); } }}>{t("adm.activate-this-release.d2b6")}</Button></PageStack>}</Show>
    <ActionFeedback tone={error()?.tone} message={error()?.text} title={error()?.tone === "success" ? "Release active" : undefined} />
    <TechnicalDetails label={t("adm.compile-a-new-release.b8b5")}><p>{t("adm.run-this-on-the-server-then-refr.208d")}</p><code class="mt-2 block break-all">brain config compile examples/v1/starter-release</code></TechnicalDetails>
  </PageStack>;
}

function SecurityPage() {
  const app = useApp(); const [enrollOpen, setEnrollOpen] = createSignal(false); const [password, setPassword] = createSignal(""); const [message, setMessage] = createSignal(""); const [failed, setFailed] = createSignal(false);
  return <PageStack>
    <PageStack><StatGrid compact stats={[
      { label: t("adm.authenticator.4853"), value: app.identity()?.totpEnrolled ? t("adm.enrolled.41d2") : t("adm.not-enrolled.1268"), hint: app.identity()?.requireTwoFactor ? t("adm.required-by-organization-policy.30db") : t("adm.optional-for-sign-in.8818"), icon: "lucide-shield-check" },
      { label: t("adm.approving-actions.7a94"), value: app.identity()?.requireTwoFactor ? t("adm.authenticator-code.2908") : t("adm.confirm-again.dcf2"), hint: t("adm.you-confirm-each-action-before-i.314b"), icon: "lucide-key-round" },
      { label: t("adm.recovery.ea92"), value: app.identity()?.recoveryRequired ? t("adm.replacement-required.a658") : t("adm.available.7c62"), hint: t("adm.a-recovery-sign-in-cannot-approv.2a25"), icon: "lucide-life-buoy" },
    ]} /><WorkspaceSection title={t("adm.authenticator-and-recovery.722e")} description={app.identity()?.requireTwoFactor ? t("adm.this-organization-requires-an-au.750b") : t("adm.an-authenticator-app-adds-a-seco.1e20")}><PageStack>
      <Show when={!app.identity()?.totpEnrolled} fallback={<><Alert theme="green" variant="outline" title={t("adm.authenticator-enrolled.98fd")} description={t("adm.you-will-get-new-recovery-codes.0602")} /><Show when={!app.identity()?.requireTwoFactor}><div class="flex max-w-xl flex-col gap-3 border-t border-outline-gray-1 pt-4"><TextInput label={t("adm.confirm-password-to-disable-auth.f7a4")} type="password" autocomplete="current-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} /><Button variant="outline" theme="red" disabled={!password()} class="self-start" onClick={async () => { const entered = password(); setPassword(""); try { await governor("/api/auth/two-factor/disable", { password: entered }); await app.reloadIdentity(); setFailed(false); setMessage("Authenticator disabled."); } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : "Could not disable the authenticator"); } }}>{t("adm.disable-authenticator.25b9")}</Button></div></Show></>}>
        <div class="flex flex-col items-start gap-2"><p class="text-interface text-ink-gray-7">Not set up yet. Add an authenticator app (for example Google Authenticator) so your account is protected if your password leaks.</p>
          <Button variant="solid" theme="blue" iconLeft="lucide-smartphone" onClick={() => setEnrollOpen(true)}>{t("adm.set-up-an-authenticator.1f1a")}</Button></div>
        <Dialog.Root open={enrollOpen()} onOpenChange={setEnrollOpen}><Dialog.Content size="md"><Dialog.Header><Dialog.Title>{t("adm.set-up-your-authenticator.90db")}</Dialog.Title></Dialog.Header>
          <AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={async () => { await app.reloadIdentity(); setEnrollOpen(false); }} /></Dialog.Content></Dialog.Root>
      </Show>
      <Show when={message()}><Alert theme={failed() ? "red" : "green"} variant="outline" title={failed() ? t("adm.security-action-failed.203e") : t("adm.security-updated.7ece")} description={message()} /></Show>
    </PageStack></WorkspaceSection><PasskeyControls /><SessionControls /></PageStack>
  </PageStack>;
}

/** "Chrome on Linux" instead of the raw browser string. */
function deviceLabel(userAgent?: string): string {
  if (!userAgent) return "Browser sign-in";
  const browser = /Edg\//u.test(userAgent) ? "Edge" : /Firefox\//u.test(userAgent) ? "Firefox" : /Chrome\//u.test(userAgent) ? "Chrome" : /Safari\//u.test(userAgent) ? "Safari" : t("adm.browser.54a2");
  const system = /Android/u.test(userAgent) ? "Android" : /iPhone|iPad/u.test(userAgent) ? "iOS" : /Windows/u.test(userAgent) ? "Windows" : /Mac OS X/u.test(userAgent) ? "macOS" : /Linux/u.test(userAgent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

function SessionControls(): JSX.Element {
  const app = useApp();
  const [sessions, setSessions] = createSignal<OrganizationSessionView[]>([]); const [message, setMessage] = createSignal("");
  async function load() { try { setSessions((await governor<{ items: OrganizationSessionView[] }>("/v1/identity/sessions")).items); } catch (error) { setMessage(error instanceof Error ? error.message : "Sessions are unavailable"); } }
  async function revoke(mode: "one" | "others" | "all", sessionId?: string) {
    try {
      await governor("/v1/identity/sessions/revoke", { mode, ...(sessionId ? { sessionId } : {}) });
      setMessage(mode === "one" ? "Session revoked." : mode === "others" ? t("adm.other-sessions-revoked.bb4e") : t("adm.all-sessions-revoked.0cae"));
      if (mode === "all") await app.reloadIdentity(); else await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Revocation failed"); }
  }
  onMount(() => void load());
  return <WorkspaceSection title={t("adm.active-sign-in-sessions.16fd")} description={t("adm.the-devices-and-browsers-where-y.594e")} actions={<div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { if (window.confirm("Revoke every other session, keeping only this one?")) void revoke("others"); }}>{t("adm.revoke-other-sessions.91a9")}</Button><Button size="sm" variant="outline" theme="red" onClick={() => { if (window.confirm("Revoke every session, including this one?")) void revoke("all"); }}>{t("adm.revoke-all.04dc")}</Button></div>}>
    <Show when={sessions().length} fallback={<p class="brain-empty-inline">{t("adm.no-other-sign-ins-to-show-press.c2db")}</p>}><div class="brain-queue"><For each={[...sessions()].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)))}>{(session) => <article class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-2.5"><div class="min-w-0"><h3 class="break-words text-base-medium">{deviceLabel(session.userAgent)}{session.current ? " · this device" : ""}</h3><p class="mt-0.5 break-words text-caption text-ink-gray-6">{t("adm.signed-in.1b6c")} <DateText value={session.createdAt} /> {t("adm.expires.a710")} <DateText value={session.expiresAt} />{session.ipAddress ? ` · ${session.ipAddress}` : ""}</p></div><Button size="sm" variant="outline" theme="red" onClick={() => { if (window.confirm(`Revoke ${session.current ? "this current" : "this"} session?`)) void revoke("one", session.id); }}>{t("adm.revoke-session.ca84")}</Button></article>}</For></div></Show>
    <Show when={message()}><p role="status" class="break-words text-interface">{message()}</p></Show>
  </WorkspaceSection>;
}

