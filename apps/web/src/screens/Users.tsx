import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { Avatar, Badge, Button } from "@talelk/newui-atoms";
import { EmptyState, Tabs, toast } from "@talelk/newui-molecules";
import { FilterBar, Section, StatGrid, type DataTableColumn } from "@talelk/newui-organisms";
import type { GroupRow, UserRow, UserState } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { t, tn } from "../i18n";
import { ago, day } from "../lib/format";
import { ConfirmButton, Failure, Icon, Ready } from "../components/bits";
import { Head } from "../components/Shell";
import { Table } from "../components/Table";
import { GroupDialog, InstanceRole, InviteDialog, StatusBadge, UserDrawer } from "../components/UserAdmin";

const STATES: readonly UserState[] = ["active", "invited", "deactivated"];
const PAGE = 25;

/** What an invitation not yet used lets an admin do: make a new link (the earlier one stops working), or revoke it. */
function InvitedActions(props: { user: UserRow; onResend: () => void }): JSX.Element {
  const revoke = useAction(async () => { await command("invitation.revoke", { invitationId: props.user.invitationId ?? "" }); toast.success({ title: t("users.revoked", { email: props.user.email }) }); });
  return (
    <span class="flex flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" iconLeft="lucide-send" onClick={props.onResend}>{t("users.action.resend")}</Button>
      <ConfirmButton icon="lucide-ban" label={t("users.action.revoke")} confirm={t("users.revoke.confirm", { email: props.user.email })} busy={revoke.busy()} onConfirm={() => void revoke.run()} />
      <Failure error={revoke.error()} />
    </span>
  );
}

function Groups(props: { groups: readonly GroupRow[]; onEdit: (group: GroupRow | undefined) => void }): JSX.Element {
  const remove = useAction((groupId: string) => command("group.delete", { groupId }));
  return (
    <Section title={t("users.tab.groups")} description={t("groups.text")} headingLevel={2} actions={<Button variant="outline" size="md" iconLeft="lucide-plus" onClick={() => props.onEdit(undefined)}>{t("groups.new")}</Button>}>
      <Failure error={remove.error()} class="mb-3" />
      <Show when={props.groups.length > 0} fallback={<EmptyState size="sm" bordered icon="lucide-users" title={t("groups.none")} description={t("groups.none.text")} action={<Button variant="solid" theme="blue" size="md" onClick={() => props.onEdit(undefined)}>{t("groups.new")}</Button>} />}>
        <ul class="grid gap-3 lg:grid-cols-2">
          <For each={props.groups}>
            {(group) => (
              <li class="flex flex-col gap-3 rounded-2xl border border-rule bg-paper p-4">
                <div class="flex items-start gap-2">
                  <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-lilac text-violet-text"><Icon name="lucide-users" /></span>
                  <div class="min-w-0 flex-1"><h3 class="truncate t-head text-ink">{group.name}</h3><p class="t-small text-ink-2">{tn("groups.people", group.members.length)}</p></div>
                  <Button variant="ghost" size="sm" onClick={() => props.onEdit(group)}>{t("groups.edit.action")}</Button>
                  <ConfirmButton label={t("action.delete")} confirm={t("groups.delete.confirm", { name: group.name })} busy={remove.busy()} onConfirm={() => void remove.run(group.id)} />
                </div>
                <p class="line-clamp-2 t-small text-ink-2">{group.members.map((member) => member.name).join(", ") || t("share.groups.empty")}</p>
                <p class="flex flex-wrap gap-1.5">
                  <For each={group.grants} fallback={<span class="t-small text-ink-3">{t("groups.grants.none")}</span>}>{(grant) => <Badge theme={grant.role === "admin" ? "violet" : grant.role === "member" ? "blue" : "gray"} size="md" label={`${grant.name} · ${t(`role.${grant.role}`)}`} />}</For>
                </p>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Section>
  );
}

/** Instance admins: everyone who can sign in to this Brain, invitations, groups, and one person's detail with their access, sessions and sign-ins. */
export default function UsersScreen(): JSX.Element {
  const session = useSession();
  const [tab, setTab] = createSignal("people");
  const [search, setSearch] = createSignal("");
  const [asked, setAsked] = createSignal("");
  const [status, setStatus] = createSignal<UserState | "">("");
  const [role, setRole] = createSignal<"" | "admin" | "member">("");
  const [page, setPage] = createSignal(0);
  // The server finds the people: the search waits for a pause in typing, and any change of what is asked starts at the first page.
  createEffect(on(search, (text) => { const wait = setTimeout(() => setAsked(text.trim()), 250); onCleanup(() => clearTimeout(wait)); }));
  createEffect(on([asked, status, role], () => setPage(0), { defer: true }));
  const list = useQuery("users.list", () => (session.user().instanceAdmin ? { ...(asked() ? { search: asked() } : {}), ...(status() ? { status: status() as UserState } : {}), ...(role() ? { role: role() as "admin" | "member" } : {}), page: page(), pageSize: PAGE } : undefined));
  // While another page is on its way the last one stays, so the search box keeps its place.
  const kept = createMemo<ReturnType<typeof list.data>>((last) => list.data() ?? last, undefined);
  const [inviting, setInviting] = createSignal(false);
  const [prefill, setPrefill] = createSignal<{ email: string; grants: NonNullable<UserRow["grants"]> }>();
  const [open, setOpen] = createSignal<string>();
  const [editing, setEditing] = createSignal<{ group?: GroupRow }>();
  const invite = (user?: UserRow): void => { setPrefill(user?.grants ? { email: user.email, grants: user.grants } : undefined); setInviting(true); };
  const clear = (): void => { setSearch(""); setStatus(""); setRole(""); };
  const columns: DataTableColumn<UserRow>[] = [
    { id: "person", header: t("users.col.person"), accessorFn: (user) => `${user.name} ${user.email}`, meta: { mobile: "title" }, cell: (ctx) => {
      const user = ctx.row.original;
      return (
        <button type="button" class="flex min-w-0 items-center gap-3 text-start focus-visible:focus-ring" disabled={user.status === "invited"} onClick={() => setOpen(user.id)}>
          <Avatar size="md" theme="gray" label={user.name || user.email} />
          <span class="flex min-w-0 flex-col"><span class="truncate font-medium text-ink-gray-9">{user.name || user.email}</span><Show when={user.name}><span class="truncate text-ink-gray-7">{user.email}</span></Show></span>
        </button>
      );
    } },
    { accessorKey: "status", header: t("users.col.status"), meta: { mobile: "status" }, cell: (ctx) => (
      <span class="flex flex-col items-start gap-0.5">
        <StatusBadge status={ctx.row.original.status} />
        <Show when={ctx.row.original.status === "invited"}>
          <span class="t-small text-ink-2">{(ctx.row.original.expiresAt ?? 0) < Date.now() ? t("users.invite.expired") : t("users.invite.expires", { when: day(ctx.row.original.expiresAt ?? 0) })}</span>
          <InvitedActions user={ctx.row.original} onResend={() => invite(ctx.row.original)} />
        </Show>
      </span>
    ) },
    { id: "role", header: t("users.col.role"), accessorFn: (user) => (user.instanceAdmin ? "admin" : "member"), meta: { mobile: "meta" }, cell: (ctx) => <InstanceRole admin={ctx.row.original.instanceAdmin} /> },
    { id: "groups", header: t("users.col.groups"), enableSorting: false, cell: (ctx) => <span class="flex flex-wrap gap-1"><For each={ctx.row.original.groups} fallback={<span class="text-ink-gray-5">—</span>}>{(group) => <Badge theme="gray" size="sm" label={group.name} />}</For></span> },
    { accessorKey: "workspaces", header: t("users.col.workspaces"), meta: { align: "end" }, cell: (ctx) => <span class="tabular-nums">{ctx.row.original.workspaces}</span> },
    { id: "last", header: t("users.col.lastSignIn"), accessorFn: (user) => user.lastSignInAt ?? 0, meta: { mobile: "subtitle" }, cell: (ctx) => <span class="whitespace-nowrap text-ink-gray-7">{ctx.row.original.lastSignInAt ? ago(ctx.row.original.lastSignInAt) : t("users.never")}</span> },
    { accessorKey: "createdAt", header: t("users.col.created"), cell: (ctx) => <span class="whitespace-nowrap text-ink-gray-7">{day(ctx.row.original.createdAt)}</span> },
  ];

  return (
    <>
      <Head title={t("users.title")} text={t("users.title")} description={t("users.text")}
        actions={session.user().instanceAdmin ? <Button variant="solid" theme="blue" size="md" iconLeft="lucide-user-plus" onClick={() => invite()}>{t("users.invite")}</Button> : undefined} />
      <Show when={session.user().instanceAdmin} fallback={<EmptyState bordered icon="lucide-lock" title={t("users.adminOnly")} description={t("users.adminOnly.text")} />}>
        <Ready shape="table" data={kept()} error={list.error()} retry={list.refetch}>
          {(loaded) => {
            const count = (state: UserState): number => loaded().counts[state];
            const pages = (): number => Math.max(1, Math.ceil(loaded().total / PAGE));
            return (
              <div class="flex flex-col gap-6">
                <StatGrid columns={4} stats={[
                  { label: t("users.status.active"), icon: "lucide-user-check", value: count("active"), hint: t("users.stat.active") },
                  { label: t("users.status.invited"), icon: "lucide-mail", value: count("invited"), hint: t("users.stat.invited") },
                  { label: t("users.status.deactivated"), icon: "lucide-user-x", value: count("deactivated"), hint: t("users.stat.deactivated") },
                  { label: t("users.stat.admins.label"), icon: "lucide-shield-check", value: loaded().counts.admins, hint: t("users.stat.admins") },
                ]} class="max-md:grid-cols-2" />
                <Tabs.Root value={tab()} onValueChange={setTab} variant="underline" size="md">
                  <Tabs.List aria-label={t("users.title")}>
                    <Tabs.Trigger value="people">{t("users.tab.people")}</Tabs.Trigger>
                    <Tabs.Trigger value="groups">{t("users.tab.groups")} <span class="ms-1 text-ink-3">{loaded().groups.length}</span></Tabs.Trigger>
                  </Tabs.List>
                  <Tabs.Content value="people" class="flex flex-col gap-3 pt-5">
                    <FilterBar surface="bare" query={{ value: search(), placeholder: t("users.search"), onInput: setSearch, width: "20rem" }}
                      selects={[
                        { label: t("users.col.status"), width: "11rem", value: status(), options: [{ label: t("users.filter.all"), value: "" }, ...STATES.map((value) => ({ label: t(`users.status.${value}`), value }))], onValueChange: (value) => setStatus((value ?? "") as UserState | "") },
                        { label: t("users.col.role"), width: "12rem", value: role(), options: [{ label: t("users.filter.all"), value: "" }, { label: t("users.irole.admin"), value: "admin" }, { label: t("users.irole.member"), value: "member" }], onValueChange: (value) => setRole((value ?? "") as "" | "admin" | "member") },
                      ]}
                      chips={[...(status() ? [{ label: `${t("users.col.status")}: ${t(`users.status.${status() as UserState}`)}`, onRemove: () => setStatus("") }] : []), ...(role() ? [{ label: `${t("users.col.role")}: ${t(role() === "admin" ? "users.irole.admin" : "users.irole.member")}`, onRemove: () => setRole("") }] : [])]}
                      onClearAll={clear} />
                    {/* The table sizes its page once, so it is made again when the number of rows changes. */}
                    <For each={[JSON.stringify(loaded().users)]}>{() => <Table title={t("users.title")} rows={[...loaded().users]} columns={columns} count={tn("table.users", loaded().total)} emptyTitle={t("users.none.match")} emptyHint={t("users.none.match.text")} onClearFilters={clear} />}</For>
                    <Show when={pages() > 1}>
                      <nav class="flex items-center justify-end gap-2" aria-label={t("users.page.label")}>
                        <Button variant="outline" size="sm" iconLeft="lucide-chevron-left" disabled={page() === 0} onClick={() => setPage(page() - 1)}>{t("users.page.prev")}</Button>
                        <span class="t-small tabular-nums text-ink-2" role="status">{t("users.page.of", { page: page() + 1, pages: pages() })}</span>
                        <Button variant="outline" size="sm" iconRight="lucide-chevron-right" disabled={page() + 1 >= pages()} onClick={() => setPage(page() + 1)}>{t("users.page.next")}</Button>
                      </nav>
                    </Show>
                  </Tabs.Content>
                  <Tabs.Content value="groups" class="pt-5"><Groups groups={loaded().groups} onEdit={(group) => setEditing({ ...(group ? { group } : {}) })} /></Tabs.Content>
                </Tabs.Root>
                <InviteDialog open={inviting()} onOpenChange={setInviting} groups={loaded().groups} workspaces={loaded().workspaces} prefill={prefill()} />
                <GroupDialog open={editing() !== undefined} onOpenChange={(next) => { if (!next) setEditing(undefined); }} group={editing()?.group} workspaces={loaded().workspaces} />
              </div>
            );
          }}
        </Ready>
        <UserDrawer userId={open()} onClose={() => setOpen(undefined)} />
      </Show>
    </>
  );
}
