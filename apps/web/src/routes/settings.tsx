import { governor } from "../data/client";
import { useApp } from "../ui/app-context";
import { AuthenticatorEnrollment } from "../ui/components/Authentication";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { DataTable, Section, StatGrid } from "@talelk/newui-organisms";
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
      <SecurityAndIntegrations />
      <Section title="Platform health" surface="card">
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
      </Section>

      <Section title="Workspace members" description="Roles are granted per principal with a reason; revocation stops new reads and writes." surface="card">
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
      </Section>

      <Section title="Release onboarding" description="Stage configuration documents and activate them as the release this workspace runs against." surface="card">
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
            <Show when={props.canAdminister}>
              <TextInput label="Config digest to activate" value={activateDigest()} onInput={(e) => setActivateDigest(e.currentTarget.value)} />
              <Button disabled={activateDigest().trim().length === 0} class="min-h-11"
                onClick={() => void props.onActivate(activateDigest().trim(), props.activeConfigDigest ?? "")}>
                Activate config revision
              </Button>
            </Show>
          </div>
        </Show>
      </Section>

      <Section title="Audit trail" description="Append-only, scoped to this workspace." surface="card">
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
      </Section>

      <Section title="Notifications" surface="card">
        <PushControls />
      </Section>
    </div>
  );
}

/**
 * Stage-and-activate path for a workspace with no release yet. Documents are
 * pasted with a `%%% <path>` separator line before each file, mirroring the
 * setup API's {path, text} documents; the revision is optional (the server
 * digests what it receives).
 */
function InspectRelease(props: { onActivate: (digest: string, expectedActiveDigest: string | null) => Promise<void> }) {
  const [digest,setDigest] = createSignal("");
  const [inspection,setInspection] = createSignal<{ digest: string; expectedActiveDigest: string | null; manifest: unknown }>();
  const [error,setError] = createSignal(""); const [busy,setBusy] = createSignal(false);
  async function inspect() {
    setBusy(true); setError(""); setInspection(undefined);
    try { setInspection(await governor(`/v1/config/releases/${encodeURIComponent(digest().trim())}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "Inspection failed"); }
    finally { setBusy(false); }
  }
  return <div class="flex flex-col gap-field-gap">
    <p>Compile the complete directory, including Markdown instructions, tool scripts and schemas:</p>
    <code>brain config compile examples/v1/starter-release</code>
    <p>Paste the returned digest to inspect its immutable manifest before activation.</p>
    <TextInput label="Staged release digest" value={digest()} onInput={(e) => { setDigest(e.currentTarget.value); setInspection(undefined); }} />
    <Button onClick={() => void inspect()} disabled={!digest().trim() || busy()} loading={busy()}>Inspect release</Button>
    <Show when={inspection()} keyed>{(release) => <>
      <pre class="whitespace-pre-wrap break-words">{JSON.stringify(release.manifest,null,2)}</pre>
      <Button disabled={busy()} onClick={async () => {
        setBusy(true); setError("");
        try { await props.onActivate(release.digest,release.expectedActiveDigest); setInspection(undefined); setError("Release activated. Inspect Agents and Workflows to continue."); }
        catch (e) { setError(e instanceof Error ? e.message : "Activation failed"); }
        finally { setBusy(false); }
      }}>Activate inspected release</Button>
    </>}</Show>
    <Show when={error()}><p role="status">{error()}</p></Show>
  </div>;
}

function SecurityAndIntegrations() {
  const app = useApp(); const [password,setPassword] = createSignal(""); const [message,setMessage] = createSignal("");
  return <>
    <Section title="Security" description={app.identity()?.requireTwoFactor ? "Authenticator enrollment and TOTP step-up are required." : "Two-factor authentication is optional. Exact approvals still require one-use session evidence."} surface="card">
      <Show when={!app.identity()?.totpEnrolled} fallback={<>
        <p>Authenticator enrolled. Recovery codes are available when you enroll a replacement authenticator.</p>
        <Show when={!app.identity()?.requireTwoFactor}>
          <TextInput label="Confirm password to disable authenticator" type="password" autocomplete="current-password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
          <Button disabled={!password()} onClick={async () => {
            const entered=password(); setPassword("");
            try { await governor("/api/auth/two-factor/disable",{password:entered}); await app.reloadIdentity(); }
            catch(e) { setMessage(e instanceof Error ? e.message : "Could not disable authenticator"); }
          }}>Disable authenticator</Button>
        </Show>
      </>}><AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={app.reloadIdentity} /></Show>
      <Show when={message()}><p role="alert">{message()}</p></Show>
    </Section>
    <Section title="Integrations" description="External administration applications open separately. Brain does not forward your credentials." surface="card">
      <Show when={app.identity()?.integrations.memoryUiUrl}><a href={app.identity()!.integrations.memoryUiUrl!} target="_blank" rel="noopener noreferrer">Open Memory UI</a></Show>
      <Show when={app.identity()?.integrations.betterAuthAdminUiUrl}><a href={app.identity()!.integrations.betterAuthAdminUiUrl!} target="_blank" rel="noopener noreferrer">Open Better Auth Admin</a></Show>
      <Show when={!app.identity()?.integrations.memoryUiUrl && !app.identity()?.integrations.betterAuthAdminUiUrl}><p>No external administration links are configured.</p></Show>
    </Section>
  </>;
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
