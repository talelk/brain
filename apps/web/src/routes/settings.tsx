import { DiagnosticExport } from "../ui/components/DiagnosticExport";
import { BrainForm } from "../ui/components/BrainForm";
import { LocalModelSetup } from "../ui/components/LocalModelSetup";
import { governor } from "../data/client";
import { useApp } from "../ui/app-context";
import { AuthenticatorEnrollment } from "../ui/components/Authentication";
import { PasskeyControls } from "../ui/components/PasskeyControls";
import { OrganizationAuthPolicy, OrganizationInvitations, OrganizationMemberSelect, OrganizationPeople } from "../ui/components/OrganizationAdmin";
import type { JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import { Badge, Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Pagination, Select, EmptyState, Timeline } from "@talelk/newui-molecules";
import { useSearchParams } from "@solidjs/router";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import type { AuditEntry, HealthView, MemberGrantView, ConfigExplanation, OrganizationSessionView } from "@brain/contracts";
import { DateText, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { formatDateTime } from "../ui/format";
import { ActionFeedback } from "../ui/components/ActionFeedback";
import { Freshness, WorkspaceSection } from "../ui/components/Domain";import { StatusBadge, statusTheme } from "../ui/components/StatusBadge";
import { StatusIcon } from "../ui/viz/StatusIcon";
import { StatGrid } from "@talelk/newui-organisms";

const SETTINGS_PAGE_SIZE = 25;

const PAGE: Record<string, { title: string; description: string }> = {
  setup: { title: "Setup", description: "Connect a model, start the runners, then run one safe test task." },
  security: { title: "Security", description: "Protect your own account: two-factor sign-in, passkeys, your signed-in devices and notifications." },
  people: { title: "People", description: "Everyone in your organization and what each person may administer. Invite someone, change their organization roles, or suspend them." },
  invitations: { title: "Invitations", description: "People you invited and whether they have joined yet. Invitations are sent by email and expire." },
  policy: { title: "Authentication", description: "How people sign in to this organization. This page is read-only; the policy is set in the server configuration." },
  health: { title: "Health", description: "Is Brain working? One verdict first, then each service and the latest recorded activity." },
  members: { title: "Workspace access", description: "Who can do what in this workspace. Grant or revoke a role; every change needs a reason and is recorded." },
  release: { title: "Releases", description: "A release is the set of workflows and agents Brain runs. Activating a release makes it the one new work uses; running work keeps the release it started on." },
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
  const page = () => PAGE[tab()] ?? PAGE["security"]!;
  const memberPageCount = () => Math.max(1, Math.ceil(props.members.length / SETTINGS_PAGE_SIZE));
  const currentMemberPage = () => Math.min(memberPage(), memberPageCount());
  const memberRows = () => props.members.slice((currentMemberPage() - 1) * SETTINGS_PAGE_SIZE, currentMemberPage() * SETTINGS_PAGE_SIZE);
  const auditPageCount = () => Math.max(1, Math.ceil(props.audit.length / SETTINGS_PAGE_SIZE));
  const currentAuditPage = () => Math.min(auditPage(), auditPageCount());
  const auditRows = () => props.audit.slice((currentAuditPage() - 1) * SETTINGS_PAGE_SIZE, currentAuditPage() * SETTINGS_PAGE_SIZE);
  return <BrainPage title={page().title} description={page().description} actions={<Button variant="outline" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>Refresh</Button>}>
    <PageStack>
      <Show when={tab() === "setup" && organizationAdmin()}><LocalModelSetup /></Show>
      <Show when={tab() === "security"}><SecurityPage /></Show>
      <Show when={tab() === "people" && identityAdmin()}><OrganizationPeople /></Show>
      <Show when={tab() === "invitations" && identityAdmin()}><OrganizationInvitations /></Show>
      <Show when={tab() === "policy" && identityAdmin()}><OrganizationAuthPolicy /></Show>
      <Show when={tab() === "health"}><PageStack>
                <HealthVerdict health={props.health} />
        <WorkspaceSection title="Services" description="What each part of Brain reported on its last check. A grey or unknown state is never shown as healthy.">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Health unavailable" emptyDescription="Brain could not read its own status. Retry; if it keeps failing, the server may be down." onRetry={props.onRefresh}>
            <div class="grid gap-3 md:grid-cols-2"><For each={props.health?.services ?? []}>{(service) => <article class="min-w-0 border-y border-outline-gray-1 py-3"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="flex min-w-0 items-center gap-2 break-words text-base-medium"><StatusIcon state={service.status} theme={statusTheme("health", service.status)} class="size-4" />{serviceName(service.id)}</h3><StatusBadge kind="health" status={service.status} /></div><p class="mt-1.5 break-words text-interface text-ink-gray-7">{service.detail}</p><p class="mt-1.5 text-caption text-ink-gray-6">Checked <DateText value={service.checkedAt} /></p></article>}</For></div>
            
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title="Recent activity" description="Who did what and when, newest first. Entries cannot be edited or removed.">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Nothing recorded yet" emptyDescription="Sign-ins, approvals, grants and releases appear here as they happen." onRetry={props.onRefresh}>
            <Show when={props.audit.length === 0}><p class="brain-empty-inline">Nothing recorded yet. Sign-ins, approvals, grants and releases appear here as they happen.</p></Show>
            <Timeline items={auditRows().map((entry) => ({ id: String(entry.cursor), title: <span class="break-words">{entry.action}</span>, description: <span class="break-all">{entry.actorId} · {entry.resourceId}</span>, timestamp: <span class="whitespace-nowrap"><DateText value={entry.occurredAt} /> · cursor {entry.cursor}</span>, icon: "lucide-history" }))} />
            <Show when={auditPageCount() > 1}><Pagination.Root aria-label="Audit timeline pagination" class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={props.audit.length} pageSize={SETTINGS_PAGE_SIZE} page={currentAuditPage()} onPageChange={setAuditPage}>
              <Pagination.Range />
              <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
            </Pagination.Root></Show>
          </ScreenRegion>
        </WorkspaceSection>
        <Show when={organizationAdmin()}><DiagnosticExport /></Show>
      </PageStack></Show>
      <Show when={tab() === "members"}><WorkspaceSection title="Who has access" description="Being in the organization does not give access to a workspace; each person needs one of the roles below." actions={props.canAdminister ? <Button variant="solid" theme="blue" iconLeft="lucide-user-plus" onClick={() => setAccessOpen(true)}>Manage access</Button> : undefined}>
        <RoleLegend />
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Nobody has access yet" emptyDescription="Use Manage access to give someone a role in this workspace." onRetry={props.onRefresh}>
          <div class="grid gap-3 md:grid-cols-2"><For each={memberRows()}>{(member) => <article class="min-w-0 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-words text-base-medium">{principalName(member)}</h3><p class="mt-0.5 break-all text-caption text-ink-gray-6">{member.email ?? `ID ${member.principalId}`}</p></div><StatusBadge status={member.revoked ? "revoked" : "active"} /></div><div class="mt-2 flex flex-wrap gap-1.5"><For each={member.roles}>{(role) => <Badge variant="outline" theme="blue" label={role} />}</For></div><dl class="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 text-caption"><div class="min-w-0"><dt class="text-ink-gray-6">Granted</dt><dd class="mt-0.5 break-words"><DateText value={member.createdAt} /></dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Status</dt><dd class="mt-0.5">{member.revoked ? "Access revoked" : "Has access"}</dd></div></dl></article>}</For></div>
          <Show when={memberPageCount() > 1}><Pagination.Root aria-label="Workspace access pagination" class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={props.members.length} pageSize={SETTINGS_PAGE_SIZE} page={currentMemberPage()} onPageChange={setMemberPage}>
            <Pagination.Range />
            <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
          </Pagination.Root></Show>
        </ScreenRegion>
      </WorkspaceSection></Show>
      <Show when={tab() === "release"}><WorkspaceSection title="Active and available releases" description="Pick a release, check what is in it, then activate it. Nothing changes until you activate."><Show when={organizationAdmin()} fallback={<p class="text-interface text-ink-gray-7">Only an organization administrator can view or activate releases. Ask one to do it.</p>}><InspectRelease activeConfigDigest={props.activeConfigDigest} onActivate={props.onActivate} /></Show></WorkspaceSection></Show>
      <Show when={tab() === "release" && organizationAdmin() && props.explanation}><TechnicalDetails label="Where the workflow settings come from"><PageStack><Show when={props.explanation}><div class="grid gap-3 lg:grid-cols-2"><KeyValue label="Pointer" value={<span class="break-all">{props.explanation!.pointer}</span>} /><KeyValue label="Active digest" value={<code class="break-all">{props.explanation!.configDigest}</code>} orientation="vertical" /><For each={props.explanation!.sources}>{(source) => <KeyValue label={`Rule (${source.rule})`} value={<span class="break-all">{source.path}:{source.line}</span>} orientation="vertical" />}</For></div></Show></PageStack></TechnicalDetails></Show>
      <Show when={tab() === "security"}><WorkspaceSection title="Notifications" description="Attention hints never replace sign-in and exact review."><PushControls /></WorkspaceSection></Show>
      <Dialog.Root open={accessOpen()} onOpenChange={setAccessOpen}><Dialog.Content size="md"><Dialog.Header><Dialog.Title>Manage workspace access</Dialog.Title><Dialog.Description>Grant or revoke one role for an active organization member. The current record version and reason are checked by Governor.</Dialog.Description></Dialog.Header><BrainForm bare label="Manage workspace access" onSubmit={() => { if (principalId().trim() && reason().trim()) { void props.onGrant(principalId().trim(), role(), reason().trim()); setAccessOpen(false); } }}><div class="my-3 flex flex-col gap-3"><OrganizationMemberSelect value={principalId()} onChange={setPrincipalId} /><Select label="Role" value={role()} options={[{ value: "viewer", label: "Viewer" }, { value: "operator", label: "Operator" }, { value: "workspace-lead", label: "Workspace lead" }, { value: "approver", label: "Approver" }]} onValueChange={(value) => setRole(value ?? "viewer")} /><TextInput label="Reason" required value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /><Alert theme="amber" variant="outline" title="Scope and consequence" description={`${role()} access applies to workspace ${props.workspaceId}. Revocation stops new reads and writes; it does not delete organization membership.`} /></div><Dialog.Footer class="flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setAccessOpen(false)}>Cancel</Button><Button variant="outline" theme="red" disabled={!principalId().trim() || !reason().trim()} onClick={() => { void props.onRevoke(principalId().trim(), role(), reason().trim()); setAccessOpen(false); }}>Revoke</Button><Button type="submit" variant="solid" theme="blue" disabled={!principalId().trim() || !reason().trim()}>Grant</Button></Dialog.Footer></BrainForm></Dialog.Content></Dialog.Root>
    </PageStack>
  </BrainPage>;
}

const SERVICE_NAMES: Record<string, string> = { governor: "Brain server", "memory-local": "Memory (built-in store)", memory: "Memory service", runner: "Runners", runners: "Runners" };
const serviceName = (id: string) => SERVICE_NAMES[id.toLowerCase()] ?? id.replace(/[-_]/gu, " ");

/** One overall verdict before any detail: healthy, needs a look, or unknown. Disabled optional services do not count against it. */
function HealthVerdict(props: { health?: HealthView }): JSX.Element {
  const verdict = () => {
    const health = props.health;
    if (!health) return { theme: "gray" as const, title: "Health is unknown", text: "Brain could not read its status, so nothing here can be called healthy. Press Refresh." };
    const bad = health.services.filter((service) => service.status !== "healthy" && service.status !== "disabled");
    if (health.status === "healthy" && bad.length === 0) return { theme: "green" as const, title: "Everything is working", text: `${health.services.length} services checked, none need attention.` };
    return { theme: "amber" as const, title: "Something needs attention", text: `${bad.length ? `${bad.map((service) => serviceName(service.id)).join(", ")} ${bad.length === 1 ? "is" : "are"} not healthy. ` : ""}${health.pendingOutbox > 0 ? `${health.pendingOutbox} outgoing messages are waiting to be delivered (the oldest for ${Math.round(health.oldestOutboxAgeMs / 1000)} s). ` : ""}Details are below.` };
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
  return <dl class="mb-3 grid gap-x-6 gap-y-1 text-caption text-ink-gray-7 sm:grid-cols-2" aria-label="What each role can do"><For each={ROLE_HELP}>{([name, text]) => <div><dt class="inline font-medium text-ink-gray-9">{name}</dt> <dd class="inline">{text}</dd></div>}</For></dl>;
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

function InspectRelease(props: { activeConfigDigest?: string; onActivate: (digest: string, expectedActiveDigest: string | null) => Promise<void> }) {
  type ReleaseSummary = { digest: string; sourceRevision: string; createdAt: string; active: boolean; agents: number; workflows: number; assets: number };
  const [digest, setDigest] = createSignal("");
  const [releases, setReleases] = createSignal<ReleaseSummary[]>([]);
  const [inspection, setInspection] = createSignal<{ digest: string; expectedActiveDigest: string | null; manifest: { documents?: { id: string; kind: string; path: string }[] } }>();
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
      { label: "Active release", value: <span title={active()?.sourceRevision} class="text-base">{active() ? `${active()!.workflows} workflows · ${active()!.agents} agents` : "None yet"}</span>, hint: active() ? `Activated from ${active()!.sourceRevision.slice(0, 12)}` : "New work cannot start until one is activated", icon: "lucide-rocket" },
      { label: "Available", value: String(releases().length), hint: "Compiled releases ready to inspect", icon: "lucide-package" },
      { label: "Selected", value: current()?.active ? "Already active" : current() ? "Not active" : "None", hint: current() ? `${current()!.workflows} workflows · ${current()!.agents} agents` : "Choose a release below", icon: "lucide-scan-search" },
    ]} />
    <div class="grid gap-2 border-y border-outline-gray-1 py-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end"><Select label="Release" value={digest() || null} options={releases().map((release) => ({ value: release.digest, label: `${release.workflows} workflows, ${release.agents} agents${release.active ? " (active)" : ""}`, description: `${formatDateTime(release.createdAt)} · ${release.digest}` }))} onValueChange={(value) => { setDigest(value ?? ""); setInspection(undefined); }} /><Button size="sm" variant="outline" class="justify-self-start" onClick={() => void loadReleases()}>Refresh</Button><Button variant="outline" class="justify-self-start" onClick={() => void inspect()} disabled={!digest() || busy()} loading={busy()}>See what is inside</Button></div>
    <Show when={current()}>{(release) => <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-7"><span class="min-w-0 break-all" title={release().sourceRevision}>Built from {release().sourceRevision.replace(/^sha256:/u, "").slice(0, 12)}</span><span>{release().assets} supporting files</span><Freshness value={release().createdAt} label="Compiled" /></div>}</Show>
    <Show when={!releases().length && !error()}><EmptyState size="sm" icon="lucide-package" title="No releases compiled yet" description="Compile the starter directory with the command under Compile a new release, then press Refresh. Compiling alone never changes what Brain runs." /></Show>
    <Show when={inspection()} keyed>{(release) => <PageStack><div class="border-y border-outline-gray-1 py-3"><h3 class="text-base-medium">What this release contains</h3><ReleaseContents documents={release.manifest.documents ?? []} /></div><TechnicalDetails label="Technical details (manifest and digest)"><p class="break-all">{release.digest}</p><pre class="brain-readable mt-3 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all text-caption">{JSON.stringify(release.manifest, null, 2)}</pre></TechnicalDetails><Alert theme="amber" variant="outline" title="Activating changes what new work uses" description="New missions and tasks will use this release from now on. Work already running keeps the release it started with. Activation is refused if someone else changed the active release since you opened this page." /><Button variant="solid" theme="blue" iconLeft="lucide-check" class="self-start" disabled={busy()} onClick={async () => { setBusy(true); setError(undefined); try { await props.onActivate(release.digest, release.expectedActiveDigest); setInspection(undefined); setError({ text: "This release is now active. New work will use it.", tone: "success" }); await loadReleases(); } catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Activation failed. Press Refresh, check which release is active, and try again.", tone: "error" }); } finally { setBusy(false); } }}>Activate this release</Button></PageStack>}</Show>
    <ActionFeedback tone={error()?.tone} message={error()?.text} title={error()?.tone === "success" ? "Release active" : undefined} />
    <TechnicalDetails label="Compile a new release"><p>Run this on the server, then refresh this page. It compiles the whole directory: instructions, tool scripts and schemas.</p><code class="mt-2 block break-all">brain config compile examples/v1/starter-release</code></TechnicalDetails>
  </PageStack>;
}

function SecurityPage() {
  const app = useApp(); const [enrollOpen, setEnrollOpen] = createSignal(false); const [password, setPassword] = createSignal(""); const [message, setMessage] = createSignal(""); const [failed, setFailed] = createSignal(false);
  return <PageStack>
    <PageStack><StatGrid compact stats={[
      { label: "Authenticator", value: app.identity()?.totpEnrolled ? "Enrolled" : "Not enrolled", hint: app.identity()?.requireTwoFactor ? "Required by organization policy" : "Optional for sign-in", icon: "lucide-shield-check" },
      { label: "Approving actions", value: app.identity()?.requireTwoFactor ? "Authenticator code" : "Confirm again", hint: "You confirm each action before it runs", icon: "lucide-key-round" },
      { label: "Recovery", value: app.identity()?.recoveryRequired ? "Replacement required" : "Available", hint: "A recovery sign-in cannot approve actions", icon: "lucide-life-buoy" },
    ]} /><WorkspaceSection title="Authenticator and recovery" description={app.identity()?.requireTwoFactor ? "This organization requires an authenticator app for sign-in and for approving actions." : "An authenticator app adds a second step when you sign in. It is optional here; approving an action always asks you to confirm again."}><PageStack>
      <Show when={!app.identity()?.totpEnrolled} fallback={<><Alert theme="green" variant="outline" title="Authenticator enrolled" description="You will get new recovery codes if you replace the authenticator. Signing in and approving an action are checked separately." /><Show when={!app.identity()?.requireTwoFactor}><div class="flex max-w-xl flex-col gap-3 border-t border-outline-gray-1 pt-4"><TextInput label="Confirm password to disable authenticator" type="password" autocomplete="current-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} /><Button variant="outline" theme="red" disabled={!password()} class="self-start" onClick={async () => { const entered = password(); setPassword(""); try { await governor("/api/auth/two-factor/disable", { password: entered }); await app.reloadIdentity(); setFailed(false); setMessage("Authenticator disabled."); } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : "Could not disable the authenticator"); } }}>Disable authenticator</Button></div></Show></>}>
        <div class="flex flex-col items-start gap-2"><p class="text-interface text-ink-gray-7">Not set up yet. Add an authenticator app (for example Google Authenticator) so your account is protected if your password leaks.</p>
          <Button variant="solid" theme="blue" iconLeft="lucide-smartphone" onClick={() => setEnrollOpen(true)}>Set up an authenticator</Button></div>
        <Dialog.Root open={enrollOpen()} onOpenChange={setEnrollOpen}><Dialog.Content size="md"><Dialog.Header><Dialog.Title>Set up your authenticator</Dialog.Title></Dialog.Header>
          <AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={async () => { await app.reloadIdentity(); setEnrollOpen(false); }} /></Dialog.Content></Dialog.Root>
      </Show>
      <Show when={message()}><Alert theme={failed() ? "red" : "green"} variant="outline" title={failed() ? "Security action failed" : "Security updated"} description={message()} /></Show>
    </PageStack></WorkspaceSection><PasskeyControls /><SessionControls /></PageStack>
  </PageStack>;
}

/** "Chrome on Linux" instead of the raw browser string. */
function deviceLabel(userAgent?: string): string {
  if (!userAgent) return "Browser sign-in";
  const browser = /Edg\//u.test(userAgent) ? "Edge" : /Firefox\//u.test(userAgent) ? "Firefox" : /Chrome\//u.test(userAgent) ? "Chrome" : /Safari\//u.test(userAgent) ? "Safari" : "Browser";
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
      setMessage(mode === "one" ? "Session revoked." : mode === "others" ? "Other sessions revoked." : "All sessions revoked.");
      if (mode === "all") await app.reloadIdentity(); else await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Revocation failed"); }
  }
  onMount(() => void load());
  return <WorkspaceSection title="Active sign-in sessions" description="The devices and browsers where you are signed in. Revoking one signs it out straight away." actions={<div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { if (window.confirm("Revoke every other session, keeping only this one?")) void revoke("others"); }}>Revoke other sessions</Button><Button size="sm" variant="outline" theme="red" onClick={() => { if (window.confirm("Revoke every session, including this one?")) void revoke("all"); }}>Revoke all</Button></div>}>
    <Show when={sessions().length} fallback={<p class="brain-empty-inline">No other sign-ins to show. Press Refresh if you expected some.</p>}><div class="brain-queue"><For each={[...sessions()].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)))}>{(session) => <article class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-2.5"><div class="min-w-0"><h3 class="break-words text-base-medium">{deviceLabel(session.userAgent)}{session.current ? " · this device" : ""}</h3><p class="mt-0.5 break-words text-caption text-ink-gray-6">Signed in <DateText value={session.createdAt} /> · expires <DateText value={session.expiresAt} />{session.ipAddress ? ` · ${session.ipAddress}` : ""}</p></div><Button size="sm" variant="outline" theme="red" onClick={() => { if (window.confirm(`Revoke ${session.current ? "this current" : "this"} session?`)) void revoke("one", session.id); }}>Revoke session</Button></article>}</For></div></Show>
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
  return <div class="flex flex-col items-start gap-3"><p class="brain-readable text-interface text-ink-gray-7">Push notifications are attention hints for pending approvals. Decisions always happen here after sign-in and step-up verification.</p><Button variant="outline" theme="blue" iconLeft="lucide-bell" onClick={() => void enable()}>Enable notifications</Button><Show when={state()}><p role="status" class="brain-readable text-interface">{state()}</p></Show></div>;
}
