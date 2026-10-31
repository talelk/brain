import { DiagnosticExport } from "../ui/components/DiagnosticExport";
import { LocalModelSetup } from "../ui/components/LocalModelSetup";
import { governor } from "../data/client";
import { useApp } from "../ui/app-context";
import { AuthenticatorEnrollment } from "../ui/components/Authentication";
import { PasskeyControls } from "../ui/components/PasskeyControls";
import { OrganizationAuthPolicy, OrganizationInvitations, OrganizationMemberSelect, OrganizationPeople } from "../ui/components/OrganizationAdmin";
import type { JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import { Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Select } from "@talelk/newui-molecules";
import { DataTable, Section, StatGrid } from "@talelk/newui-organisms";
import { useSearchParams } from "@solidjs/router";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import type { AuditEntry, HealthView, MemberGrantView, ConfigExplanation, OrganizationSessionView } from "@brain/contracts";
import { DateText, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { count, formatDateTime } from "../ui/format";
import { ActionFeedback } from "../ui/components/ActionFeedback";
import { RefreshButton } from "../ui/components/primitives";

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
  const principalName = (id: string) => id === props.viewerId ? props.viewerName ?? id : id;
  const degradedHealth = () => props.health && props.health.status !== "healthy" ? props.health : undefined;
  return <BrainPage title="Administration" description="Manage security, releases, integrations, membership, and operational evidence in focused workspaces."
    actions={<RefreshButton onClick={props.onRefresh} label="Refresh" />}>
    <PageStack>
      <Show when={tab() === "setup" && organizationAdmin()}><LocalModelSetup /></Show>
      <Show when={tab() === "security"}><SecurityAndIntegrations area="security" /></Show>
      <Show when={tab() === "integrations"}><SecurityAndIntegrations area="integrations" /></Show>
      <Show when={tab() === "people" && identityAdmin()}><OrganizationPeople /></Show>
      <Show when={tab() === "invitations" && identityAdmin()}><OrganizationInvitations /></Show>
      <Show when={tab() === "policy" && identityAdmin()}><OrganizationAuthPolicy /></Show>
      <Show when={tab() === "health"}><PageStack>
        <Show when={organizationAdmin()}><DiagnosticExport /></Show>
        <Section title="Platform health" description="Current service state reported by Governor." surface="card">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Health unavailable" emptyDescription="The Governor did not return a service snapshot." onRetry={props.onRefresh}>
            <StatGrid compact columns={2} loading={!props.health} stats={(props.health?.services ?? []).map((service) => ({ label: service.id, value: service.status, hint: service.detail, icon: service.status === "healthy" ? "lucide-heart-pulse" : "lucide-circle-pause" }))} />
            <Show when={degradedHealth()} keyed>{(health) => <Alert theme="amber" variant="outline" title="Platform is degraded" description={`${health.pendingOutbox} outbox deliveries are pending (oldest ${health.oldestOutboxAgeMs}ms).`} />}</Show>
          </ScreenRegion>
        </Section>
      </PageStack></Show>
      <Show when={tab() === "members"}><Section title="Workspace access" description="Grant workspace roles only to active organization members. Every change requires a reason; revocation stops new reads and writes." surface="card"
        actions={props.canAdminister ? <Button size="lg" variant="solid" theme="blue" iconLeft="lucide-user-plus" onClick={() => setAccessOpen(true)}>Manage access</Button> : undefined}>
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No members listed" emptyDescription="Nobody has been granted access to this workspace yet." onRetry={props.onRefresh}>
          <DataTable title="Members" selectable={false} hideSearch cardBreakpoint="lg" rows={props.members.map((member) => ({
            id: member.id, principal: principalName(member.principalId), roles: member.roles.join(", ") || "none", version: String(member.version), state: member.revoked ? "revoked" : "active", created: formatDateTime(member.createdAt),
          }))} columns={[
            { id: "principal", header: "Principal", accessorKey: "principal", meta: { mobile: "title" } },
            { id: "roles", header: "Roles", accessorKey: "roles", meta: { mobile: "meta" } },
            { id: "state", header: "State", accessorKey: "state", meta: { mobile: "status" } },
            { id: "version", header: "Version", accessorKey: "version", meta: { mobile: "meta" } },
            { id: "created", header: "Granted", accessorKey: "created", meta: { mobile: "subtitle" } },
          ]} caption={count(props.members.length, "principal")} />
        </ScreenRegion>
      </Section></Show>
      <Show when={tab() === "release"}><Section title="Release onboarding" description="Select an immutable staged release, inspect its complete contents, then activate it explicitly." surface="card">
        <Show when={organizationAdmin()} fallback={<p class="text-interface text-ink-gray-7">Staging a release requires an administrator role.</p>}><InspectRelease onActivate={props.onActivate} /></Show>
      </Section></Show>
      <Show when={tab() === "release"}><Section title="Effective configuration" description="Trace where a value comes from in the active release." surface="card"><PageStack>
        <div class="max-w-xl"><TextInput label="Config pointer" value={activateDigest()} description="For example /workflows/fixture-workflow" onInput={(event) => setActivateDigest(event.currentTarget.value)} /></div>
        <Show when={props.explanation}><div class="grid gap-field-gap lg:grid-cols-2"><KeyValue label="Pointer" value={props.explanation!.pointer} /><KeyValue label="Active digest" value={<code class="break-all">{props.explanation!.configDigest}</code>} orientation="vertical" /><For each={props.explanation!.sources}>{(source) => <KeyValue label={`Rule (${source.rule})`} value={`${source.path}:${source.line}`} orientation="vertical" />}</For></div></Show>
      </PageStack></Section></Show>
      <Show when={tab() === "health"}><Section title="Audit trail" description="Append-only, scoped to this workspace." surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No audited events yet" emptyDescription="Actions appear here as the Governor records them." onRetry={props.onRefresh}>
          <DataTable title="Audit" selectable={false} hideSearch cardBreakpoint="lg" rows={props.audit.map((entry) => ({ id: entry.id, cursor: String(entry.cursor), actor: entry.actorId, action: entry.action, resource: entry.resourceId, at: formatDateTime(entry.occurredAt) }))} columns={[
            { id: "cursor", header: "#", accessorKey: "cursor", meta: { mobile: "subtitle" } },
            { id: "action", header: "Action", accessorKey: "action", meta: { mobile: "title" } },
            { id: "actor", header: "Actor", accessorKey: "actor", meta: { mobile: "meta" } },
            { id: "resource", header: "Resource", accessorKey: "resource", meta: { mobile: "meta" } },
            { id: "at", header: "At", accessorKey: "at", meta: { mobile: "meta" } },
          ]} caption={count(props.audit.length, "event")} />
        </ScreenRegion>
      </Section></Show>
      <Show when={tab() === "security"}><Section title="Notifications" description="Attention hints never replace sign-in and exact review." surface="card"><PushControls /></Section></Show>
      <Dialog.Root open={accessOpen()} onOpenChange={setAccessOpen}><Dialog.Content size="md">
        <Dialog.Header><Dialog.Title>Manage workspace access</Dialog.Title><Dialog.Description>Grant or revoke one role for an active organization member. Both commands require a reason.</Dialog.Description></Dialog.Header>
        <div class="my-4 flex flex-col gap-4"><OrganizationMemberSelect value={principalId()} onChange={setPrincipalId} /><Select label="Role" value={role()} options={[{ value: "viewer", label: "Viewer" }, { value: "operator", label: "Operator" }, { value: "workspace-lead", label: "Workspace lead" }, { value: "approver", label: "Approver" }]} onValueChange={(value) => setRole(value ?? "viewer")} /><TextInput label="Reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></div>
        <Dialog.Footer class="flex-wrap justify-end"><Button size="lg" variant="outline" onClick={() => setAccessOpen(false)}>Cancel</Button><Button size="lg" variant="outline" theme="red" disabled={!principalId().trim() || !reason().trim()} onClick={() => { void props.onRevoke(principalId().trim(), role(), reason().trim()); setAccessOpen(false); }}>Revoke</Button><Button size="lg" variant="solid" theme="blue" disabled={!principalId().trim() || !reason().trim()} onClick={() => { void props.onGrant(principalId().trim(), role(), reason().trim()); setAccessOpen(false); }}>Grant</Button></Dialog.Footer>
      </Dialog.Content></Dialog.Root>
    </PageStack>
  </BrainPage>;
}

function InspectRelease(props: { onActivate: (digest: string, expectedActiveDigest: string | null) => Promise<void> }) {
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
    setBusy(true); setInspection(undefined);  setInspection(undefined);
    try { setInspection(await governor(`/v1/config/releases/${encodeURIComponent(digest())}`)); }
    catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Inspection failed", tone: "error" }); }
    finally { setBusy(false); }
  }
  const current = () => releases().find((release) => release.digest === digest());
  return <PageStack>
    <div class="grid gap-3 rounded-card border border-outline-gray-1 bg-surface-gray-1 p-card-pad lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
      <Select label="Staged release" value={digest() || null} options={releases().map((release) => ({ value: release.digest, label: `${release.workflows} Workflows · ${release.agents} Agents${release.active ? " · active" : ""}`, description: `${formatDateTime(release.createdAt)} · ${release.digest}` }))} onValueChange={(value) => { setDigest(value ?? ""); setInspection(undefined); }} />
      <Button size="lg" variant="outline" onClick={() => void loadReleases()}>Refresh</Button>
      <Button size="lg" variant="solid" theme="blue" onClick={() => void inspect()} disabled={!digest() || busy()} loading={busy()}>Inspect selected release</Button>
    </div>
    <Show when={current()}>{(release) => <p class="text-interface text-ink-gray-7">Source {release().sourceRevision} · {release().assets} supporting assets · {release().active ? "currently active" : "staged, not active"}</p>}</Show>
    <Show when={!releases().length && !error()}><p>No staged releases yet. Compile the complete starter directory, then refresh this list.</p></Show>
    <Show when={inspection()} keyed>{(release) => <PageStack>
      <div class="rounded-card border border-outline-gray-1 p-card-pad"><h3 class="text-base-medium">Release contents</h3><ul class="mt-3 grid gap-2 sm:grid-cols-2"><For each={release.manifest.documents ?? []}>{(document) => <li class="text-interface text-ink-gray-7"><strong>{document.kind}</strong> · {document.id}</li>}</For></ul></div>
      <TechnicalDetails label="Technical manifest"><pre class="brain-readable whitespace-pre-wrap text-caption">{JSON.stringify(release.manifest, null, 2)}</pre></TechnicalDetails>
      <Button size="lg" variant="solid" theme="blue" iconLeft="lucide-check" class="self-start" disabled={busy()} onClick={async () => { setBusy(true); setError(undefined); try { await props.onActivate(release.digest, release.expectedActiveDigest); setInspection(undefined); setError({ text: "Release activated. Inspect Agents and Workflows to continue.", tone: "success" }); await loadReleases(); } catch (reason) { setError({ text: reason instanceof Error ? reason.message : "Activation failed", tone: "error" }); } finally { setBusy(false); } }}>Activate inspected release</Button>
    </PageStack>}</Show>
    <ActionFeedback tone={error()?.tone} message={error()?.text} title={error()?.tone === "success" ? "Release active" : undefined} />
    <TechnicalDetails label="Compile a new release"><p>Compile the complete directory, including Markdown instructions, tool scripts, and schemas:</p><code class="mt-2 block break-all">brain config compile examples/v1/starter-release</code></TechnicalDetails>
  </PageStack>;
}

function SecurityAndIntegrations(props: { area: "security" | "integrations" }) {
  const app = useApp(); const [password, setPassword] = createSignal(""); const [message, setMessage] = createSignal("");
  return <PageStack>
    <Show when={props.area === "security"}><PageStack><Section title="Security" description={app.identity()?.requireTwoFactor ? "Authenticator enrollment and TOTP step-up are required." : "Two-factor authentication is optional. Exact approvals still require one-use session evidence."} surface="card"><PageStack>
      <Show when={!app.identity()?.totpEnrolled} fallback={
        <>
          <p>Authenticator enrolled. Recovery codes are available when you enroll a replacement authenticator.</p>
          <Show when={!app.identity()?.requireTwoFactor}>
            <div class="flex max-w-xl flex-col gap-3">
              <TextInput label="Confirm password to disable authenticator" type="password" autocomplete="current-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} />
              <Button size="lg" variant="outline" theme="red" disabled={!password()} class="self-start" onClick={async () => {
                const entered = password(); setPassword("");
                try {
                  await governor("/api/auth/two-factor/disable", { password: entered });
                  await app.reloadIdentity(); setMessage("Authenticator disabled.");
                } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Could not disable the authenticator"); }
              }}>Disable authenticator</Button>
            </div>
          </Show>
        </>
      }>
        <AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={() => app.reloadIdentity()} />
      </Show>
      <Show when={message()}><Alert theme="red" variant="outline" title="Security action failed" description={message()} /></Show>
    </PageStack></Section><PasskeyControls /><SessionControls /></PageStack></Show>
    <Show when={props.area === "integrations"}><Section title="Integrations" description="External administration applications open separately. Brain does not forward your credentials." surface="card">
      <div class="grid gap-3 sm:grid-cols-2"><Show when={app.identity()?.integrations.memoryUiUrl}><a class="flex min-h-20 items-center gap-3 rounded-card border border-outline-gray-1 p-card-pad text-ink-blue-link hover:bg-surface-gray-1 focus-visible:focus-ring" href={app.identity()!.integrations.memoryUiUrl!} target="_blank" rel="noopener noreferrer"><span class="lucide-database size-5" aria-hidden="true" /><span class="font-medium">Open Memory UI</span><span class="lucide-external-link ms-auto size-4" aria-hidden="true" /></a></Show></div>
      <Show when={!app.identity()?.integrations.memoryUiUrl}><p>No external administration links are configured. Better Auth administration is built into People, Invitations, and Authentication policy.</p></Show>
    </Section></Show>
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
  return <Section title="Active sign-in sessions" description="Only your sessions are listed. Session credentials remain on the server and are never returned to browser JavaScript." surface="card"
    actions={<div class="flex flex-wrap gap-2"><Button size="lg" variant="outline" onClick={() => void revoke("others")}>Revoke other sessions</Button><Button size="lg" variant="outline" theme="red" onClick={() => { if (window.confirm("Revoke every session, including this one?")) void revoke("all"); }}>Revoke all</Button></div>}>
    <Show when={sessions().length} fallback={<p class="brain-empty-inline">No active sessions were returned.</p>}><div class="divide-y divide-outline-gray-1 brain-row-list"><For each={sessions()}>{(session) => <article class="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div><h3 class="text-base-medium">{session.userAgent || "Browser session"}{session.current ? " · current" : ""}</h3><p class="text-caption text-ink-gray-6">Started <DateText value={session.createdAt} /> · expires <DateText value={session.expiresAt} />{session.ipAddress ? ` · ${session.ipAddress}` : ""}</p></div><Button size="lg" variant="outline" theme="red" onClick={() => void revoke("one", session.id)}>Revoke session</Button></article>}</For></div></Show>
    <Show when={message()}><p role="status">{message()}</p></Show>
  </Section>;
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
  return <div class="flex flex-col items-start gap-4"><p class="brain-readable text-interface text-ink-gray-7">Push notifications are attention hints for pending approvals. Decisions always happen here after sign-in and step-up verification.</p><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-bell" onClick={() => void enable()}>Enable notifications</Button><Show when={state()}><p role="status">{state()}</p></Show></div>;
}
