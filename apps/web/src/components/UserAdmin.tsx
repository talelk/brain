import { createEffect, createSignal, on, onCleanup, For, Show, type JSX } from "solid-js";
import { Avatar, Badge, Button, Checkbox, TextInput } from "@talelk/newui-atoms";
import { Dialog, Select, toast } from "@talelk/newui-molecules";
import type { AccessRow, GroupRow, Grants, LinkOutput, Role, SessionRow, SignInRow, UserDetail, UserRow, UserState } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { t } from "../i18n";
import { ago, dateTime } from "../lib/format";
import { ROLES } from "../lib/model";
import { ConfirmButton, Failure, Icon, Ready } from "./bits";
import { Rows } from "./fields";

/** The pieces of the Users and Profile screens: the one-use link, invitations, the person's detail, groups, sessions. */

const roleOptions = (): { label: string; value: string; description: string }[] => ROLES.map((role) => ({ label: t(`role.${role}`), value: role, description: t(`role.${role}.help`) }));
export const STATUS_THEME: Record<UserState, "green" | "amber" | "gray"> = { active: "green", invited: "amber", deactivated: "gray" };

export const StatusBadge = (props: { status: UserState }): JSX.Element => <Badge theme={STATUS_THEME[props.status]} size="md" label={t(`users.status.${props.status}`)} />;
export const InstanceRole = (props: { admin: boolean }): JSX.Element => (
  <Show when={props.admin} fallback={<span class="text-ink-gray-7">{t("users.irole.member")}</span>}>
    <Badge theme="violet" size="md" prefix={<Icon name="lucide-shield-check" class="size-3" />} label={t("users.irole.admin")} />
  </Show>
);

/** "Chrome on Linux", from the browser's own words; the person sees which device is which. */
export function deviceOf(agent: string | null): string {
  if (!agent) return t("sessions.unknown");
  const browser = /Edg\//u.test(agent) ? "Edge" : /Firefox\//u.test(agent) ? "Firefox" : /Chrome\//u.test(agent) ? "Chrome" : /Safari\//u.test(agent) ? "Safari" : undefined;
  const system = /Android/u.test(agent) ? "Android" : /iPhone|iPad/u.test(agent) ? "iOS" : /Windows/u.test(agent) ? "Windows" : /Mac OS X/u.test(agent) ? "macOS" : /Linux/u.test(agent) ? "Linux" : undefined;
  return browser && system ? t("sessions.device", { browser, system }) : browser ?? system ?? t("sessions.unknown");
}

/** A link shown once, ready to copy. */
export function LinkBox(props: { link: string; label: string }): JSX.Element {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.link);
      toast.success({ title: t("link.copied") });
    } catch { /* the field is selected by a click instead */ }
  };
  return (
    <div class="flex flex-col gap-2">
      <TextInput size="md" label={props.label} readOnly value={props.link} class="t-code code-ltr" onFocus={(event) => event.currentTarget.select()} />
      <div><Button variant="outline" size="md" iconLeft="lucide-copy" onClick={() => void copy()}>{t("link.copy")}</Button></div>
    </div>
  );
}

/** Invite by email: an instance role, workspace roles and groups. The answer is a link to copy. */
export function InviteDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; groups: readonly GroupRow[]; workspaces: ReadonlyArray<{ id: string; name: string }>; prefill?: { email: string; grants: Grants } | undefined }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [admin, setAdmin] = createSignal(false);
  const [grants, setGrants] = createSignal<Array<{ workspaceId: string; role: Role }>>([]);
  const [groups, setGroups] = createSignal<string[]>([]);
  const [made, setMade] = createSignal<{ link: string; expiresAt: number; mail: "off" | "queued"; email: string }>();
  const reset = (): void => {
    setEmail(props.prefill?.email ?? ""); setAdmin(props.prefill?.grants.instanceAdmin ?? false);
    setGrants([...(props.prefill?.grants.workspaces ?? [])]); setGroups([...(props.prefill?.grants.groups ?? [])]); setMade(undefined);
  };
  const invite = useAction(async () => {
    const answer = await command("user.invite", { email: email(), instanceAdmin: admin(), workspaces: grants().filter((grant) => grant.workspaceId !== ""), groups: groups() });
    setMade({ link: answer.link, expiresAt: answer.expiresAt, mail: answer.mail, email: email().trim().toLowerCase() });
  });
  const free = (taken: string): Array<{ label: string; value: string }> => props.workspaces.filter((workspace) => workspace.id === taken || !grants().some((grant) => grant.workspaceId === workspace.id)).map((workspace) => ({ label: workspace.name, value: workspace.id }));
  createEffect(on(() => props.open, (open) => { if (open) { reset(); invite.clear(); } }));
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content size="lg">
        <Dialog.Header><Dialog.Title>{made() ? t("invite.done.title") : t("invite.title")}</Dialog.Title><Dialog.Description>{made() ? t("invite.done.text", { when: dateTime(made()?.expiresAt ?? 0) }) : t("invite.text")}</Dialog.Description></Dialog.Header>
        <Show when={made()} fallback={
          <form class="mt-4 flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void invite.run(); }}>
            <TextInput size="md" type="email" label={t("signin.email")} value={email()} onInput={(event) => setEmail(event.currentTarget.value)} required autocomplete="off" />
            <Select size="md" label={t("invite.irole")} options={[{ label: t("users.irole.member"), value: "member", description: t("invite.irole.member.help") }, { label: t("users.irole.admin"), value: "admin", description: t("invite.irole.admin.help") }]} value={admin() ? "admin" : "member"} onValueChange={(value) => setAdmin(value === "admin")} />
            <Rows label={t("invite.workspaces")} items={grants()} onChange={setGrants} add={t("invite.workspace.add")} blank={() => ({ workspaceId: props.workspaces.find((workspace) => !grants().some((grant) => grant.workspaceId === workspace.id))?.id ?? "", role: "member" as Role })}>
              {(row, change) => (
                <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <Select size="md" label={t("invite.workspace")} options={free(row().workspaceId)} value={row().workspaceId} onValueChange={(value) => { if (value) change({ ...row(), workspaceId: value }); }} />
                  <Select size="md" label={t("people.role")} options={roleOptions()} value={row().role} onValueChange={(value) => { if (value) change({ ...row(), role: value as Role }); }} />
                </div>
              )}
            </Rows>
            <Show when={props.groups.length > 0}>
              <fieldset class="min-w-0">
                <legend class="mb-1.5 t-small font-medium text-ink-2">{t("invite.groups")}</legend>
                <div class="flex flex-wrap gap-x-6 gap-y-2">
                  <For each={props.groups}>{(group) => <Checkbox size="md" label={group.name} checked={groups().includes(group.id)} onCheckedChange={(on) => setGroups(on ? [...groups(), group.id] : groups().filter((id) => id !== group.id))} />}</For>
                </div>
              </fieldset>
            </Show>
            <Failure error={invite.error()} />
            <div class="flex justify-end gap-2"><Button variant="ghost" size="md" onClick={() => props.onOpenChange(false)}>{t("action.cancel")}</Button><Button type="submit" variant="solid" theme="blue" size="md" loading={invite.busy()}>{t("invite.submit")}</Button></div>
          </form>
        }>
          {(done) => (
            <div class="mt-4 flex flex-col gap-4">
              <LinkBox link={done().link} label={t("invite.link")} />
              <p class="t-small text-ink-2">{done().mail === "queued" ? t("invite.done.mailed", { email: done().email }) : t("invite.done.nomail")}</p>
              <div class="flex justify-end"><Button variant="solid" theme="blue" size="md" onClick={() => props.onOpenChange(false)}>{t("invite.done.close")}</Button></div>
            </div>
          )}
        </Show>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** A group: its name, its people and its roles on workspaces. */
export function GroupDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; group?: GroupRow | undefined; workspaces: ReadonlyArray<{ id: string; name: string }> }): JSX.Element {
  const [name, setName] = createSignal("");
  const [members, setMembers] = createSignal<string[]>([]);
  const [grants, setGrants] = createSignal<Array<{ workspaceId: string; role: Role }>>([]);
  const [search, setSearch] = createSignal("");
  // The server finds the people to pick from; the group's own members stay on the list whatever the search says.
  const [asked, setAsked] = createSignal("");
  createEffect(on(search, (text) => { const wait = setTimeout(() => setAsked(text.trim()), 250); onCleanup(() => clearTimeout(wait)); }));
  const found = useQuery("users.list", () => (props.open ? { ...(asked() ? { search: asked() } : {}), status: "active" as const, pageSize: 50 } : undefined));
  const shown = (): ReadonlyArray<{ id: string; name: string; email: string }> => {
    const people = (found.data()?.users ?? []).map((person) => ({ id: person.id, name: person.name, email: person.email }));
    const own = (props.group?.members ?? []).filter((member) => !people.some((person) => person.id === member.userId) && `${member.name} ${member.email}`.toLowerCase().includes(asked().toLowerCase())).map((member) => ({ id: member.userId, name: member.name, email: member.email }));
    return [...own, ...people];
  };
  const save = useAction(async () => {
    await command("group.set", { ...(props.group ? { groupId: props.group.id } : {}), name: name(), memberIds: members(), grants: grants().filter((grant) => grant.workspaceId !== "") });
    toast.success({ title: t("groups.saved", { name: name().trim() }) });
    props.onOpenChange(false);
  });
  const free = (taken: string): Array<{ label: string; value: string }> => props.workspaces.filter((workspace) => workspace.id === taken || !grants().some((grant) => grant.workspaceId === workspace.id)).map((workspace) => ({ label: workspace.name, value: workspace.id }));
  const start = (): void => {
    setName(props.group?.name ?? ""); setMembers((props.group?.members ?? []).map((member) => member.userId));
    setGrants((props.group?.grants ?? []).map((grant) => ({ workspaceId: grant.workspaceId, role: grant.role }))); setSearch(""); save.clear();
  };
  createEffect(on(() => props.open, (open) => { if (open) start(); }));
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content size="lg">
        <Dialog.Header><Dialog.Title>{props.group ? t("groups.edit") : t("groups.new")}</Dialog.Title><Dialog.Description>{t("groups.text")}</Dialog.Description></Dialog.Header>
        <form class="mt-4 flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void save.run(); }}>
          <TextInput size="md" label={t("field.name")} value={name()} onInput={(event) => setName(event.currentTarget.value)} required maxlength={60} />
          <fieldset class="min-w-0">
            <legend class="mb-1.5 t-small font-medium text-ink-2">{t("groups.members")} <span class="text-ink-3">· {members().length}</span></legend>
            <TextInput size="md" type="search" aria-label={t("users.search")} placeholder={t("users.search")} value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
            <ul class="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto rounded-xl border border-rule p-2">
              <For each={shown()} fallback={<li class="px-2 py-1 t-small text-ink-3">{t("users.none.match")}</li>}>
                {(person) => <li><Checkbox size="md" label={<span class="flex min-w-0 flex-wrap items-baseline gap-x-2"><span class="font-medium">{person.name}</span><span class="t-small text-ink-2">{person.email}</span></span>} checked={members().includes(person.id)} onCheckedChange={(on) => setMembers(on ? [...members(), person.id] : members().filter((id) => id !== person.id))} /></li>}
              </For>
            </ul>
          </fieldset>
          <Rows label={t("groups.grants")} items={grants()} onChange={setGrants} add={t("invite.workspace.add")} blank={() => ({ workspaceId: props.workspaces.find((workspace) => !grants().some((grant) => grant.workspaceId === workspace.id))?.id ?? "", role: "member" as Role })}>
            {(row, change) => (
              <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Select size="md" label={t("invite.workspace")} options={free(row().workspaceId)} value={row().workspaceId} onValueChange={(value) => { if (value) change({ ...row(), workspaceId: value }); }} />
                <Select size="md" label={t("people.role")} options={roleOptions()} value={row().role} onValueChange={(value) => { if (value) change({ ...row(), role: value as Role }); }} />
              </div>
            )}
          </Rows>
          <Failure error={save.error()} />
          <div class="flex justify-end gap-2"><Button variant="ghost" size="md" onClick={() => props.onOpenChange(false)}>{t("action.cancel")}</Button><Button type="submit" variant="solid" theme="blue" size="md" loading={save.busy()}>{t("action.save")}</Button></div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Open sessions, each with the device and when it began; `onEnd` shows a button beside each one that is not this one. */
export function SessionList(props: { sessions: readonly SessionRow[]; userId: string; self: boolean }): JSX.Element {
  const end = useAction((sessionId: string) => command("session.revoke", { userId: props.userId, sessionId }));
  return (
    <>
      <ul class="divide-y divide-(--rule)">
        <For each={props.sessions} fallback={<li class="py-2 t-small text-ink-3">{t("sessions.none")}</li>}>
          {(session) => (
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <Icon name={/Android|iPhone|iPad/u.test(session.userAgent ?? "") ? "lucide-smartphone" : "lucide-monitor"} class="size-4 text-ink-3" />
              <span class="min-w-0 flex-1 basis-48">
                <span class="block truncate t-text font-medium text-ink">{deviceOf(session.userAgent)}<Show when={session.current}> <Badge theme="blue" size="sm" label={t("sessions.current")} /></Show></span>
                <span class="flex flex-wrap gap-x-3 t-small text-ink-2"><span>{t("sessions.since", { when: ago(session.createdAt) })}</span><Show when={session.ipAddress}><span class="code-ltr">{session.ipAddress}</span></Show></span>
              </span>
              <Show when={!session.current || !props.self}><Button variant="ghost" size="sm" loading={end.busy()} onClick={() => void end.run(session.id)}>{t("sessions.end")}</Button></Show>
            </li>
          )}
        </For>
      </ul>
      <Failure error={end.error()} class="mt-2" />
    </>
  );
}

/** Sign-ins and refused passwords, newest first. */
export function SignInLog(props: { entries: readonly SignInRow[] }): JSX.Element {
  return (
    <ul class="divide-y divide-(--rule)">
      <For each={props.entries} fallback={<li class="py-2 t-small text-ink-3">{t("signins.none")}</li>}>
        {(entry) => (
          <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <Icon name={entry.ok ? "lucide-log-in" : "lucide-shield-alert"} class={`size-4 ${entry.ok ? "text-ink-3" : "text-needs-text"}`} />
            <span class="min-w-0 flex-1 basis-40"><span class={`block truncate t-text ${entry.ok ? "text-ink" : "font-medium text-needs-text"}`}>{entry.ok ? t("signins.ok") : t("signins.failed")}</span><span class="flex flex-wrap gap-x-3 t-small text-ink-2"><span>{deviceOf(entry.userAgent)}</span><Show when={entry.ipAddress}><span class="code-ltr">{entry.ipAddress}</span></Show></span></span>
            <span class="t-small text-ink-2 whitespace-nowrap">{ago(entry.at)}</span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** Every workspace a person reaches, the role they have there, and whether it is their own or a group's. */
export function AccessMatrix(props: { rows: readonly AccessRow[] }): JSX.Element {
  return (
    <ul class="divide-y divide-(--rule)">
      <For each={props.rows} fallback={<li class="py-2 t-small text-ink-3">{t("access.none")}</li>}>
        {(row) => (
          <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            <span class="min-w-0 flex-1 basis-40 truncate t-text font-medium text-ink">{row.name}</span>
            <Badge theme={row.role === "admin" ? "violet" : row.role === "member" ? "blue" : "gray"} size="md" label={t(`role.${row.role}`)} />
            <span class="flex basis-full flex-wrap gap-x-3 t-small text-ink-2">
              <Show when={row.direct}>{(direct) => <span>{t("access.direct", { role: t(`role.${direct()}`) })}</span>}</Show>
              <For each={row.groups}>{(group) => <span>{t("access.group", { group: group.name, role: t(`role.${group.role}`) })}</span>}</For>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

const Block = (props: { title: string; children: JSX.Element }): JSX.Element => (
  <section class="flex flex-col gap-1" aria-label={props.title}><h3 class="t-head text-ink">{props.title}</h3>{props.children}</section>
);

/** One person, from the list: who they are, what they may do, and every way to change it. */
export function UserDrawer(props: { userId: string | undefined; onClose: () => void }): JSX.Element {
  const session = useSession();
  const detail = useQuery("user.get", () => (props.userId ? { userId: props.userId } : undefined));
  const [reset, setReset] = createSignal<LinkOutput>();
  const act = useAction(async (change: { instanceAdmin?: boolean; active?: boolean }) => { await command("user.set", { userId: props.userId ?? "", ...change }); });
  const out = useAction(async () => { await command("session.revoke", { userId: props.userId ?? "" }); toast.success({ title: t("users.signedOut") }); });
  const link = useAction(async () => setReset(await command("user.resetLink", { userId: props.userId ?? "" })));
  return (
    <Dialog.Root open={props.userId !== undefined} onOpenChange={(open) => { if (!open) { setReset(undefined); props.onClose(); } }}>
      <Dialog.Content size="lg" position="end">
        <div class="mb-1 flex justify-end"><Dialog.Close class="grid size-9 place-items-center rounded-control text-ink-gray-7 hover:bg-surface-gray-3 focus-visible:focus-ring"><Icon name="lucide-x" /><span class="sr-only">{t("users.close")}</span></Dialog.Close></div>
        <Ready data={detail.data()} error={detail.error()} retry={detail.refetch} shape="lines">
          {(loaded) => {
            const person = (): UserDetail["user"] => loaded().user;
            const self = (): boolean => person().id === session.user().id;
            return (
              <div class="flex flex-col gap-6">
                <Dialog.Header>
                  <div class="flex items-center gap-3">
                    <Avatar size="lg" theme="gray" label={person().name} />
                    <div class="min-w-0"><Dialog.Title>{person().name}{self() ? ` (${t("share.you")})` : ""}</Dialog.Title><Dialog.Description class="truncate">{person().email}</Dialog.Description></div>
                  </div>
                  <div class="mt-3 flex flex-wrap items-center gap-2"><StatusBadge status={person().status} /><InstanceRole admin={person().instanceAdmin} />
                    <span class="t-small text-ink-2">{person().lastSignInAt ? t("users.lastSignIn", { when: ago(person().lastSignInAt ?? 0) }) : t("users.neverSignedIn")}</span>
                  </div>
                </Dialog.Header>
                <div class="flex flex-wrap gap-2">
                  <Show when={person().status === "active"}>
                    <Button variant="outline" size="md" iconLeft={person().instanceAdmin ? "lucide-shield-off" : "lucide-shield-check"} loading={act.busy()} onClick={() => void act.run({ instanceAdmin: !person().instanceAdmin })}>{person().instanceAdmin ? t("users.action.demote") : t("users.action.promote")}</Button>
                  </Show>
                  <Button variant="outline" size="md" iconLeft="lucide-link" loading={link.busy()} onClick={() => void link.run()}>{t("users.action.reset")}</Button>
                  <Button variant="outline" size="md" iconLeft="lucide-log-out" loading={out.busy()} onClick={() => void out.run()}>{t("users.action.signOut")}</Button>
                  <Show when={person().status === "deactivated"} fallback={<Show when={!self()}><ConfirmButton icon="lucide-user-x" label={t("users.action.deactivate")} confirm={t("users.deactivate.confirm", { name: person().name })} busy={act.busy()} onConfirm={() => void act.run({ active: false })} /></Show>}>
                    <Button variant="solid" theme="blue" size="md" iconLeft="lucide-user-check" loading={act.busy()} onClick={() => void act.run({ active: true })}>{t("users.action.reactivate")}</Button>
                  </Show>
                </div>
                <Failure error={act.error() ?? out.error() ?? link.error()} />
                <Show when={reset()}>{(made) => <div class="rounded-xl border border-rule bg-lilac p-4"><LinkBox link={made().link} label={t("users.reset.link", { when: dateTime(made().expiresAt) })} /></div>}</Show>
                <Block title={t("detail.groups")}>
                  <p class="flex flex-wrap gap-2">
                    <For each={loaded().groups} fallback={<span class="t-small text-ink-3">{t("detail.groups.none")}</span>}>{(group) => <Badge theme="gray" size="md" prefix={<Icon name="lucide-users" class="size-3" />} label={group.name} />}</For>
                  </p>
                </Block>
                <Block title={t("detail.access")}><AccessMatrix rows={loaded().access} /></Block>
                <Block title={t("detail.sessions")}><SessionList sessions={loaded().sessions} userId={person().id} self={self()} /></Block>
                <Block title={t("detail.signins")}><SignInLog entries={loaded().signIns} /></Block>
              </div>
            );
          }}
        </Ready>
      </Dialog.Content>
    </Dialog.Root>
  );
}
