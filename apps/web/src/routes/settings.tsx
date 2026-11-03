import { DiagnosticExport } from "../ui/components/DiagnosticExport";
import { LocalModelSetup } from "../ui/components/LocalModelSetup";
import { governor } from "../data/client";
import { useApp } from "../ui/app-context";
import { AuthenticatorEnrollment } from "../ui/components/Authentication";
import { PasskeyControls } from "../ui/components/PasskeyControls";
import { OrganizationAuthPolicy, OrganizationInvitations, OrganizationMemberSelect, OrganizationPeople } from "../ui/components/OrganizationAdmin";
import type { JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import { Badge, Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Pagination, Select } from "@talelk/newui-molecules";
import { useSearchParams } from "@solidjs/router";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import type { AuditEntry, HealthView, MemberGrantView, ConfigExplanation, OrganizationSessionView } from "@brain/contracts";
import { DateText, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { formatDateTime } from "../ui/format";
import { ActionFeedback } from "../ui/components/ActionFeedback";
import { RefreshButton } from "../ui/components/primitives";
import { EmptyPreview, FactStrip, Freshness, WorkspaceSection } from "../ui/components/Domain";
import { StatusBadge } from "../ui/components/StatusBadge";

const SETTINGS_PAGE_SIZE = 25;

const PAGE: Record<string, { title: string; description: string }> = {
  setup: { title: "Workspace setup", description: "Verify each prerequisite and open the flow that owns the next action." },
  security: { title: "Security center", description: "Manage authenticator, passkeys, sessions and notification hygiene for your account." },
  people: { title: "People", description: "Manage organization identity, roles and current-organization sessions." },
  invitations: { title: "Invitations", description: "Track intended access, acceptance and actual delivery state." },
  policy: { title: "Authentication policy", description: "Understand the effective security posture and its configuration source." },
  health: { title: "Platform operations", description: "Inspect service health, freshness and the scoped operational audit trail." },
  members: { title: "Workspace access", description: "See exactly who has which workspace role and change access with a reason." },
  release: { title: "Release management", description: "Inspect the active release and candidate contents before a separate authorized activation." },
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
  const [activateDigest, setActivateDigest] = createSignal("");
  const [memberPage, setMemberPage] = createSignal(1);
  const [auditPage, setAuditPage] = createSignal(1);
  const principalName = (id: string) => id === props.viewerId ? props.viewerName ?? id : id;
  const page = () => PAGE[tab()] ?? PAGE["security"]!;
  const memberPageCount = () => Math.max(1, Math.ceil(props.members.length / SETTINGS_PAGE_SIZE));
  const currentMemberPage = () => Math.min(memberPage(), memberPageCount());
  const memberRows = () => props.members.slice((currentMemberPage() - 1) * SETTINGS_PAGE_SIZE, currentMemberPage() * SETTINGS_PAGE_SIZE);
  const auditPageCount = () => Math.max(1, Math.ceil(props.audit.length / SETTINGS_PAGE_SIZE));
  const currentAuditPage = () => Math.min(auditPage(), auditPageCount());
  const auditRows = () => props.audit.slice((currentAuditPage() - 1) * SETTINGS_PAGE_SIZE, currentAuditPage() * SETTINGS_PAGE_SIZE);
  return <BrainPage title={page().title} description={page().description} actions={<RefreshButton onClick={props.onRefresh} label="Refresh" />}>
    <PageStack>
      <Show when={tab() === "setup" && organizationAdmin()}><LocalModelSetup /></Show>
      <Show when={tab() === "security"}><SecurityAndIntegrations area="security" /></Show>
      <Show when={tab() === "integrations"}><SecurityAndIntegrations area="integrations" /></Show>
      <Show when={tab() === "people" && identityAdmin()}><OrganizationPeople /></Show>
      <Show when={tab() === "invitations" && identityAdmin()}><OrganizationInvitations /></Show>
      <Show when={tab() === "policy" && identityAdmin()}><OrganizationAuthPolicy /></Show>
      <Show when={tab() === "health"}><PageStack>
        <Show when={organizationAdmin()}><DiagnosticExport /></Show>
        <WorkspaceSection title="Service status" description="Current health, detail and observation time reported by Governor. Unknown or unsupported states are not rendered green.">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Health unavailable" emptyDescription="The Governor did not return a service snapshot." onRetry={props.onRefresh}>
            <div class="grid gap-3 md:grid-cols-2"><For each={props.health?.services ?? []}>{(service) => <article class="min-w-0 border-y border-outline-gray-1 py-3"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="min-w-0 break-words text-base-medium capitalize">{service.id}</h3><StatusBadge kind="health" status={service.status} /></div><p class="mt-1.5 break-words text-interface text-ink-gray-7">{service.detail}</p><p class="mt-1.5 text-caption text-ink-gray-6">Checked <DateText value={service.checkedAt} /></p></article>}</For></div>
            <Show when={props.health} keyed>{(health) => <Show when={health.status !== "healthy"}><Alert theme="amber" variant="outline" title="Platform is degraded" description={`${health.pendingOutbox} outbox deliveries are pending (oldest ${health.oldestOutboxAgeMs}ms).`} /></Show>}</Show>
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title="Operational audit timeline" description="Actor, operation, object and time in one scoped append-only sequence. Technical cursors remain secondary.">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No audited events yet" emptyDescription="Actions appear here as the Governor records them." onRetry={props.onRefresh}>
            <div class="brain-queue"><For each={auditRows()}>{(entry) => <article class="grid gap-1.5 border-b border-outline-gray-1 py-2.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"><div class="min-w-0"><h3 class="break-words text-base-medium">{entry.action}</h3><p class="mt-0.5 break-all text-interface text-ink-gray-7">{entry.actorId} · {entry.resourceId}</p></div><div class="break-words text-caption text-ink-gray-6 md:text-end"><DateText value={entry.occurredAt} /><span class="ms-2 whitespace-nowrap">cursor {entry.cursor}</span></div></article>}</For></div>
            <Show when={auditPageCount() > 1}><Pagination.Root aria-label="Audit timeline pagination" class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={props.audit.length} pageSize={SETTINGS_PAGE_SIZE} page={currentAuditPage()} onPageChange={setAuditPage}>
              <Pagination.Range />
              <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
            </Pagination.Root></Show>
          </ScreenRegion>
        </WorkspaceSection>
      </PageStack></Show>
      <Show when={tab() === "members"}><WorkspaceSection title="People and workspace access" description="Organization membership alone does not grant workspace content. Roles below are explicit workspace grants." actions={props.canAdminister ? <Button size="md" variant="solid" theme="blue" iconLeft="lucide-user-plus" onClick={() => setAccessOpen(true)}>Manage access</Button> : undefined}>
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No members listed" emptyDescription="Nobody has been granted access to this workspace yet." onRetry={props.onRefresh}>
          <div class="grid gap-3 md:grid-cols-2"><For each={memberRows()}>{(member) => <article class="min-w-0 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-words text-base-medium">{principalName(member.principalId)}</h3><p class="mt-0.5 break-all text-caption text-ink-gray-6">{member.principalId}</p></div><StatusBadge status={member.revoked ? "revoked" : "active"} /></div><div class="mt-2 flex flex-wrap gap-1.5"><For each={member.roles}>{(role) => <Badge variant="outline" theme="blue" label={role} />}</For></div><dl class="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 text-caption"><div class="min-w-0"><dt class="text-ink-gray-6">Granted</dt><dd class="mt-0.5 break-words"><DateText value={member.createdAt} /></dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Record version</dt><dd class="mt-0.5 tabular-nums">{member.version}</dd></div></dl></article>}</For></div>
          <Show when={memberPageCount() > 1}><Pagination.Root aria-label="Workspace access pagination" class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={props.members.length} pageSize={SETTINGS_PAGE_SIZE} page={currentMemberPage()} onPageChange={setMemberPage}>
            <Pagination.Range />
            <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
          </Pagination.Root></Show>
        </ScreenRegion>
      </WorkspaceSection></Show>
      <Show when={tab() === "release"}><WorkspaceSection title="Release readiness" description="Active identity and candidate contents precede the high-risk activation control."><Show when={organizationAdmin()} fallback={<p class="text-interface text-ink-gray-7">Staging and activating releases requires an administrator role.</p>}><InspectRelease activeConfigDigest={props.activeConfigDigest} onActivate={props.onActivate} /></Show></WorkspaceSection></Show>
      <Show when={tab() === "release"}><WorkspaceSection title="Effective configuration" description="Trace where a value comes from in the active release. Raw provenance remains secondary to the effective value."><PageStack><div class="max-w-xl"><TextInput label="Config pointer" value={activateDigest()} description="For example /workflows/fixture-workflow" onInput={(event) => setActivateDigest(event.currentTarget.value)} /></div><Show when={props.explanation}><div class="grid gap-3 lg:grid-cols-2"><KeyValue label="Pointer" value={<span class="break-all">{props.explanation!.pointer}</span>} /><KeyValue label="Active digest" value={<code class="break-all">{props.explanation!.configDigest}</code>} orientation="vertical" /><For each={props.explanation!.sources}>{(source) => <KeyValue label={`Rule (${source.rule})`} value={<span class="break-all">{source.path}:{source.line}</span>} orientation="vertical" />}</For></div></Show></PageStack></WorkspaceSection></Show>
      <Show when={tab() === "security"}><WorkspaceSection title="Notifications" description="Attention hints never replace sign-in and exact review."><PushControls /></WorkspaceSection></Show>
      <Dialog.Root open={accessOpen()} onOpenChange={setAccessOpen}><Dialog.Content size="md"><Dialog.Header><Dialog.Title>Manage workspace access</Dialog.Title><Dialog.Description>Grant or revoke one role for an active organization member. The current record version and reason are checked by Governor.</Dialog.Description></Dialog.Header><div class="my-3 flex flex-col gap-3"><OrganizationMemberSelect value={principalId()} onChange={setPrincipalId} /><Select label="Role" value={role()} options={[{ value: "viewer", label: "Viewer" }, { value: "operator", label: "Operator" }, { value: "workspace-lead", label: "Workspace lead" }, { value: "approver", label: "Approver" }]} onValueChange={(value) => setRole(value ?? "viewer")} /><TextInput label="Reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /><Alert theme="amber" variant="outline" title="Scope and consequence" description={`${role()} access applies to workspace ${props.workspaceId}. Revocation stops new reads and writes; it does not delete organization membership.`} /></div><Dialog.Footer class="flex-wrap justify-end gap-2"><Button size="md" variant="outline" onClick={() => setAccessOpen(false)}>Cancel</Button><Button size="md" variant="outline" theme="red" disabled={!principalId().trim() || !reason().trim()} onClick={() => { void props.onRevoke(principalId().trim(), role(), reason().trim()); setAccessOpen(false); }}>Revoke</Button><Button size="md" variant="solid" theme="blue" disabled={!principalId().trim() || !reason().trim()} onClick={() => { void props.onGrant(principalId().trim(), role(), reason().trim()); setAccessOpen(false); }}>Grant</Button></Dialog.Footer></Dialog.Content></Dialog.Root>
    </PageStack>
  </BrainPage>;
}

function InspectRelease(props: { activeConfigDigest?: string; onActivate: (digest: string, expectedActiveDigest: string | null) => Promise<void> }) {
  type ReleaseSummary = { digest: string; sourceRevision: string; createdAt: string; active: boolean; agents: number; workflows: number; assets: number };
  const [digest, setDigest] = createSignal("");
  const [releases, setReleases] = createSignal<ReleaseSummary[]>([]);
  const [inspection, setInspection] = createSignal<{ digest: string; expectedActiveDigest: string | null; manifest: { documents?: { id: string; kind: string; path: string }[] } }>();
  const [error, setError] = createSignal<{ text: string; tone: "error" | "success" }>(); const [busy, setBusy] = createSignal(false);
  async function loadReleases() {
    try { const result = await governor<{ items: ReleaseSummary[] }>("/v1/config/releases"); setReleases(result.items); if (!digest() && result.items[0]) setDigest(result.items[0].digest); }
    catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Could not list staged releases", tone: "error" }); }
  }
  onMount(() => void loadReleases());
  async function inspect() {
    setBusy(true); setInspection(undefined);
    try { setInspection(await governor(`/v1/config/releases/${encodeURIComponent(digest())}`)); }
    catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Inspection failed", tone: "error" }); }
    finally { setBusy(false); }
  }
  const current = () => releases().find((release) => release.digest === digest());
  const active = () => releases().find((release) => release.active);
  return <PageStack>
    <FactStrip label="Release management summary" items={[
      { label: "Active source", value: <span class="break-all">{active()?.sourceRevision ?? "No active release"}</span>, hint: active() ? "Currently activated source commit" : "Activate an inspected candidate first", icon: "lucide-git-branch" },
      { label: "Candidates", value: String(releases().length), hint: "Immutable staged releases", icon: "lucide-package" },
      { label: "Selected", value: current()?.active ? "Active" : current() ? "Candidate" : "None", hint: current() ? `${current()!.workflows} workflows · ${current()!.agents} agents` : "Choose a staged release", icon: "lucide-scan-search" },
      { label: "Gate evidence", value: "Not supplied", hint: "A build alone does not prove verified readiness", icon: "lucide-shield-question" },
    ]} />
    <div class="grid gap-2 border-y border-outline-gray-1 py-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end"><Select label="Staged release" value={digest() || null} options={releases().map((release) => ({ value: release.digest, label: `${release.workflows} Workflows · ${release.agents} Agents${release.active ? " · active" : ""}`, description: `${formatDateTime(release.createdAt)} · ${release.digest}` }))} onValueChange={(value) => { setDigest(value ?? ""); setInspection(undefined); }} /><Button size="sm" variant="outline" class="justify-self-start" onClick={() => void loadReleases()}>Refresh</Button><Button size="md" variant="outline" class="justify-self-start" onClick={() => void inspect()} disabled={!digest() || busy()} loading={busy()}>Inspect selected release</Button></div>
    <Show when={current()}>{(release) => <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-7"><span class="min-w-0 break-all">Source {release().sourceRevision}</span><span>{release().assets} supporting assets</span><Freshness value={release().createdAt} label="Staged" /></div>}</Show>
    <Show when={!releases().length && !error()}><EmptyPreview icon="lucide-package" title="No staged releases" description="Compile the complete starter directory, then refresh this list. Activation is never inferred from compilation." /></Show>
    <Show when={inspection()} keyed>{(release) => <PageStack><div class="border-y border-outline-gray-1 py-3"><h3 class="text-base-medium">Candidate contents</h3><ul class="mt-2 grid gap-2 sm:grid-cols-2"><For each={release.manifest.documents ?? []}>{(document) => <li class="min-w-0 break-words text-interface text-ink-gray-7"><strong>{document.kind}</strong> · <span class="break-all">{document.id}</span></li>}</For></ul></div><TechnicalDetails label="Technical manifest and digest"><p class="break-all">{release.digest}</p><pre class="brain-readable mt-3 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all text-caption">{JSON.stringify(release.manifest, null, 2)}</pre></TechnicalDetails><Alert theme="amber" variant="outline" title="High-risk activation" description="Activation changes the active release only after exact authorization and expected-active-digest validation. It does not claim runtime gate evidence." /><Button size="md" variant="solid" theme="blue" iconLeft="lucide-check" class="self-start" disabled={busy()} onClick={async () => { setBusy(true); setError(undefined); try { await props.onActivate(release.digest, release.expectedActiveDigest); setInspection(undefined); setError({ text: "Release activated. Inspect Agents and Workflows to continue.", tone: "success" }); await loadReleases(); } catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Activation failed", tone: "error" }); } finally { setBusy(false); } }}>Activate inspected release</Button></PageStack>}</Show>
    <ActionFeedback tone={error()?.tone} message={error()?.text} title={error()?.tone === "success" ? "Release active" : undefined} />
    <TechnicalDetails label="Compile a new release"><p>Compile the complete directory, including Markdown instructions, tool scripts, and schemas:</p><code class="mt-2 block break-all">brain config compile examples/v1/starter-release</code></TechnicalDetails>
  </PageStack>;
}

function SecurityAndIntegrations(props: { area: "security" | "integrations" }) {
  const app = useApp(); const [password, setPassword] = createSignal(""); const [message, setMessage] = createSignal(""); const [failed, setFailed] = createSignal(false);
  return <PageStack>
    <Show when={props.area === "security"}><PageStack><FactStrip label="Account security posture" items={[
      { label: "Authenticator", value: app.identity()?.totpEnrolled ? "Enrolled" : "Not enrolled", hint: app.identity()?.requireTwoFactor ? "Required by organization policy" : "Optional for sign-in", icon: "lucide-shield-check" },
      { label: "Approval step-up", value: app.identity()?.requireTwoFactor ? "TOTP required" : "Session evidence", hint: "Bound to the exact action", icon: "lucide-key-round" },
      { label: "Recovery", value: app.identity()?.recoveryRequired ? "Replacement required" : "Available", hint: "Recovery sign-in does not authorize effects", icon: "lucide-life-buoy" },
    ]} /><WorkspaceSection title="Authenticator and recovery" description={app.identity()?.requireTwoFactor ? "Authenticator enrollment and TOTP step-up are required." : "Two-factor authentication is optional. Exact approvals still require one-use session evidence."}><PageStack>
      <Show when={!app.identity()?.totpEnrolled} fallback={<><Alert theme="green" variant="outline" title="Authenticator enrolled" description="Recovery codes are available when you enroll a replacement authenticator. Routine sign-in and exact effect approval remain separate." /><Show when={!app.identity()?.requireTwoFactor}><div class="flex max-w-xl flex-col gap-3 border-t border-outline-gray-1 pt-4"><TextInput label="Confirm password to disable authenticator" type="password" autocomplete="current-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} /><Button size="md" variant="outline" theme="red" disabled={!password()} class="self-start" onClick={async () => { const entered = password(); setPassword(""); try { await governor("/api/auth/two-factor/disable", { password: entered }); await app.reloadIdentity(); setFailed(false); setMessage("Authenticator disabled."); } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : "Could not disable the authenticator"); } }}>Disable authenticator</Button></div></Show></>}>
        <AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={() => app.reloadIdentity()} />
      </Show>
      <Show when={message()}><Alert theme={failed() ? "red" : "green"} variant="outline" title={failed() ? "Security action failed" : "Security updated"} description={message()} /></Show>
    </PageStack></WorkspaceSection><PasskeyControls /><SessionControls /></PageStack></Show>
    <Show when={props.area === "integrations"}><WorkspaceSection title="External administration" description="External applications open separately. Brain does not forward your credentials."><div class="grid gap-2 sm:grid-cols-2"><Show when={app.identity()?.integrations.memoryUiUrl}><a class="flex min-h-16 min-w-0 items-center gap-3 rounded-card border border-outline-gray-1 p-3 text-ink-blue-link hover:bg-surface-gray-1 focus-visible:focus-ring" href={app.identity()!.integrations.memoryUiUrl!} target="_blank" rel="noopener noreferrer"><span class="lucide-database size-5 shrink-0" aria-hidden="true" /><span class="min-w-0 break-words font-medium">Open Memory UI</span><span class="lucide-external-link ms-auto size-4 shrink-0" aria-hidden="true" /></a></Show></div><Show when={!app.identity()?.integrations.memoryUiUrl}><p class="brain-readable text-interface text-ink-gray-7">No external administration links are configured. Better Auth administration is built into People, Invitations, and Authentication policy.</p></Show></WorkspaceSection></Show>
  </PageStack>;
}

function SessionControls(): JSX.Element {
  const app = useApp();
  const [sessions, setSessions] = createSignal<OrganizationSessionView[]>([]); const [message, setMessage] = createSignal("");
  async function load() { try { setSessions((await governor<{ items: OrganizationSessionView[] }>("/v1/identity/sessions")).items); } catch (error) { setMessage(error instanceof Error ? error.message : "Sessions are unavailable"); } }
  async function revoke(mode: "one" | "others" | "all", sessionId?: string) {
    try {
      await governor("/v1/identity/sessions/revoke", { mode, ...(sessionId ? { sessionId } : {}) });
      setMessage(mode === "one" ? "Session revoked." : mode === "others" ? "Other sessions revoked." : "All sessions revoked.");
      if (mode === "all") await app.reloadIdentity(); else await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Revocation failed"); }
  }
  onMount(() => void load());
  return <WorkspaceSection title="Active sign-in sessions" description="Only your sessions are listed. Revocation requires context and a server receipt; credentials never reach browser JavaScript." actions={<div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { if (window.confirm("Revoke every other session, keeping only this one?")) void revoke("others"); }}>Revoke other sessions</Button><Button size="sm" variant="outline" theme="red" onClick={() => { if (window.confirm("Revoke every session, including this one?")) void revoke("all"); }}>Revoke all</Button></div>}>
    <Show when={sessions().length} fallback={<p class="brain-empty-inline">No active sessions were returned.</p>}><div class="brain-queue"><For each={sessions()}>{(session) => <article class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-2.5"><div class="min-w-0"><h3 class="break-words text-base-medium">{session.userAgent || "Browser session"}{session.current ? " · current" : ""}</h3><p class="mt-0.5 break-words text-caption text-ink-gray-6">Started <DateText value={session.createdAt} /> · expires <DateText value={session.expiresAt} />{session.ipAddress ? ` · ${session.ipAddress}` : ""}</p></div><Button size="sm" variant="outline" theme="red" onClick={() => { if (window.confirm(`Revoke ${session.current ? "this current" : "this"} session?`)) void revoke("one", session.id); }}>Revoke session</Button></article>}</For></div></Show>
    <Show when={message()}><p role="status" class="break-words text-interface">{message()}</p></Show>
  </WorkspaceSection>;
}

function PushControls(): JSX.Element {
  const [state, setState] = createSignal("");
  async function enable() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setState("Push is not available in this browser."); return; }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState("Notification permission was not granted."); return; }
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await (await fetch("/v1/push/vapid-public-key", { credentials: "same-origin" })).json() as { publicKey: string };
      const keyBytes = Uint8Array.from(atob(publicKey.replace(/-/gu, "+").replace(/_/gu, "/")), (character) => character.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes as BufferSource });
      await fetch("/v1/push/subscriptions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
      setState("Notifications enabled. They are attention hints only — decisions still happen here after sign-in and step-up.");
    } catch (reason) { setState(reason instanceof Error ? reason.message : "Could not enable notifications."); }
  }
  return <div class="flex flex-col items-start gap-3"><p class="brain-readable text-interface text-ink-gray-7">Push notifications are attention hints for pending approvals. Decisions always happen here after sign-in and step-up verification.</p><Button size="md" variant="outline" theme="blue" iconLeft="lucide-bell" onClick={() => void enable()}>Enable notifications</Button><Show when={state()}><p role="status" class="brain-readable text-interface">{state()}</p></Show></div>;
}
