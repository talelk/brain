import { createEffect, createSignal, on, Show, type JSX } from "solid-js";
import { Avatar, Button, TextInput } from "@talelk/newui-atoms";
import { TabButtons, toast } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import { command, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";
import { setTheme, theme } from "../lib/theme";
import { Failure, Ready } from "../components/bits";
import { Head } from "../components/Shell";
import { InstanceRole, SessionList, SignInLog } from "../components/UserAdmin";

/** One's own account: name, language and theme, password, and the sessions and sign-ins of this account. */
export default function ProfileScreen(): JSX.Element {
  const session = useSession();
  const detail = useQuery("user.get", () => ({}));
  const [name, setName] = createSignal(session.user().name);
  const [current, setCurrent] = createSignal("");
  const [next, setNext] = createSignal("");
  createEffect(on(() => session.user().name, (value) => setName(value)));
  const saveName = useAction(async () => { await command("profile.set", { name: name() }); session.refetch(); toast.success({ title: t("profile.saved") }); });
  const savePassword = useAction(async () => {
    await command("profile.set", { currentPassword: current(), newPassword: next() });
    setCurrent(""); setNext("");
    toast.success({ title: t("profile.password.saved") });
  });
  const others = useAction(async () => { const answer = await command("session.revoke", { keepCurrent: true }); toast.success({ title: t("profile.sessions.ended", { n: answer.revoked }) }); });
  return (
    <>
      <Head title={t("profile.title")} text={t("profile.title")} description={t("profile.text")} />
      <div class="flex max-w-3xl flex-col gap-8">
        <Section title={t("profile.you")} headingLevel={2}>
          <div class="flex flex-col gap-5 rounded-2xl border border-rule bg-paper p-5">
            <div class="flex items-center gap-4">
              <Avatar size="xl" theme="gray" label={session.user().name} />
              <div class="min-w-0"><p class="truncate t-head text-ink">{session.user().name}</p><p class="truncate t-small text-ink-2">{session.user().email}</p><div class="mt-1.5"><InstanceRole admin={session.user().instanceAdmin} /></div></div>
            </div>
            <form class="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void saveName.run(); }}>
              <div class="min-w-0 flex-1"><TextInput size="md" label={t("profile.name")} value={name()} onInput={(event) => setName(event.currentTarget.value)} required maxlength={100} autocomplete="name" /></div>
              <Button type="submit" variant="outline" size="md" loading={saveName.busy()} disabled={name().trim() === "" || name().trim() === session.user().name}>{t("action.save")}</Button>
            </form>
            <Failure error={saveName.error()} />
            <div class="grid gap-4 border-t border-rule pt-5 sm:grid-cols-2">
              <div class="flex flex-col gap-1.5"><span class="t-small font-medium text-ink-2" id="profile-language">{t("nav.language")}</span><TabButtons aria-labelledby="profile-language" label={t("nav.language")} value={locale()} onValueChange={(value) => setLocale(value as Locale)} options={LOCALES.map((entry) => ({ value: entry.id, label: entry.label }))} /></div>
              <div class="flex flex-col gap-1.5"><span class="t-small font-medium text-ink-2" id="profile-theme">{t("nav.theme")}</span><TabButtons aria-labelledby="profile-theme" label={t("nav.theme")} value={theme()} onValueChange={(value) => setTheme(value as "light" | "dark" | "system")} options={[{ value: "light", label: t("theme.light") }, { value: "dark", label: t("theme.dark") }, { value: "system", label: t("theme.system") }]} /></div>
            </div>
            <p class="t-small text-ink-3">{t("profile.browser")}</p>
          </div>
        </Section>

        <Section title={t("profile.password")} description={t("profile.password.text")} headingLevel={2}>
          <form class="flex flex-col gap-4 rounded-2xl border border-rule bg-paper p-5" onSubmit={(event) => { event.preventDefault(); void savePassword.run(); }}>
            <TextInput size="md" type="password" label={t("profile.password.current")} value={current()} onInput={(event) => setCurrent(event.currentTarget.value)} required autocomplete="current-password" maxlength={128} />
            <TextInput size="md" type="password" label={t("profile.password.new")} description={t("setup.password.help")} value={next()} onInput={(event) => setNext(event.currentTarget.value)} required minlength={12} maxlength={128} autocomplete="new-password" />
            <Failure error={savePassword.error()} />
            <div><Button type="submit" variant="solid" theme="blue" size="md" loading={savePassword.busy()}>{t("profile.password.submit")}</Button></div>
          </form>
        </Section>

        <Section title={t("detail.sessions")} description={t("profile.sessions.text")} headingLevel={2}
          actions={<Show when={(detail.data()?.sessions.length ?? 0) > 1}><Button variant="outline" size="md" iconLeft="lucide-log-out" loading={others.busy()} onClick={() => void others.run()}>{t("profile.sessions.others")}</Button></Show>}>
          <Ready data={detail.data()} error={detail.error()} retry={detail.refetch} shape="lines">
            {(loaded) => <div class="rounded-2xl border border-rule bg-paper px-5 py-2"><SessionList sessions={loaded().sessions} userId={session.user().id} self /></div>}
          </Ready>
          <Failure error={others.error()} class="mt-3" />
        </Section>

        <Section title={t("detail.signins")} description={t("profile.signins.text")} headingLevel={2}>
          <Ready data={detail.data()} error={detail.error()} retry={detail.refetch} shape="lines">
            {(loaded) => <div class="rounded-2xl border border-rule bg-paper px-5 py-2"><SignInLog entries={loaded().signIns} /></div>}
          </Ready>
        </Section>
      </div>
    </>
  );
}
