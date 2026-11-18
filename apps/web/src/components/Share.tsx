import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { generatedPassword, nameFromEmail } from "../lib/people";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Dialog, Select, toast } from "@talelk/newui-molecules";
import type { Member, MemberGroup, Role } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { usePlace, useSession } from "../data/session";
import { t } from "../i18n";
import { brainOf, brainToml, paths } from "../lib/files";
import { ROLES } from "../lib/model";
import { ConfirmButton, Failure, Icon, Ready } from "./bits";
import { Choice } from "./fields";

/** Private or public, as a badge: shown beside a workspace everywhere a person reads about it. */
export function VisibilityBadge(props: { visibility: "private" | "public"; class?: string }): JSX.Element {
  return <Badge theme={props.visibility === "public" ? "blue" : "gray"} size="md" class={props.class} prefix={<Icon name={props.visibility === "public" ? "lucide-globe" : "lucide-lock"} class="size-3" />} label={t(props.visibility === "public" ? "visibility.public" : "visibility.private")} />;
}

/** The one workspace that looks after the others (docs/model.md, "The platform workspace"). */
export function PlatformBadge(): JSX.Element {
  return <Badge theme="violet" size="md" prefix={<Icon name="lucide-shield-check" class="size-3" />} label={t("platform.badge")} />;
}

const roleOptions = (): { label: string; value: string; description: string }[] => ROLES.map((role) => ({ label: t(`role.${role}`), value: role, description: t(`role.${role}.help`) }));

/** The groups that have a role in this workspace, and the people who have it through them. An instance admin changes groups on the Users screen. */
export function GroupAccess(props: { groups: readonly MemberGroup[] }): JSX.Element {
  const session = useSession();
  return (
    <Show when={props.groups.length > 0}>
      <section aria-label={t("share.groups")}>
        <div class="flex flex-wrap items-baseline justify-between gap-2"><h3 class="t-head text-ink">{t("share.groups")}</h3><Show when={session.user().instanceAdmin}><A href="/users" class="link t-small">{t("share.groups.manage")}</A></Show></div>
        <p class="t-small text-ink-2">{t("share.groups.text")}</p>
        <ul class="mt-1 divide-y divide-(--rule)">
          <For each={props.groups}>
            {(group) => (
              <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <Icon name="lucide-users" class="size-4 text-ink-3" />
                <span class="min-w-0 flex-1 basis-48"><span class="block truncate t-text font-medium text-ink">{group.name}</span><span class="block truncate t-small text-ink-2">{group.members.map((member) => member.name).join(", ") || t("share.groups.empty")}</span></span>
                <Badge theme={group.role === "admin" ? "violet" : group.role === "member" ? "blue" : "gray"} size="md" label={t(`role.${group.role}`)} />
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function PersonRow(props: { member: Member }): JSX.Element {
  const place = usePlace();
  const session = useSession();
  const me = (): boolean => props.member.userId === session.user().id;
  const change = useAction((role: Role) => command("member.set", { workspaceId: place.id(), email: props.member.email, role }));
  const remove = useAction(() => command("member.remove", { workspaceId: place.id(), userId: props.member.userId }));
  return (
    <li class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <span class="min-w-0 flex-1 basis-48"><span class="block truncate t-text font-medium text-ink">{props.member.name}{me() ? ` (${t("share.you")})` : ""}<Show when={!props.member.active}> <Badge theme="gray" size="sm" label={t("users.status.deactivated")} /></Show></span><span class="block truncate t-small text-ink-2">{props.member.email}</span></span>
      <div class="w-36"><Select size="md" aria-label={t("people.role.of", { name: props.member.name })} options={roleOptions()} value={props.member.role} disabled={me() || change.busy()} onValueChange={(role) => { if (role && role !== props.member.role) void change.run(role as Role); }} /></div>
      <Show when={!me()}><ConfirmButton label={t("people.remove")} confirm={t("people.remove.confirm", { name: props.member.name })} busy={remove.busy()} onConfirm={() => void remove.run()} /></Show>
      <Failure error={change.error() ?? remove.error()} class="basis-full" />
    </li>
  );
}

/** Who can see and work in this workspace: the people with a role, adding by email, and whether everyone in this Brain may read it. An admin's dialog. */
export function ShareDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const place = usePlace();
  const members = useQuery("members.list", () => (props.open && place.can("admin") ? { workspaceId: place.id() } : undefined));
  const [email, setEmail] = createSignal("");
  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [role, setRole] = createSignal<Role>("member");
  const add = useAction(async () => {
    const result = await command("member.set", { workspaceId: place.id(), email: email(), role: role(), ...(name().trim() ? { name: name() } : {}), ...(password() ? { password: password() } : {}) });
    toast.success({ title: result.created ? t("people.add.created", { email: email() }) : t("people.add.added", { email: email() }) });
    setEmail(""); setName(""); setPassword("");
  });
  // A person without an account needs a name and a first password: the refusal says so, and only then are they asked for.
  const [generated, setGenerated] = createSignal(false);
  const newAccount = (): boolean => (add.error()?.problems ?? []).some((problem) => problem.path === "name" || problem.path === "password") || name() !== "" || password() !== "";
  // The refusal that asks for a name is answered with one made from the address, which the person can change.
  createEffect(() => { if ((add.error()?.problems ?? []).some((problem) => problem.path === "name") && name() === "") setName(nameFromEmail(email())); });
  const visibility = useAction(async (next: "private" | "public") => {
    const workspace = place.workspace.data();
    if (!workspace) return;
    await command("file.write", { workspaceId: place.id(), files: [{ path: paths.brain, content: brainToml({ ...brainOf(workspace.snapshot), visibility: next }) }], message: `Make the workspace ${next}` });
  });
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content size="lg">
        <Dialog.Header><Dialog.Title>{t("share.title", { name: place.summary().name })}</Dialog.Title><Dialog.Description>{t("share.text")}</Dialog.Description></Dialog.Header>
        <div class="mt-4 flex flex-col gap-6">
          <section aria-label={t("visibility.title")}>
            <Choice label={t("visibility.title")} value={place.summary().visibility} onChange={(next) => { if (next !== place.summary().visibility) void visibility.run(next); }}
              options={[{ value: "private", label: t("visibility.private"), help: t("visibility.private.help") }, { value: "public", label: t("visibility.public"), help: t("visibility.public.help") }]} />
            <Failure error={visibility.error()} class="mt-2" />
          </section>
          <section aria-label={t("share.people")}>
            <h3 class="t-head text-ink">{t("share.people")}</h3>
            <Ready data={members.data()} error={members.error()} retry={members.refetch}>
              {(loaded) => <ul class="mt-1 divide-y divide-(--rule)"><For each={loaded().members}>{(member) => <PersonRow member={member} />}</For></ul>}
            </Ready>
          </section>
          <GroupAccess groups={members.data()?.groups ?? []} />
          <form class="flex flex-col gap-3 border-t border-rule pt-5" onSubmit={(event) => { event.preventDefault(); void add.run(); }}>
            <h3 class="t-head text-ink">{t("people.add")}</h3>
            <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <TextInput size="md" type="email" label={t("signin.email")} value={email()} onInput={(event) => setEmail(event.currentTarget.value)} required />
              <Select size="md" label={t("people.role")} options={roleOptions()} value={role()} onValueChange={(value) => { if (value) setRole(value as Role); }} />
            </div>
            <Show when={newAccount()}>
              <p class="t-small text-ink-2">{t("share.newAccount")}</p>
              <div class="grid gap-3 sm:grid-cols-2">
                <TextInput size="md" label={t("people.add.name")} value={name()} onInput={(event) => setName(event.currentTarget.value)} maxlength={100} required />
                <div>
                  <TextInput size="md" type={generated() ? "text" : "password"} class={generated() ? "t-code" : ""} label={t("people.add.password")} description={t("setup.password.help")} autocomplete="new-password" minlength={12} maxlength={128} value={password()} onInput={(event) => { setGenerated(false); setPassword(event.currentTarget.value); }} required />
                  <button type="button" class="link mt-1 t-small" onClick={() => { setPassword(generatedPassword()); setGenerated(true); }}>{t("people.add.generate")}</button>
                </div>
              </div>
            </Show>
            <Failure error={add.error()} />
            <div><Button type="submit" variant="solid" theme="blue" size="md" loading={add.busy()}>{t("people.add.submit")}</Button></div>
          </form>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** What is true of the open workspace at a glance, for the top of its page: private or public, whether the person only reads it because it is public, and Share for an admin. */
export function WorkspaceActions(): JSX.Element {
  const place = usePlace();
  const [sharing, setSharing] = createSignal(false);
  return (
    <div class="flex flex-wrap items-center gap-2">
      <VisibilityBadge visibility={place.summary().visibility} />
      <Show when={place.summary().platform}><PlatformBadge /></Show>
      <Show when={place.summary().viaPublic}><span class="t-small text-ink-2">{t("visibility.viaPublic")}</span></Show>
      <Show when={place.can("admin")}>
        <Button variant="outline" size="md" iconLeft="lucide-share-2" onClick={() => setSharing(true)}>{t("share.action")}</Button>
        <ShareDialog open={sharing()} onOpenChange={setSharing} />
      </Show>
    </div>
  );
}
