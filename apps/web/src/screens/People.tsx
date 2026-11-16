import { createSignal, For, Show, type JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { Member, Role } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { usePlace, useSession } from "../data/session";
import { t } from "../i18n";
import { ago } from "../lib/format";
import { ROLES } from "../lib/model";
import { ConfirmButton, Empty, Failure, Keyed, PageHead, Ready, Section } from "../components/bits";

const roleOptions = (): { label: string; value: string; description: string }[] => ROLES.map((role) => ({ label: t(`role.${role}`), value: role, description: t(`role.${role}.help`) }));

function MemberRow(props: { member: Member }): JSX.Element {
  const place = usePlace();
  const session = useSession();
  const change = useAction((role: Role) => command("member.set", { workspaceId: place.id(), email: props.member.email, role }));
  const remove = useAction(() => command("member.remove", { workspaceId: place.id(), userId: props.member.userId }));
  const me = (): boolean => props.member.userId === session.user().id;
  return (
    <li class="border-b border-rule py-3 last:border-b-0">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="min-w-0 flex-1 basis-56">
          <p class="truncate t-text font-semibold text-ink">{props.member.name}<Show when={me()}><span class="font-normal text-ink-3"> {t("people.you")}</span></Show></p>
          <p class="truncate t-small text-ink-2">{props.member.email}</p>
        </div>
        <div class="w-40"><Select size="md" aria-label={t("people.role.of", { name: props.member.name })} options={roleOptions()} value={props.member.role} disabled={me() || change.busy()} onValueChange={(role) => { if (role && role !== props.member.role) void change.run(role as Role); }} /></div>
        <Show when={!me()} fallback={<span class="w-24" />}><ConfirmButton label={t("people.remove")} confirm={t("people.remove.confirm", { name: props.member.name })} busy={remove.busy()} onConfirm={() => void remove.run()} /></Show>
      </div>
      <Failure error={change.error() ?? remove.error()} class="mt-2" />
    </li>
  );
}

function AddMember(): JSX.Element {
  const place = usePlace();
  const [email, setEmail] = createSignal("");
  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [role, setRole] = createSignal<Role>("member");
  const [made, setMade] = createSignal<string>();
  const add = useAction(async () => {
    const result = await command("member.set", { workspaceId: place.id(), email: email(), role: role(), ...(name().trim() ? { name: name() } : {}), ...(password() ? { password: password() } : {}) });
    setMade(result.created ? t("people.add.created", { email: email() }) : t("people.add.added", { email: email() }));
    setEmail(""); setName(""); setPassword("");
  });
  return (
    <form class="mt-5 flex flex-col gap-4 rounded-[20px] border border-rule bg-sheet p-5" onSubmit={(event) => { event.preventDefault(); setMade(undefined); void add.run(); }}>
      <div><h3 class="t-head text-ink">{t("people.add")}</h3><p class="mt-1 t-small text-ink-2">{t("people.add.text")}</p></div>
      <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <TextInput size="md" type="email" label={t("signin.email")} value={email()} onInput={(event) => setEmail(event.currentTarget.value)} required />
        <Select size="md" label={t("people.role")} options={roleOptions()} value={role()} onValueChange={(value) => { if (value) setRole(value as Role); }} />
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <TextInput size="md" label={t("people.add.name")} description={t("people.add.name.help")} value={name()} onInput={(event) => setName(event.currentTarget.value)} maxlength={100} />
        <TextInput size="md" type="password" label={t("people.add.password")} description={t("setup.password.help")} autocomplete="new-password" minlength={12} maxlength={128} value={password()} onInput={(event) => setPassword(event.currentTarget.value)} />
      </div>
      <Failure error={add.error()} />
      <Show when={made()}><p role="status" class="t-small text-ok">{made()}</p></Show>
      <div><Button type="submit" variant="solid" theme="blue" size="md" loading={add.busy()}>{t("people.add.submit")}</Button></div>
    </form>
  );
}

function Secrets(): JSX.Element {
  const place = usePlace();
  const secrets = useQuery("secrets.list", () => ({ workspaceId: place.id() }));
  const [name, setName] = createSignal("");
  const [value, setValue] = createSignal("");
  const set = useAction(async () => { await command("secret.set", { workspaceId: place.id(), name: name().trim(), value: value() }); setName(""); setValue(""); });
  const remove = useAction((secret: string) => command("secret.delete", { workspaceId: place.id(), name: secret }));
  return (
    <Ready data={secrets.data()} error={secrets.error()} retry={secrets.refetch}>
      {(loaded) => (
        <>
          <Show when={loaded().missing.length > 0}>
            <div class="mb-4 rounded-[20px] border border-(--needs-line) bg-sheet p-5">
              <p class="t-small font-semibold text-needs-text">{t("secrets.missing")}</p>
              <p class="mt-1 t-text text-ink">{t("secrets.missing.text")}</p>
              <div class="mt-3 flex flex-wrap gap-2"><For each={loaded().missing}>{(missing) => <button type="button" class="rounded-full border border-rule-2 px-3 py-1 t-code text-ink hover:border-violet" onClick={() => { setName(missing); document.getElementById("secret-value")?.focus(); }}>{missing}</button>}</For></div>
            </div>
          </Show>
          <Show when={loaded().secrets.length > 0} fallback={<Empty title={t("secrets.none")} text={t("secrets.none.text")} />}>
            <ul>
              <Keyed each={loaded().secrets} by={(secret) => secret.name}>
                {(secret) => (
                  <li class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule py-2.5 last:border-b-0">
                    <code class="t-code code-ltr min-w-0 flex-1 truncate font-medium text-ink">{secret().name}</code>
                    <span class="t-small text-ink-3">{t("secrets.updated", { when: ago(secret().updatedAt) })}</span>
                    <Button variant="ghost" size="sm" onClick={() => { setName(secret().name); document.getElementById("secret-value")?.focus(); }}>{t("secrets.replace")}</Button>
                    <ConfirmButton label={t("action.delete")} confirm={t("secrets.delete.confirm", { name: secret().name })} busy={remove.busy()} onConfirm={() => void remove.run(secret().name)} />
                  </li>
                )}
              </Keyed>
            </ul>
          </Show>
          <Failure error={remove.error()} class="mt-3" />
          <form class="mt-5 flex flex-col gap-4 rounded-[20px] border border-rule bg-sheet p-5" onSubmit={(event) => { event.preventDefault(); void set.run(); }}>
            <div><h3 class="t-head text-ink">{t("secrets.set")}</h3><p class="mt-1 t-small text-ink-2">{t("secrets.set.text")}</p></div>
            <div class="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
              <TextInput size="md" class="t-code" label={t("field.name")} placeholder="github" value={name()} onInput={(event) => setName(event.currentTarget.value)} required />
              <TextInput size="md" id="secret-value" type="password" autocomplete="off" label={t("secrets.value")} value={value()} onInput={(event) => setValue(event.currentTarget.value)} required />
            </div>
            <Failure error={set.error()} />
            <div><Button type="submit" variant="solid" theme="blue" size="md" loading={set.busy()}>{t("secrets.set.submit")}</Button></div>
          </form>
        </>
      )}
    </Ready>
  );
}

/** People and secrets: who may do what in this workspace, and the secrets its files refer to (names only). */
export default function PeopleScreen(): JSX.Element {
  const place = usePlace();
  const members = useQuery("members.list", () => (place.can("admin") ? { workspaceId: place.id() } : undefined));
  return (
    <div class="mx-auto max-w-[52rem]">
      <PageHead title={t("people.title")} text={t("people.text", { name: place.summary().name })} />
      <Show when={place.can("admin")} fallback={<Empty title={t("people.adminOnly")} text={t("people.adminOnly.text", { role: t(`role.${place.summary().role}`) })} />}>
        <Section title={t("people.members")} class="mt-0">
          <Ready data={members.data()} error={members.error()} retry={members.refetch}>
            {(loaded) => <ul><Keyed each={loaded().members} by={(member) => member.userId}>{(member) => <MemberRow member={member()} />}</Keyed></ul>}
          </Ready>
          <AddMember />
        </Section>
        <Section title={t("secrets.title")} aside={t("secrets.aside")}><Secrets /></Section>
      </Show>
    </div>
  );
}
