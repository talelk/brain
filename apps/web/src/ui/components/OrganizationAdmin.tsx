import { createSignal, For, onMount, Show } from "solid-js";
import { BrainForm } from "./BrainForm";
import type { JSX } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { WorkspaceSection } from "./Domain";import { StatusBadge } from "./StatusBadge";
import { Button, KeyValue, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Pagination, Select } from "@talelk/newui-molecules";
import { DataTable, Section } from "@talelk/newui-organisms";
import type { OrganizationAdminCommand, OrganizationDirectorySnapshot, OrganizationMemberView, OrganizationRole } from "@brain/contracts";
import { organizationAuthPolicyQuery, organizationInvitationsQuery, organizationMemberQuery, organizationMembersQuery } from "../../data/governor";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { PageStack, TechnicalDetails } from "./PageLayout";
import { ScreenRegion } from "../screen-region";
import { count } from "../format";
import { DateText } from "../screen-region";

const roleOptions = [
  { value: "organization-admin", label: "Organization administrator" },
  { value: "security-admin", label: "Security administrator" },
  { value: "tool-publisher", label: "Tool publisher" },
];

const INVITATION_PAGE_SIZE = 25;

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
    <Section title="Organization members" description="Membership, Brain roles, security enrollment and current-organization sessions." surface="card"
      actions={<Button variant="solid" theme="blue" iconLeft="lucide-user-plus" onClick={() => setInviteOpen(true)}>Invite person</Button>}>
      <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="No organization members" emptyDescription="Invite the first person to this organization." onRetry={() => void read.refresh({ force: true })}>
        <div class="mb-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
          <TextInput label="Search people" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Name or email" />
          <Button variant="outline" class="justify-self-start" onClick={() => void read.refresh({ force: true })}>Search</Button>
          <Select label="Member to manage" value={selectedId() || null} options={members().map((member) => ({ value: member.principalId, label: member.name, description: member.email }))} onValueChange={(value) => void openDetail(value ?? "")} />
        </div>
        <DataTable title="Organization members" selectable={false} hideSearch cardBreakpoint="lg" pageSize={25} rows={members().map((member) => ({
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
      <BrainForm bare label="Invite a person" onSubmit={() => { if (email().trim() && reason().trim()) return run("organization.invitation.create", { email: email().trim().toLowerCase(), reason: reason().trim() }); }}>
      <div class="my-3 flex flex-col gap-3"><TextInput label="Email" type="email" required value={email()} onInput={(event) => setEmail(event.currentTarget.value)} /><TextInput label="Reason" required value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></div>
      <Dialog.Footer class="flex-wrap gap-2"><Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button><Button type="submit" variant="solid" theme="blue" loading={busy()} disabled={!email().trim() || !reason().trim()}>Send invitation</Button></Dialog.Footer>
      </BrainForm>
    </Dialog.Content></Dialog.Root>

    <Dialog.Root open={Boolean(selected())} onOpenChange={(open) => { if (!open) closeDetail(); }}><Dialog.Content size="md">
      <Dialog.Header><Dialog.Title>{selected()?.name ?? "Organization member"}</Dialog.Title><Dialog.Description>{selected()?.email} · {selected()?.status}</Dialog.Description></Dialog.Header>
      <Show when={selected()}>{(member) => <PageStack>
        <div class="grid gap-3 sm:grid-cols-2"><KeyValue label="Brain roles" value={<span class="break-words">{member().roles.join(", ") || "Organization member"}</span>} orientation="vertical" /><KeyValue label="Workspace grants" value={String(member().workspaceCount)} orientation="vertical" /><KeyValue label="Authentication" value={`${member().totpEnrolled ? "TOTP enrolled" : "No TOTP"} · ${count(member().passkeyCount, "passkey")}`} orientation="vertical" /><KeyValue label="Current-organization sessions" value={String(detail()?.sessions.length ?? member().sessionCount)} orientation="vertical" /></div>
        <div class="grid gap-2 md:grid-cols-2"><Select label="Role to manage" value={role()} options={roleOptions} onValueChange={(value) => setRole((value ?? "security-admin") as OrganizationRole)} /><TextInput label="Action reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></div>
        <div class="flex flex-wrap gap-2"><Button size="sm" variant="solid" theme="blue" disabled={!reason().trim() || busy()} onClick={() => void run("organization.member.role-grant", { principalId: member().principalId, role: role(), reason: reason().trim() })}>Grant role</Button><Button size="sm" variant="outline" theme="red" disabled={!reason().trim() || busy()} onClick={() => void run("organization.member.role-revoke", { principalId: member().principalId, role: role(), reason: reason().trim() })}>Revoke role</Button><Button size="sm" variant="outline" theme={member().status === "active" ? "red" : "blue"} disabled={!reason().trim() || busy()} onClick={() => void run(member().status === "active" ? "organization.member.suspend" : "organization.member.reactivate", { principalId: member().principalId, reason: reason().trim() })}>{member().status === "active" ? "Suspend from organization" : "Reactivate membership"}</Button></div>
        <Section title="Current-organization sessions" description="Session credentials are not exposed. Revoke access from the organization without affecting other organizations.">
          <Show when={detail()?.sessions.length} fallback={<p class="text-interface text-ink-gray-7">No current-organization sessions.</p>}><div class="brain-queue"><For each={detail()?.sessions ?? []}>{(session) => <div class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-2"><span class="min-w-0 break-words text-interface">{session.userAgent || "Browser session"} · expires <DateText value={session.expiresAt} /></span><Button size="sm" variant="outline" theme="red" disabled={!reason().trim() || busy()} onClick={() => void run("organization.session.revoke", { principalId: member().principalId, sessionId: session.id, reason: reason().trim() })}>Revoke</Button></div>}</For></div></Show>
        </Section>
        <Section title="Security events" description="Redacted authentication and invitation events. No session, passkey, TOTP, or invitation secrets are recorded.">
          <Show when={detail()?.events?.length} fallback={<p class="text-interface text-ink-gray-7">No security events for this member.</p>}><div class="brain-queue"><For each={detail()?.events ?? []}>{(event) => <div class="break-words border-b border-outline-gray-1 py-2 text-interface"><strong class="break-all">{event.eventType}</strong> · <DateText value={event.occurredAt} /></div>}</For></div></Show>
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
  const [invitationPage, setInvitationPage] = createSignal(1);
  const read = createScopedRead<OrganizationDirectorySnapshot>({ scope: app.scope, load: (_scope, signal) => organizationInvitationsQuery({ search: search().trim() || undefined, limit: 100 }, signal), isEmpty: (data) => data.invitations.length === 0, refreshMs: 30_000 });
  const invitations = () => read.state().data?.invitations ?? [];
  const invitationPageCount = () => Math.max(1, Math.ceil(invitations().length / INVITATION_PAGE_SIZE));
  const currentInvitationPage = () => Math.min(invitationPage(), invitationPageCount());
  const invitationRows = () => invitations().slice((currentInvitationPage() - 1) * INVITATION_PAGE_SIZE, currentInvitationPage() * INVITATION_PAGE_SIZE);
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

  return <PageStack><WorkspaceSection title="Invitation lifecycle" description="Intended role, acceptance and delivery are separate facts. A pending outbox record is not confirmation of external email delivery.">
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="No invitations" emptyDescription="There are no pending, accepted or expired invitations. Use People to start the supported invite-only onboarding flow." emptyAction={<A href="/settings?tab=people" class="inline-flex min-h-9 items-center rounded-control border border-outline-gray-2 px-3 text-interface font-medium text-ink-blue-link">Open People to invite</A>} onRetry={() => void read.refresh({ force: true })}>
      <div class="mb-3 grid gap-2 md:grid-cols-2"><TextInput label="Search invitations" value={search()} onInput={(event) => { setSearch(event.currentTarget.value); setInvitationPage(1); }} placeholder="Email" /><Select label="Invitation to manage" value={selectedId() || null} options={invitations().map((invitation) => ({ value: invitation.id, label: invitation.email, description: `${invitation.status} · ${invitation.deliveryState}` }))} onValueChange={(value) => setSelectedId(value ?? "")} /></div>
      <div class="grid gap-3 md:grid-cols-2"><For each={invitationRows()}>{(invitation) => <article class="min-w-0 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-all text-base-medium">{invitation.email}</h3><p class="mt-0.5 break-all text-caption text-ink-gray-6">Invited by {invitation.inviterId}</p></div><StatusBadge status={invitation.status} /></div><dl class="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 text-caption"><div class="min-w-0"><dt class="text-ink-gray-6">Intended role</dt><dd class="mt-0.5 break-words text-interface">{invitation.role}</dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Delivery</dt><dd class="mt-0.5 break-words text-interface">{invitation.deliveryState} · {invitation.deliveryAttempts} attempts</dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Created</dt><dd class="mt-0.5 break-words"><DateText value={invitation.createdAt} /></dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Expires</dt><dd class="mt-0.5 break-words"><DateText value={invitation.expiresAt} /></dd></div></dl><Button size="sm" variant="ghost" class="mt-2 self-start" onClick={() => setSelectedId(invitation.id)}>Manage invitation</Button></article>}</For></div>
      <Show when={invitationPageCount() > 1}><Pagination.Root aria-label="Invitation pagination" class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={invitations().length} pageSize={INVITATION_PAGE_SIZE} page={currentInvitationPage()} onPageChange={setInvitationPage}>
        <Pagination.Range />
        <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
      </Pagination.Root></Show>
    </ScreenRegion>
    <Show when={selected()}>{(invitation) => <div class="mt-3 flex flex-col gap-3 border-y border-outline-gray-1 py-3"><p class="break-all text-interface">{invitation().email} · {invitation().status} · {invitation().deliveryState}{invitation().lastError ? ` · ${invitation().lastError}` : ""}</p><TextInput label="Action reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /><div class="flex flex-wrap gap-2"><Show when={invitation().status === "pending"}><Button size="sm" variant="outline" theme="red" loading={busy()} disabled={!reason().trim()} onClick={() => void run("organization.invitation.cancel")}>Cancel invitation</Button></Show><Show when={invitation().status === "pending" && invitation().deliveryState !== "delivered"}><Button size="sm" variant="outline" loading={busy()} disabled={!reason().trim()} onClick={() => void run("organization.invitation.retry")}>Retry delivery</Button></Show></div></div>}</Show>
    <Show when={message()}><Alert theme="green" variant="outline" title="Invitation updated" description={message()} /></Show><Show when={error()}><Alert theme="red" variant="outline" title="Invitation action failed" description={error()} /></Show>
  </WorkspaceSection></PageStack>;
}

export function OrganizationAuthPolicy(): JSX.Element {
  const app = useApp();
  const read = createScopedRead<OrganizationDirectorySnapshot>({ scope: app.scope, load: (_scope, signal) => organizationAuthPolicyQuery(signal), isEmpty: (data) => !data.policy });
  const policy = () => read.state().data?.policy;
  return <PageStack><Alert theme="blue" variant="outline" title="View-only effective policy" description="These values come from Governor runtime. Changes require the reviewed configuration path; this screen exposes no bypass control or secrets." />
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="Policy unavailable" emptyDescription="Governor did not return authentication policy." onRetry={() => void read.refresh({ force: true })}>
      <Show when={policy()}>{(value) => <PageStack>
        <WorkspaceSection title="Identity and enrollment" description="Who can sign in and which second factors are available."><div class="grid gap-3 sm:grid-cols-2"><KeyValue label="Password sign-in" value={value().passwordEnabled ? "Enabled · invited users only" : "Disabled"} /><KeyValue label="Passkeys" value={value().passkeyEnabled ? "Enabled · sign-in only" : "Disabled"} /><KeyValue label="OIDC" value={value().oidcEnabled ? "Configured · existing users only" : "Not configured"} /><KeyValue label="Two-factor requirement" value={value().requireTwoFactor ? "Required" : "Optional · exact approvals retain step-up"} /></div></WorkspaceSection>
        <WorkspaceSection title="Sessions and abuse controls" description="Current session freshness and rate-limit posture."><div class="grid gap-3 sm:grid-cols-2"><KeyValue label="Session lifetime" value={`${value().sessionExpiresInSeconds / 3600} hours`} /><KeyValue label="Fresh session window" value={`${value().sessionFreshAgeSeconds} seconds`} /><KeyValue label="Rate-limit storage" value={<span class="break-words">{value().rateLimitStorage}</span>} /><KeyValue label="Configuration source" value={<span class="break-all">{value().configurationSource}</span>} /></div></WorkspaceSection>
        <WorkspaceSection title="Effect authorization" description="Authentication policy is distinct from exact effect approval."><p class="brain-prose text-interface text-ink-gray-7">Exact approvals retain one-use evidence bound to the current subject, session and authorization generation. {value().requireTwoFactor ? "This organization also requires authenticator step-up." : "Authenticator step-up is optional for sign-in; it does not remove exact approval evidence."}</p></WorkspaceSection>
        <TechnicalDetails label="Raw effective policy"><pre class="max-w-full overflow-auto whitespace-pre-wrap break-all text-caption">{JSON.stringify(value(), null, 2)}</pre></TechnicalDetails>
      </PageStack>}</Show>
    </ScreenRegion>
  </PageStack>;
}

export function OrganizationMemberSelect(props: { value: string; onChange: (principalId: string) => void }): JSX.Element {
  const [members, setMembers] = createSignal<OrganizationMemberView[]>([]);
  const [error, setError] = createSignal("");
  onMount(() => { void organizationMembersQuery({ limit: 100 }).then((result) => setMembers(result.snapshot.members.filter((member) => member.status === "active"))).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not list members")); });
  return <div><Select label="Organization member" value={props.value || null} options={members().map((member) => ({ value: member.principalId, label: member.name, description: member.email }))} onValueChange={(value) => props.onChange(value ?? "")} /><Show when={error()}><p role="alert" class="text-caption text-ink-red-8">{error()}</p></Show></div>;
}
