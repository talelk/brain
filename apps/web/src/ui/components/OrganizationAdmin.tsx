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

/** The link the invited person opens; the same one the email carries. */
const invitationLink = (invitationId: string) => `${window.location.origin}/accept-invitation/${encodeURIComponent(invitationId)}`;

function InviteLink(props: { link: string }): JSX.Element {
  const [copied, setCopied] = createSignal("");
  async function copy() {
    try { await navigator.clipboard.writeText(props.link); setCopied("Link copied."); }
    catch { setCopied("Could not copy automatically. Select the link and copy it."); }
  }
  return <div class="my-3 flex flex-col gap-2">
    <TextInput label="Invitation link" readOnly value={props.link} onFocus={(event) => event.currentTarget.select()} />
    <div class="flex flex-wrap items-center gap-2"><Button variant="outline" iconLeft="lucide-copy" onClick={() => void copy()}>Copy link</Button><Show when={copied()}><span role="status" class="text-caption text-ink-gray-7">{copied()}</span></Show></div>
  </div>;
}

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
  const [inviteError, setInviteError] = createSignal("");
  const [invited, setInvited] = createSignal<{ email: string; link?: string }>();
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
      setMessage(result.detail === "Applied." ? "Done." : result.detail);
      setReason("");
      await read.refresh({ force: true });
      if (selectedId()) await openDetail(selectedId());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Organization action failed"); }
    finally { setBusy(false); }
  }

  async function invite() {
    const address = email().trim().toLowerCase();
    if (busy() || !address || !reason().trim()) return;
    setInviteError("");
    if (members().some((member) => member.email.toLowerCase() === address)) { setInviteError(`${address} is already a member of this organization. Give them access to a workspace under Access instead.`); return; }
    setBusy(true);
    try {
      const result = await app.run("organization.invitation.create", { email: address, reason: reason().trim() }, { expectedVersion: version() });
      if (!result.accepted) throw new Error(result.detail);
      setInvited({ email: address, link: result.resourceId ? invitationLink(result.resourceId) : undefined });
      setReason(""); setEmail("");
      await read.refresh({ force: true });
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "";
      setInviteError(!text || /internal operation failed/iu.test(text) ? "Brain could not create this invitation. Check the email address and try again; if it keeps failing, look at Health." : text);
    } finally { setBusy(false); }
  }

  function closeInvite() { setInviteOpen(false); setInvited(undefined); setInviteError(""); }

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
    <Section title="Organization members" description="Organization administrators manage people and releases, security administrators manage sign-in and sessions, tool publishers add tools. Roles here are separate from workspace access, which is set under Access." surface="card"
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

    <Dialog.Root open={inviteOpen()} onOpenChange={(open) => { if (!open) closeInvite(); else setInviteOpen(true); }}><Dialog.Content size="md">
      <Show when={invited()} fallback={<>
        <Dialog.Header><Dialog.Title>Invite a person</Dialog.Title><Dialog.Description>They join the organization once they verify their email and accept. Joining does not give access to any workspace; do that under Access.</Dialog.Description></Dialog.Header>
        <BrainForm bare label="Invite a person" onSubmit={() => invite()}>
          <div class="my-3 flex flex-col gap-3"><TextInput label="Email" type="email" required value={email()} onInput={(event) => { setEmail(event.currentTarget.value); setInviteError(""); }} /><TextInput label="Reason" required description="Kept in the record of who invited whom." value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></div>
          <Show when={inviteError()}><Alert theme="red" variant="outline" title="Invitation not sent" description={inviteError()} /></Show>
          <Dialog.Footer class="flex-wrap gap-2"><Button variant="outline" onClick={closeInvite}>Cancel</Button><Button type="submit" variant="solid" theme="blue" loading={busy()} disabled={!email().trim() || !reason().trim()}>Send invitation</Button></Dialog.Footer>
        </BrainForm>
      </>}>{(sent) => <>
        <Dialog.Header><Dialog.Title>Invitation created for {sent().email}</Dialog.Title><Dialog.Description>Brain queued an email, but a queued email is not proof it arrived. If they are waiting, send them this link yourself.</Dialog.Description></Dialog.Header>
        <Show when={sent().link} fallback={<p class="my-3 text-interface text-ink-gray-7">Open Invitations to copy the link.</p>}>{(link) => <InviteLink link={link()} />}</Show>
        <Dialog.Footer class="flex-wrap gap-2"><Button variant="solid" theme="blue" onClick={closeInvite}>Done</Button></Dialog.Footer>
      </>}</Show>
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

function deliveryText(invitation: { status: string; deliveryState: string; deliveryAttempts: number; lastError?: string }): string {
  if (invitation.status === "accepted") return "Joined";
  if (invitation.status === "canceled" || invitation.deliveryState === "cancelled") return "Cancelled";
  if (invitation.status === "expired") return "Expired; invite them again";
  if (invitation.deliveryState === "failed") return `Email failed${invitation.lastError ? `: ${invitation.lastError}` : ""}. Share the link instead.`;
  if (invitation.deliveryState === "delivered") return "Email handed to the mail server; arrival is not confirmed";
  if (invitation.deliveryState === "not-queued") return "No email was sent. Share the link yourself.";
  return "Email waiting to be sent. Share the link if they are waiting.";
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
  const [names, setNames] = createSignal(new Map<string, string>());
  onMount(() => { void organizationMembersQuery({ limit: 100 }).then((result) => setNames(new Map(result.snapshot.members.flatMap((member) => [[member.id, member.name || member.email], [member.principalId, member.name || member.email]] as [string, string][])))).catch(() => undefined); });
  const who = (id: string) => names().get(id) ?? "a former member";

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

  return <PageStack><WorkspaceSection title="Invitations sent" description="Pending means the person has not joined yet. A queued email is not proof it arrived, so share the link directly if someone is waiting.">
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="No invitations" emptyDescription="There are no pending, accepted or expired invitations. Use People to start the supported invite-only onboarding flow." emptyAction={<A href="/settings?tab=people" class="inline-flex min-h-9 items-center rounded-control border border-outline-gray-2 px-3 text-interface font-medium text-ink-blue-link">Open People to invite</A>} onRetry={() => void read.refresh({ force: true })}>
      <div class="mb-3 grid gap-2 md:grid-cols-2"><TextInput label="Search invitations" value={search()} onInput={(event) => { setSearch(event.currentTarget.value); setInvitationPage(1); }} placeholder="Email" /><Select label="Invitation to manage" value={selectedId() || null} options={invitations().map((invitation) => ({ value: invitation.id, label: invitation.email, description: `${invitation.status} · ${invitation.deliveryState}` }))} onValueChange={(value) => setSelectedId(value ?? "")} /></div>
      <div class="grid gap-3 md:grid-cols-2"><For each={invitationRows()}>{(invitation) => <article class="min-w-0 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-all text-base-medium">{invitation.email}</h3><p class="mt-0.5 break-all text-caption text-ink-gray-6">Invited by {who(invitation.inviterId)}</p></div><StatusBadge status={invitation.status} /></div><dl class="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 text-caption"><div class="min-w-0"><dt class="text-ink-gray-6">Intended role</dt><dd class="mt-0.5 break-words text-interface">{invitation.role}</dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Delivery</dt><dd class="mt-0.5 break-words text-interface">{deliveryText(invitation)}</dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Created</dt><dd class="mt-0.5 break-words"><DateText value={invitation.createdAt} /></dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Expires</dt><dd class="mt-0.5 break-words"><DateText value={invitation.expiresAt} /></dd></div></dl><Button size="sm" variant="outline" class="mt-3 self-start" onClick={() => setSelectedId(invitation.id)}>{invitation.status === "pending" ? "Get link or cancel" : "Details"}</Button></article>}</For></div>
      <Show when={invitationPageCount() > 1}><Pagination.Root aria-label="Invitation pagination" class="mt-3 flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-3" count={invitations().length} pageSize={INVITATION_PAGE_SIZE} page={currentInvitationPage()} onPageChange={setInvitationPage}>
        <Pagination.Range />
        <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
      </Pagination.Root></Show>
    </ScreenRegion>
    <Show when={selected()}>{(invitation) => <div class="mt-3 flex flex-col gap-3 border-y border-outline-gray-1 py-3"><p class="break-all text-interface">{invitation().email} · {deliveryText(invitation())}</p><Show when={invitation().status === "pending"}><InviteLink link={invitationLink(invitation().id)} /></Show><Show when={invitation().status === "pending"}><TextInput label="Reason to cancel or resend" description="Required for either action; kept in the record." value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></Show><div class="flex flex-wrap gap-2"><Show when={invitation().status === "pending"}><Button size="sm" variant="outline" theme="red" loading={busy()} disabled={!reason().trim()} onClick={() => void run("organization.invitation.cancel")}>Cancel invitation</Button></Show><Show when={invitation().status === "pending" && invitation().deliveryState !== "delivered"}><Button size="sm" variant="outline" loading={busy()} disabled={!reason().trim()} onClick={() => void run("organization.invitation.retry")}>Send the email again</Button></Show></div></div>}</Show>
    <Show when={message()}><Alert theme="green" variant="outline" title="Invitation updated" description={message()} /></Show><Show when={error()}><Alert theme="red" variant="outline" title="Invitation action failed" description={error()} /></Show>
  </WorkspaceSection></PageStack>;
}

export function OrganizationAuthPolicy(): JSX.Element {
  const app = useApp();
  const read = createScopedRead<OrganizationDirectorySnapshot>({ scope: app.scope, load: (_scope, signal) => organizationAuthPolicyQuery(signal), isEmpty: (data) => !data.policy });
  const policy = () => read.state().data?.policy;
  return <PageStack><Alert theme="blue" variant="outline" title="Read-only" description="These values come from the server configuration and cannot be changed here. Ask whoever runs the server to change them." />
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle="Policy unavailable" emptyDescription="Brain did not return authentication policy." onRetry={() => void read.refresh({ force: true })}>
      <Show when={policy()}>{(value) => <PageStack>
        <WorkspaceSection title="How people sign in" description="Which ways of signing in are switched on for this organization."><div class="grid gap-3 sm:grid-cols-2"><KeyValue label="Password sign-in" value={value().passwordEnabled ? "On · only people you invited" : "Off"} /><KeyValue label="Passkeys" value={value().passkeyEnabled ? "On · for signing in" : "Off"} /><KeyValue label="Company single sign-on" value={value().oidcEnabled ? "On · existing members only" : "Not configured"} /><KeyValue label="Authenticator app (two-factor)" value={value().requireTwoFactor ? "Required" : "Optional · approving an action still asks for confirmation"} /></div></WorkspaceSection>
        <WorkspaceSection title="Sessions" description="How long a sign-in lasts before people must sign in again."><div class="grid gap-3 sm:grid-cols-2"><KeyValue label="Stay signed in for" value={`${value().sessionExpiresInSeconds / 3600} hours`} /><KeyValue label="Sensitive changes need a sign-in within" value={`${Math.round(value().sessionFreshAgeSeconds / 60)} minutes`} /></div></WorkspaceSection>
        <WorkspaceSection title="Approving actions" description="Signing in and approving an action are separate checks."><p class="brain-prose text-interface text-ink-gray-7">Every approval is confirmed again for that exact action, however the person signed in. {value().requireTwoFactor ? "This organization also requires an authenticator code." : "An authenticator code is optional."}</p></WorkspaceSection>
        <TechnicalDetails label="Raw policy (rate limits, source)"><pre class="max-w-full overflow-auto whitespace-pre-wrap break-all text-caption">{JSON.stringify(value(), null, 2)}</pre></TechnicalDetails>
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
