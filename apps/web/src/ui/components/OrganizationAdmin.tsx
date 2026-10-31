import { createSignal, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Select } from "@talelk/newui-molecules";
import { DataTable, Section } from "@talelk/newui-organisms";
import type { OrganizationAdminCommand, OrganizationDirectorySnapshot, OrganizationMemberView, OrganizationRole } from "@brain/contracts";
import { organizationAuthPolicyQuery, organizationInvitationsQuery, organizationMemberQuery, organizationMembersQuery } from "../../data/governor";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { PageStack } from "./PageLayout";
import { ScreenRegion } from "../screen-region";
import { count, formatDateTime } from "../format";
import { DateText } from "../screen-region";

const roleOptions = [
  { value: "organization-admin", label: "Organization administrator" },
  { value: "security-admin", label: "Security administrator" },
  { value: "tool-publisher", label: "Tool publisher" },
];

export function OrganizationPeople(): JSX.Element {
  const app = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = createSignal("");
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [email, setEmail] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [role, setRole] = createSignal<OrganizationRole>("security-admin");
  const [selectedId, setSelectedId] = createSignal(typeof searchParams.user === "string" ? searchParams.user : "");
  const [detail, setDetail] = createSignal<OrganizationDirectorySnapshot>();
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const read = createScopedRead<OrganizationDirectorySnapshot>({
    scope: app.scope,
    load: (_scope, signal) => organizationMembersQuery({ search: search().trim() || undefined, limit: 100 }, signal),
    isEmpty: (data) => data.members.length === 0,
    refreshMs: 30_000,
  });
  const members = () => read.state().data?.members ?? [];
  const selected = () => members().find((member) => member.principalId === selectedId());
  const version = () => selected()?.version ?? members()[0]?.version ?? 1;

  async function run(commandType: OrganizationAdminCommand["commandType"], payload: OrganizationAdminCommand["payload"], expectedVersion = version()) {
    if (busy()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await app.run(commandType, payload, { expectedVersion });
      setMessage(result.detail);
      setInviteOpen(false); setReason(""); setEmail("");
      await read.refresh({ force: true });
      if (selectedId()) await openDetail(selectedId());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Organization action failed"); }
    finally { setBusy(false); }
  }

  async function openDetail(principalId: string) {
    if (!principalId) { setSelectedId(""); setDetail(undefined); return; }
    setSelectedId(principalId); setError("");
    try {
      const result = await organizationMemberQuery(principalId);
      setDetail(result.snapshot);
      setSearchParams({ user: principalId }, { replace: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load member detail"); }
  }

  function closeDetail() {
    setSelectedId(""); setDetail(undefined); setSearchParams({ user: undefined }, { replace: true });
  }

  onMount(() => { if (selectedId()) void openDetail(selectedId()); });

  return <PageStack>
    <Section title="People" description="Organization membership, Brain roles, security enrollment, and current-organization sessions." surface="card"
      actions={<Button size="lg" variant="solid" theme="blue" iconLeft="lucide-user-plus" onClick={() => setInviteOpen(true)}>Invite person</Button>}>
      <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="No organization members" emptyDescription="Invite the first person to this organization." onRetry={() => void read.refresh({ force: true })}>
        <div class="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
          <TextInput label="Search people" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Name or email" />
          <Button size="lg" variant="outline" onClick={() => void read.refresh({ force: true })}>Search</Button>
          <Select label="Member to manage" value={selectedId() || null} options={members().map((member) => ({ value: member.principalId, label: member.name, description: member.email }))} onValueChange={(value) => void openDetail(value ?? "")} />
        </div>
        <DataTable title="Organization members" selectable={false} hideSearch cardBreakpoint="lg" rows={members().map((member) => ({
          id: member.id, name: member.name, email: member.email, roles: member.roles.join(", ") || "member", status: member.status,
          workspaces: String(member.workspaceCount), sessions: String(member.sessionCount), authentication: `${member.totpEnrolled ? "TOTP" : "No TOTP"} · ${count(member.passkeyCount, "passkey")}`,
        }))} columns={[
          { id: "name", header: "Name", accessorKey: "name", meta: { mobile: "title" } },
          { id: "email", header: "Email", accessorKey: "email", meta: { mobile: "subtitle" } },
          { id: "roles", header: "Brain roles", accessorKey: "roles", meta: { mobile: "meta" } },
          { id: "status", header: "Status", accessorKey: "status", meta: { mobile: "status" } },
          { id: "workspaces", header: "Workspaces", accessorKey: "workspaces", meta: { mobile: "meta" } },
          { id: "sessions", header: "Sessions", accessorKey: "sessions", meta: { mobile: "meta" } },
          { id: "authentication", header: "Authentication", accessorKey: "authentication", meta: { mobile: "meta" } },
        ]} caption={count(members().length, "member")} />
      </ScreenRegion>
    </Section>
    <Show when={message()}><Alert theme="green" variant="outline" title="Organization updated" description={message()} /></Show>
    <Show when={error()}><Alert theme="red" variant="outline" title="Organization action failed" description={error()} /></Show>

    <Dialog.Root open={inviteOpen()} onOpenChange={setInviteOpen}><Dialog.Content size="md">
      <Dialog.Header><Dialog.Title>Invite a person</Dialog.Title><Dialog.Description>The recipient must verify their email and explicitly accept before membership becomes active.</Dialog.Description></Dialog.Header>
      <div class="my-4 flex flex-col gap-4"><TextInput label="Email" type="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} /><TextInput label="Reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></div>
      <Dialog.Footer><Button size="lg" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button><Button size="lg" variant="solid" theme="blue" loading={busy()} disabled={!email().trim() || !reason().trim()} onClick={() => void run("organization.invitation.create", { email: email().trim().toLowerCase(), reason: reason().trim() })}>Send invitation</Button></Dialog.Footer>
    </Dialog.Content></Dialog.Root>

    <Dialog.Root open={Boolean(selected())} onOpenChange={(open) => { if (!open) closeDetail(); }}><Dialog.Content size="lg">
      <Dialog.Header><Dialog.Title>{selected()?.name ?? "Organization member"}</Dialog.Title><Dialog.Description>{selected()?.email} · {selected()?.status}</Dialog.Description></Dialog.Header>
      <Show when={selected()}>{(member) => <PageStack>
        <div class="grid gap-3 sm:grid-cols-2"><KeyValue label="Brain roles" value={member().roles.join(", ") || "Organization member"} /><KeyValue label="Workspace grants" value={String(member().workspaceCount)} /><KeyValue label="Authentication" value={`${member().totpEnrolled ? "TOTP enrolled" : "No TOTP"} · ${count(member().passkeyCount, "passkey")}`} /><KeyValue label="Current-organization sessions" value={String(detail()?.sessions.length ?? member().sessionCount)} /></div>
        <div class="grid gap-3 md:grid-cols-2"><Select label="Role to manage" value={role()} options={roleOptions} onValueChange={(value) => setRole((value ?? "security-admin") as OrganizationRole)} /><TextInput label="Action reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></div>
        <div class="flex flex-wrap gap-2"><Button size="lg" variant="outline" disabled={!reason().trim() || busy()} onClick={() => void run("organization.member.role-grant", { principalId: member().principalId, role: role(), reason: reason().trim() })}>Grant role</Button><Button size="lg" variant="outline" disabled={!reason().trim() || busy()} onClick={() => void run("organization.member.role-revoke", { principalId: member().principalId, role: role(), reason: reason().trim() })}>Revoke role</Button><Button size="lg" variant="outline" theme="red" disabled={!reason().trim() || busy()} onClick={() => void run(member().status === "active" ? "organization.member.suspend" : "organization.member.reactivate", { principalId: member().principalId, reason: reason().trim() })}>{member().status === "active" ? "Suspend from organization" : "Reactivate membership"}</Button></div>
        <Section title="Current-organization sessions" description="Session credentials are not exposed. Revoke access from the organization without affecting other organizations.">
          <Show when={detail()?.sessions.length} fallback={<p>No current-organization sessions.</p>}><For each={detail()?.sessions ?? []}>{(session) => <div class="flex flex-wrap items-center justify-between gap-3 py-2"><span>{session.userAgent || "Browser session"} · expires <DateText value={session.expiresAt} /></span><Button size="lg" variant="outline" theme="red" disabled={!reason().trim() || busy()} onClick={() => void run("organization.session.revoke", { principalId: member().principalId, sessionId: session.id, reason: reason().trim() })}>Revoke</Button></div>}</For></Show>
        </Section>
        <Section title="Security events" description="Redacted authentication and invitation events. No session, passkey, TOTP, or invitation secrets are recorded.">
          <Show when={detail()?.events?.length} fallback={<p>No security events for this member.</p>}><For each={detail()?.events ?? []}>{(event) => <div class="py-2 text-interface"><strong>{event.eventType}</strong> · <DateText value={event.occurredAt} /></div>}</For></Show>
        </Section>
      </PageStack>}</Show>
    </Dialog.Content></Dialog.Root>
  </PageStack>;
}

export function OrganizationInvitations(): JSX.Element {
  const app = useApp();
  const [search, setSearch] = createSignal("");
  const [selectedId, setSelectedId] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const read = createScopedRead<OrganizationDirectorySnapshot>({ scope: app.scope, load: (_scope, signal) => organizationInvitationsQuery({ search: search().trim() || undefined, limit: 100 }, signal), isEmpty: (data) => data.invitations.length === 0, refreshMs: 30_000 });
  const invitations = () => read.state().data?.invitations ?? [];
  const selected = () => invitations().find((invitation) => invitation.id === selectedId());

  async function run(commandType: "organization.invitation.cancel" | "organization.invitation.retry") {
    const invitation = selected(); if (!invitation || !reason().trim() || busy()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const current = await organizationMembersQuery({ limit: 1 });
      const expectedVersion = current.snapshot.members[0]?.version ?? 1;
      const result = await app.run(commandType, { invitationId: invitation.id, reason: reason().trim() }, { expectedVersion });
      setMessage(result.detail); setReason(""); setSelectedId("");
      await read.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invitation action failed"); }
    finally { setBusy(false); }
  }

  return <PageStack><Section title="Invitations" description="Track acceptance and delivery honestly. A pending outbox record is not confirmation of external email delivery." surface="card">
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="No invitations" emptyDescription="Organization invitations will appear here." onRetry={() => void read.refresh({ force: true })}>
      <div class="mb-4 grid gap-3 md:grid-cols-2"><TextInput label="Search invitations" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Email" /><Select label="Invitation to manage" value={selectedId() || null} options={invitations().map((invitation) => ({ value: invitation.id, label: invitation.email, description: `${invitation.status} · ${invitation.deliveryState}` }))} onValueChange={(value) => setSelectedId(value ?? "")} /></div>
      <DataTable title="Organization invitations" selectable={false} hideSearch cardBreakpoint="lg" rows={invitations().map((invitation) => ({ id: invitation.id, email: invitation.email, status: invitation.status, delivery: invitation.deliveryState, attempts: String(invitation.deliveryAttempts), expires: formatDateTime(invitation.expiresAt) }))} columns={[
        { id: "email", header: "Email", accessorKey: "email", meta: { mobile: "title" } },
        { id: "status", header: "Invitation", accessorKey: "status", meta: { mobile: "status" } },
        { id: "delivery", header: "Delivery", accessorKey: "delivery", meta: { mobile: "meta" } },
        { id: "attempts", header: "Attempts", accessorKey: "attempts", meta: { mobile: "meta" } },
        { id: "expires", header: "Expires", accessorKey: "expires", meta: { mobile: "subtitle" } },
      ]} caption={count(invitations().length, "invitation")} />
    </ScreenRegion>
    <Show when={selected()}>{(invitation) => <div class="mt-4 flex flex-col gap-3 rounded-card border border-outline-gray-1 p-card-pad"><p>{invitation().email} · {invitation().status} · {invitation().deliveryState}{invitation().lastError ? ` · ${invitation().lastError}` : ""}</p><TextInput label="Action reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /><div class="flex flex-wrap gap-2"><Show when={invitation().status === "pending"}><Button size="lg" variant="outline" theme="red" loading={busy()} disabled={!reason().trim()} onClick={() => void run("organization.invitation.cancel")}>Cancel invitation</Button></Show><Show when={invitation().status === "pending" && invitation().deliveryState !== "delivered"}><Button size="lg" variant="outline" loading={busy()} disabled={!reason().trim()} onClick={() => void run("organization.invitation.retry")}>Retry delivery</Button></Show></div></div>}</Show>
    <Show when={message()}><Alert theme="green" variant="outline" title="Invitation updated" description={message()} /></Show><Show when={error()}><Alert theme="red" variant="outline" title="Invitation action failed" description={error()} /></Show>
  </Section></PageStack>;
}

export function OrganizationAuthPolicy(): JSX.Element {
  const app = useApp();
  const read = createScopedRead<OrganizationDirectorySnapshot>({ scope: app.scope, load: (_scope, signal) => organizationAuthPolicyQuery(signal), isEmpty: (data) => !data.policy });
  const policy = () => read.state().data?.policy;
  return <Section title="Authentication policy" description="Effective non-secret policy reported by Governor. Runtime secrets are never returned. Changes use reviewed configuration releases, not a second write path." surface="card">
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="Policy unavailable" emptyDescription="Governor did not return authentication policy." onRetry={() => void read.refresh({ force: true })}>
      <Show when={policy()}>{(value) => <div class="grid gap-4 sm:grid-cols-2"><KeyValue label="Password sign-in" value={value().passwordEnabled ? "Enabled · invited users only" : "Disabled"} /><KeyValue label="Passkeys" value={value().passkeyEnabled ? "Enabled · sign-in only" : "Disabled"} /><KeyValue label="OIDC" value={value().oidcEnabled ? "Configured · existing users only" : "Not configured"} /><KeyValue label="Two-factor requirement" value={value().requireTwoFactor ? "Required" : "Optional · exact approvals retain step-up"} /><KeyValue label="Session lifetime" value={`${value().sessionExpiresInSeconds / 3600} hours`} /><KeyValue label="Fresh session window" value={`${value().sessionFreshAgeSeconds} seconds`} /><KeyValue label="Rate-limit storage" value={value().rateLimitStorage} /><KeyValue label="Configuration source" value={value().configurationSource} /></div>}</Show>
    </ScreenRegion>
  </Section>;
}

export function OrganizationMemberSelect(props: { value: string; onChange: (principalId: string) => void }): JSX.Element {
  const [members, setMembers] = createSignal<OrganizationMemberView[]>([]);
  const [error, setError] = createSignal("");
  onMount(() => { void organizationMembersQuery({ limit: 100 }).then((result) => setMembers(result.snapshot.members.filter((member) => member.status === "active"))).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not list members")); });
  return <div><Select label="Organization member" value={props.value || null} options={members().map((member) => ({ value: member.principalId, label: member.name, description: member.email }))} onValueChange={(value) => props.onChange(value ?? "")} /><Show when={error()}><p role="alert" class="text-caption text-ink-red-8">{error()}</p></Show></div>;
}
