import { governor } from "../data/client";
import { useApp } from "../ui/app-context";
import { AuthenticatorEnrollment } from "../ui/components/Authentication";
import type { JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import { Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Select, TabButtons } from "@talelk/newui-molecules";
import { DataTable, Section, StatGrid } from "@talelk/newui-organisms";
import { useSearchParams } from "@solidjs/router";
import { PageIntro } from "../ui/components/PageLayout";
import type { AuditEntry, HealthView, MemberGrantView, ConfigExplanation } from "@brain/contracts";
import { ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { count } from "../ui/format";

/**
 * Administration (document 21): members, the audit trail, platform health and
 * the effective configuration. Every mutation here is an explicit command with
 * a reason — there is no inline "edit row" path for an authority.
 */
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
  /** The signed-in principal, so the members table can name people. */
  viewerId?: string;
  viewerName?: string;
}): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = () => typeof searchParams.tab === "string" ? searchParams.tab : "security";
  const setTab = (value: string) => setSearchParams({ tab: value });
  const [principalId, setPrincipalId] = createSignal("");
  const [role, setRole] = createSignal("viewer");
  const [reason, setReason] = createSignal("");
  const [activateDigest, setActivateDigest] = createSignal("");
  const principalName = (principalId: string) => (principalId === props.viewerId ? props.viewerName ?? principalId : principalId);
  const degradedHealth = () => {
    const health = props.health;
    return health && health.status !== "healthy" ? health : undefined;
  };

  return (
    <div class="flex flex-col gap-field-gap">
      <PageIntro title="Workspace administration" description="Security, releases, integrations, membership and operational evidence in focused workspaces." />
      <TabButtons label="Settings areas" value={tab()} onValueChange={setTab} options={[
        { value: "security", label: "Security" }, { value: "release", label: "Release" }, { value: "integrations", label: "Integrations" },
        { value: "members", label: "Members" }, { value: "health", label: "Health & audit" },
      ]} />
      <Show when={tab() === "security"}><SecurityAndIntegrations area="security" /></Show>
      <Show when={tab() === "integrations"}><SecurityAndIntegrations area="integrations" /></Show>
      <Show when={tab() === "health"}><Section title="Platform health" surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Health unavailable"
          emptyDescription="The Governor did not return a service snapshot." onRetry={props.onRefresh}>
          <StatGrid columns={2} loading={!props.health} stats={(props.health?.services ?? []).map((service) => ({
            label: service.id, value: service.status, hint: service.detail,
          }))} />
          <Show when={degradedHealth()} keyed>{(health) => (
            <Alert theme="amber" variant="outline" title="Platform is degraded"
              description={`${health.pendingOutbox} outbox deliveries are pending (oldest ${health.oldestOutboxAgeMs}ms).`} />
          )}</Show>
        </ScreenRegion>
      </Section></Show>

      <Show when={tab() === "members"}><Section title="Workspace members" description="Roles are granted per principal with a reason; revocation stops new reads and writes." surface="card">
        <Show when={props.canAdminister}>
          <div class="flex flex-wrap items-end gap-control-gap pb-field">
            <div class="min-w-56"><TextInput label="Principal id" value={principalId()} onInput={(e) => setPrincipalId(e.currentTarget.value)} /></div>
            <div class="min-w-40"><Select label="Role" value={role()} options={[{ value: "viewer", label: "Viewer" }, { value: "operator", label: "Operator" }, { value: "workspace-lead", label: "Workspace lead" }, { value: "approver", label: "Approver" }]} onValueChange={(v) => setRole(v ?? "viewer")} /></div>
            <div class="min-w-56 flex-1"><TextInput label="Reason" value={reason()} onInput={(e) => setReason(e.currentTarget.value)} /></div>
            <Button disabled={!principalId().trim() || !reason().trim()} class="min-h-11"
              onClick={() => void props.onGrant(principalId().trim(), role(), reason().trim())}>Grant</Button>
            <Button variant="outline" theme="red" disabled={!principalId().trim() || !reason().trim()} class="min-h-11"
              onClick={() => void props.onRevoke(principalId().trim(), role(), reason().trim())}>Revoke</Button>
          </div>
        </Show>
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No members listed"
          emptyDescription="Nobody has been granted access to this workspace yet." onRetry={props.onRefresh}>
          <DataTable title="Members" selectable={false} hideSearch rows={props.members.map((m) => ({
            id: m.id, principal: principalName(m.principalId), roles: m.roles.join(", ") || "none", version: String(m.version), state: m.revoked ? "revoked" : "active", created: new Date(m.createdAt).toLocaleString(),
          }))} columns={[
            { id: "principal", header: "Principal", accessorKey: "principal" },
            { id: "roles", header: "Roles", accessorKey: "roles" },
            { id: "state", header: "State", accessorKey: "state" },
            { id: "version", header: "Version", accessorKey: "version" },
            { id: "created", header: "Granted", accessorKey: "created" },
          ]} caption={count(props.members.length, "principal")} />
        </ScreenRegion>
      </Section></Show>

      <Show when={tab() === "release"}><Section title="Release onboarding" description="Select an immutable staged release, inspect its complete contents, then activate it explicitly." surface="card">
        <Show when={props.canAdminister} fallback={
          <p class="text-base text-ink-gray-7">Staging a release requires an administrator role.</p>
        }>
          <InspectRelease onActivate={props.onActivate} />
        </Show>
      </Section>

      <Section title="Effective configuration" description="Where a value comes from in the active release." surface="card">
        <div class="flex flex-wrap items-end gap-control-gap pb-field">
          <div class="min-w-64 flex-1"><TextInput label="Config pointer" value={activateDigest()} description="For example /workflows/fixture-workflow" onInput={(e) => setActivateDigest(e.currentTarget.value)} /></div>
        </div>
        <Show when={props.explanation}>
          <div class="flex flex-col gap-field-gap">
            <KeyValue label="Pointer" value={props.explanation!.pointer} />
            <KeyValue label="Active digest" value={<code class="break-all">{props.explanation!.configDigest}</code>} orientation="vertical" />
            <For each={props.explanation!.sources}>{(source) => (
              <KeyValue label={`Rule (${source.rule})`} value={`${source.path}:${source.line}`} orientation="vertical" />
            )}</For>
          </div>
        </Show>
      </Section></Show>

      <Show when={tab() === "health"}><Section title="Audit trail" description="Append-only, scoped to this workspace." surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No audited events yet"
          emptyDescription="Actions appear here as the Governor records them." onRetry={props.onRefresh}>
          <DataTable title="Audit" selectable={false} hideSearch rows={props.audit.map((entry) => ({
            id: entry.id, cursor: String(entry.cursor), actor: entry.actorId, action: entry.action, resource: entry.resourceId, at: new Date(entry.occurredAt).toLocaleString(),
          }))} columns={[
            { id: "cursor", header: "#", accessorKey: "cursor" },
            { id: "action", header: "Action", accessorKey: "action" },
            { id: "actor", header: "Actor", accessorKey: "actor" },
            { id: "resource", header: "Resource", accessorKey: "resource" },
            { id: "at", header: "At", accessorKey: "at" },
          ]} caption={count(props.audit.length, "event")} />
        </ScreenRegion>
      </Section></Show>

      <Show when={tab() === "security"}><Section title="Notifications" surface="card">
        <PushControls />
      </Section></Show>
    </div>
  );
}

/** Select, inspect and explicitly activate an immutable staged release. */
function InspectRelease(props: { onActivate: (digest: string, expectedActiveDigest: string | null) => Promise<void> }) {
  type ReleaseSummary = { digest: string; sourceRevision: string; createdAt: string; active: boolean; agents: number; workflows: number; assets: number };
  const [digest,setDigest] = createSignal("");
  const [releases,setReleases] = createSignal<ReleaseSummary[]>([]);
  const [inspection,setInspection] = createSignal<{ digest: string; expectedActiveDigest: string | null; manifest: { documents?: { id: string; kind: string; path: string }[] } }>();
  const [error,setError] = createSignal(""); const [busy,setBusy] = createSignal(false);
  async function loadReleases() {
    try {
      const result = await governor<{ items: ReleaseSummary[] }>("/v1/config/releases");
      setReleases(result.items);
      if (!digest() && result.items[0]) setDigest(result.items[0].digest);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not list staged releases"); }
  }
  onMount(() => void loadReleases());
  async function inspect() {
    setBusy(true); setError(""); setInspection(undefined);
    try { setInspection(await governor(`/v1/config/releases/${encodeURIComponent(digest())}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "Inspection failed"); }
    finally { setBusy(false); }
  }
  const current = () => releases().find((release) => release.digest === digest());
  return <div class="flex flex-col gap-field-gap">
    <div class="flex flex-wrap items-end gap-control-gap">
      <div class="min-w-64 flex-1"><Select label="Staged release" value={digest() || null} options={releases().map((release) => ({ value: release.digest, label: `${release.workflows} Workflows · ${release.agents} Agents${release.active ? " · active" : ""}`, description: `${new Date(release.createdAt).toLocaleString()} · ${release.digest}` }))}
        onValueChange={(value) => { setDigest(value ?? ""); setInspection(undefined); }} /></div>
      <Button onClick={() => void inspect()} disabled={!digest() || busy()} loading={busy()} class="min-h-11">Inspect selected release</Button>
      <Button variant="outline" onClick={() => void loadReleases()} class="min-h-11">Refresh</Button>
    </div>
    <Show when={current()}>{(release) => <p class="text-base text-ink-gray-7">Source {release().sourceRevision} · {release().assets} supporting assets · {release().active ? "currently active" : "staged, not active"}</p>}</Show>
    <Show when={!releases().length && !error()}><p>No staged releases yet. Compile the complete starter directory, then refresh this list.</p></Show>
    <Show when={inspection()} keyed>{(release) => <>
      <div class="rounded-card border border-outline-gray-1 p-3"><h3 class="text-base-medium">Release contents</h3><ul class="mt-2 grid gap-1 sm:grid-cols-2"><For each={release.manifest.documents ?? []}>{(document) => <li class="text-base text-ink-gray-7"><strong>{document.kind}</strong> · {document.id}</li>}</For></ul></div>
      <details><summary class="cursor-pointer text-base-medium">Technical manifest</summary><pre class="brain-readable whitespace-pre-wrap pt-2 text-caption">{JSON.stringify(release.manifest,null,2)}</pre></details>
      <Button disabled={busy()} class="min-h-11" onClick={async () => {
        setBusy(true); setError("");
        try { await props.onActivate(release.digest,release.expectedActiveDigest); setInspection(undefined); setError("Release activated. Inspect Agents and Workflows to continue."); await loadReleases(); }
        catch (e) { setError(e instanceof Error ? e.message : "Activation failed"); }
        finally { setBusy(false); }
      }}>Activate inspected release</Button>
    </>}</Show>
    <Show when={error()}><p role={error().includes("activated") ? "status" : "alert"}>{error()}</p></Show>
    <details><summary class="cursor-pointer text-base-medium">Compile a new release</summary><p class="mt-2">Compile the complete directory, including Markdown instructions, tool scripts and schemas:</p><code class="mt-1 block break-all">brain config compile examples/v1/starter-release</code></details>
  </div>;
}

function SecurityAndIntegrations(props: { area: "security" | "integrations" }) {
  const app = useApp(); const [password,setPassword] = createSignal(""); const [message,setMessage] = createSignal("");
  return <>
    <Show when={props.area === "security"}><><Section title="Security" description={app.identity()?.requireTwoFactor ? "Authenticator enrollment and TOTP step-up are required." : "Two-factor authentication is optional by default. Exact approvals still require one-use session evidence."} surface="card">
      <Show when={!app.identity()?.totpEnrolled} fallback={<>
        <p>Authenticator enrolled. Recovery codes are available when you enroll a replacement authenticator.</p>
        <Show when={!app.identity()?.requireTwoFactor}>
          <TextInput label="Confirm password to disable authenticator" type="password" autocomplete="current-password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
          <Button disabled={!password()} class="min-h-11" onClick={async () => {
            const entered=password(); setPassword("");
            try { await governor("/api/auth/two-factor/disable",{password:entered}); await app.reloadIdentity(); }
            catch(e) { setMessage(e instanceof Error ? e.message : "Could not disable authenticator"); }
          }}>Disable authenticator</Button>
        </Show>
      </>}><AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={app.reloadIdentity} /></Show>
      <Show when={message()}><p role="alert">{message()}</p></Show>
    </Section><SessionControls /></></Show>
    <Show when={props.area === "integrations"}><Section title="Integrations" description="External administration applications open separately. Brain does not forward your credentials." surface="card">
      <div class="brain-action-bar"><Show when={app.identity()?.integrations.memoryUiUrl}><a class="text-ink-blue-8 underline" href={app.identity()!.integrations.memoryUiUrl!} target="_blank" rel="noopener noreferrer">Open Memory UI</a></Show>
      <Show when={app.identity()?.integrations.betterAuthAdminUiUrl}><a class="text-ink-blue-8 underline" href={app.identity()!.integrations.betterAuthAdminUiUrl!} target="_blank" rel="noopener noreferrer">Open Better Auth Admin</a></Show></div>
      <Show when={!app.identity()?.integrations.memoryUiUrl && !app.identity()?.integrations.betterAuthAdminUiUrl}><p>No external administration links are configured.</p></Show>
    </Section></Show>
  </>;
}

function SessionControls(): JSX.Element {
  type Session = { id: string; token: string; userAgent?: string; ipAddress?: string; createdAt: string; expiresAt: string };
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [message, setMessage] = createSignal("");
  async function load() {
    try { setSessions(await governor<Session[]>("/api/auth/list-sessions")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Sessions are unavailable"); }
  }
  onMount(() => void load());
  return <Section title="Active sign-in sessions" description="Better Auth lists only your sessions. Revocation takes effect on the server; session tokens are never displayed." surface="card">
    <Show when={sessions().length} fallback={<p class="text-base text-ink-gray-7">No active sessions were returned.</p>}>
      <For each={sessions()}>{(session) => <article class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-3 last:border-0">
        <div><h3 class="text-base-medium">{session.userAgent || "Browser session"}</h3><p class="text-caption text-ink-gray-6">Started {new Date(session.createdAt).toLocaleString()} · expires {new Date(session.expiresAt).toLocaleString()}{session.ipAddress ? ` · ${session.ipAddress}` : ""}</p></div>
        <Button variant="outline" theme="red" class="min-h-11" onClick={() => void (async () => {
          try { await governor("/api/auth/revoke-session", { token: session.token }); setMessage("Session revoked."); await load(); }
          catch (error) { setMessage(error instanceof Error ? error.message : "Revocation failed"); }
        })()}>Revoke session</Button>
      </article>}</For>
    </Show>
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
      const keyBytes = Uint8Array.from(atob(publicKey.replace(/-/gu, "+").replace(/_/gu, "/")), (ch) => ch.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes as BufferSource });
      await fetch("/v1/push/subscriptions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
      setState("Notifications enabled. They are attention hints only — decisions still happen here after sign-in and step-up.");
    } catch (e) {
      setState(e instanceof Error ? e.message : "Could not enable notifications.");
    }
  }
  return (
    <>
      <p class="text-base text-ink-gray-7">Push notifications are attention hints for pending approvals. Decisions always happen here after sign-in and step-up verification.</p>
      <Button onClick={() => void enable()} class="min-h-11">Enable notifications</Button>
      <Show when={state()}><p role="status">{state()}</p></Show>
    </>
  );
}
