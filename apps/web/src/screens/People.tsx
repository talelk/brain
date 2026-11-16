import { createSignal, For, Show, type JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, EmptyState, Select, toast } from "@talelk/newui-molecules";
import { DataTable, Section, type DataTableColumn } from "@talelk/newui-organisms";
import type { Member, Role, SecretName } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { usePlace, useSession } from "../data/session";
import { t } from "../i18n";
import { ago } from "../lib/format";
import { ROLES } from "../lib/model";
import { ConfirmButton, Failure, Ready } from "../components/bits";
import { Head } from "../components/Shell";

const roleOptions = (): { label: string; value: string; description: string }[] => ROLES.map((role) => ({ label: t(`role.${role}`), value: role, description: t(`role.${role}.help`) }));

/** A role changed or a person removed, from the row that names them. */
function MemberActions(props: { member: Member }): JSX.Element {
  const place = usePlace();
  const session = useSession();
  const remove = useAction(() => command("member.remove", { workspaceId: place.id(), userId: props.member.userId }));
  return (
    <span class="flex items-center justify-end gap-2">
      <Show when={props.member.userId !== session.user().id}><ConfirmButton label={t("people.remove")} confirm={t("people.remove.confirm", { name: props.member.name })} busy={remove.busy()} onConfirm={() => void remove.run()} /></Show>
      <Failure error={remove.error()} />
    </span>
  );
}

function RoleSelect(props: { member: Member }): JSX.Element {
  const place = usePlace();
  const session = useSession();
  const change = useAction((role: Role) => command("member.set", { workspaceId: place.id(), email: props.member.email, role }));
  return (
    <div class="w-36"><Select size="md" aria-label={t("people.role.of", { name: props.member.name })} options={roleOptions()} value={props.member.role} disabled={props.member.userId === session.user().id || change.busy()} onValueChange={(role) => { if (role && role !== props.member.role) void change.run(role as Role); }} /></div>
  );
}

function AddMember(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const place = usePlace();
  const [email, setEmail] = createSignal("");
  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [role, setRole] = createSignal<Role>("member");
  const add = useAction(async () => {
    const result = await command("member.set", { workspaceId: place.id(), email: email(), role: role(), ...(name().trim() ? { name: name() } : {}), ...(password() ? { password: password() } : {}) });
    toast.success({ title: result.created ? t("people.add.created", { email: email() }) : t("people.add.added", { email: email() }) });
    setEmail(""); setName(""); setPassword("");
    props.onOpenChange(false);
  });
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content size="md">
        <Dialog.Header><Dialog.Title>{t("people.add")}</Dialog.Title><Dialog.Description>{t("people.add.text")}</Dialog.Description></Dialog.Header>
        <form class="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void add.run(); }}>
          <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <TextInput size="md" type="email" label={t("signin.email")} value={email()} onInput={(event) => setEmail(event.currentTarget.value)} required />
            <Select size="md" label={t("people.role")} options={roleOptions()} value={role()} onValueChange={(value) => { if (value) setRole(value as Role); }} />
          </div>
          <TextInput size="md" label={t("people.add.name")} description={t("people.add.name.help")} value={name()} onInput={(event) => setName(event.currentTarget.value)} maxlength={100} />
          <TextInput size="md" type="password" label={t("people.add.password")} description={t("setup.password.help")} autocomplete="new-password" minlength={12} maxlength={128} value={password()} onInput={(event) => setPassword(event.currentTarget.value)} />
          <Failure error={add.error()} />
          <div class="flex justify-end gap-2"><Button variant="ghost" size="md" onClick={() => props.onOpenChange(false)}>{t("action.cancel")}</Button><Button type="submit" variant="solid" theme="blue" size="md" loading={add.busy()}>{t("people.add.submit")}</Button></div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Secrets(): JSX.Element {
  const place = usePlace();
  const secrets = useQuery("secrets.list", () => ({ workspaceId: place.id() }));
  const [open, setOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [value, setValue] = createSignal("");
  const set = useAction(async () => { await command("secret.set", { workspaceId: place.id(), name: name().trim(), value: value() }); toast.success({ title: t("secrets.saved", { name: name().trim() }) }); setName(""); setValue(""); setOpen(false); });
  const remove = useAction((secret: string) => command("secret.delete", { workspaceId: place.id(), name: secret }));
  const edit = (secret: string): void => { setName(secret); setOpen(true); };
  const columns: DataTableColumn<SecretName & { id: string }>[] = [
    { accessorKey: "name", header: t("field.name"), meta: { mobile: "title" }, cell: (ctx) => <code class="t-code code-ltr font-medium">{ctx.row.original.name}</code> },
    { accessorKey: "updatedAt", header: t("secrets.updated.col"), meta: { mobile: "subtitle" }, cell: (ctx) => <span class="text-ink-gray-7">{t("secrets.updated", { when: ago(ctx.row.original.updatedAt) })}</span> },
    { id: "actions", header: "", enableSorting: false, meta: { align: "end" }, cell: (ctx) => <span class="flex items-center justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => edit(ctx.row.original.name)}>{t("secrets.replace")}</Button><ConfirmButton label={t("action.delete")} confirm={t("secrets.delete.confirm", { name: ctx.row.original.name })} busy={remove.busy()} onConfirm={() => void remove.run(ctx.row.original.name)} /></span> },
  ];
  return (
    <Section title={t("secrets.title")} description={t("secrets.aside")} headingLevel={2} actions={<Button variant="outline" size="md" iconLeft="lucide-plus" onClick={() => { setName(""); setOpen(true); }}>{t("secrets.set")}</Button>}>
      <Ready data={secrets.data()} error={secrets.error()} retry={secrets.refetch}>
        {(loaded) => (
          <div class="flex flex-col gap-3">
            <Show when={loaded().missing.length > 0}>
              <Alert theme="blue" icon="lucide-key-round" title={t("secrets.missing")} description={t("secrets.missing.text")}>
                <div class="mt-2 flex flex-wrap gap-2"><For each={loaded().missing}>{(missing) => <Button variant="outline" size="sm" onClick={() => edit(missing)}><code class="t-code code-ltr">{missing}</code></Button>}</For></div>
              </Alert>
            </Show>
            <Show when={loaded().secrets.length > 0} fallback={<EmptyState size="sm" bordered icon="lucide-key-round" title={t("secrets.none")} description={t("secrets.none.text")} />}>
              <DataTable title={t("secrets.title")} rows={loaded().secrets.map((secret) => ({ ...secret, id: secret.name }))} columns={columns} hideSearch selectable={false} recordsLabel={t("secrets.title")} pageSize={100} />
            </Show>
            <Failure error={remove.error()} />
          </div>
        )}
      </Ready>
      <Dialog.Root open={open()} onOpenChange={setOpen}>
        <Dialog.Content size="md">
          <Dialog.Header><Dialog.Title>{t("secrets.set")}</Dialog.Title><Dialog.Description>{t("secrets.set.text")}</Dialog.Description></Dialog.Header>
          <form class="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void set.run(); }}>
            <TextInput size="md" class="t-code" label={t("field.name")} placeholder="github" value={name()} onInput={(event) => setName(event.currentTarget.value)} required />
            <TextInput size="md" type="password" autocomplete="off" label={t("secrets.value")} value={value()} onInput={(event) => setValue(event.currentTarget.value)} required />
            <Failure error={set.error()} />
            <div class="flex justify-end gap-2"><Button variant="ghost" size="md" onClick={() => setOpen(false)}>{t("action.cancel")}</Button><Button type="submit" variant="solid" theme="blue" size="md" loading={set.busy()}>{t("secrets.set.submit")}</Button></div>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </Section>
  );
}

/** People and secrets: who may do what in this workspace, and the secrets its files refer to (names only). */
export default function PeopleScreen(): JSX.Element {
  const place = usePlace();
  const [adding, setAdding] = createSignal(false);
  const members = useQuery("members.list", () => (place.can("admin") ? { workspaceId: place.id() } : undefined));
  const columns: DataTableColumn<Member & { id: string }>[] = [
    { accessorKey: "name", header: t("people.col.person"), meta: { mobile: "title" }, cell: (ctx) => <span class="flex min-w-0 flex-col"><span class="truncate font-medium text-ink-gray-9">{ctx.row.original.name}</span><span class="truncate text-ink-gray-7">{ctx.row.original.email}</span></span> },
    { accessorKey: "role", header: t("people.role"), meta: { mobile: "meta" }, cell: (ctx) => <RoleSelect member={ctx.row.original} /> },
    { id: "actions", header: "", enableSorting: false, meta: { align: "end" }, cell: (ctx) => <MemberActions member={ctx.row.original} /> },
  ];
  return (
    <>
      <Head title={t("people.title")} text={t("people.title")} description={t("people.text", { name: place.summary().name })} breadcrumbs={[{ label: place.summary().name, route: place.to() }, { label: t("nav.people") }]} />
      <Show when={place.can("admin")} fallback={<EmptyState bordered icon="lucide-lock" title={t("people.adminOnly")} description={t("people.adminOnly.text", { role: t(`role.${place.summary().role}`) })} />}>
        <div class="flex flex-col gap-8">
          <Section title={t("people.members")} headingLevel={2} actions={<Button variant="outline" size="md" iconLeft="lucide-user-plus" onClick={() => setAdding(true)}>{t("people.add")}</Button>}>
            <Ready data={members.data()} error={members.error()} retry={members.refetch}>
              {(loaded) => <DataTable title={t("people.members")} rows={loaded().members.map((member) => ({ ...member, id: member.userId }))} columns={columns} hideSearch selectable={false} density="comfortable" recordsLabel={t("people.members")} pageSize={100} />}
            </Ready>
          </Section>
          <Secrets />
        </div>
        <AddMember open={adding()} onOpenChange={setAdding} />
      </Show>
    </>
  );
}
