import { createSignal, Show, type JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { TabButtons } from "@talelk/newui-molecules";
import { AuthCard } from "@talelk/newui-organisms";
import { AuthLayout } from "@talelk/newui-templates";
import { command, useAction } from "../data/api";
import { authClient } from "../data/auth-client";
import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";
import { generatedPassword } from "../lib/people";
import { Failure } from "./bits";
import { Mark } from "./Shell";

/** What an invitation or a reset link carries in the address: `#invite=<token>` or `#reset=<token>`. The fragment never reaches a server log. */
export function linkFromAddress(): { kind: "invite" | "reset"; token: string } | undefined {
  const found = /^#(invite|reset)=([\w-]{20,200})$/u.exec(location.hash);
  return found ? { kind: found[1] as "invite" | "reset", token: found[2] ?? "" } : undefined;
}

/** The page an invitation or a reset link opens: choose a name and a password (or just a password), and be signed in (or told to sign in). */
export function Redeem(props: { link: { kind: "invite" | "reset"; token: string }; signedInAs: string | undefined; onDone: () => void }): JSX.Element {
  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [shown, setShown] = createSignal(false);
  const [reset, setReset] = createSignal(false);
  const leave = (): void => { history.replaceState(null, "", location.pathname + location.search); props.onDone(); };
  const submit = useAction(async () => {
    const answer = await command("invitation.accept", { token: props.link.token, ...(props.link.kind === "invite" ? { name: name() } : {}), password: password() });
    setPassword("");
    if (answer.kind === "reset") setReset(true);
    else leave();
  });
  const signOut = useAction(async () => { await authClient.signOut(); props.onDone(); });
  const invite = props.link.kind === "invite";
  return (
    <AuthLayout
      brand={<span class="flex items-center gap-2 text-ink-gray-9"><Mark class="size-7" /><span class="font-display text-[1.375rem] font-semibold tracking-tight">Brain</span></span>}
      header={<span />}
      aside={<>
        <span class="flex items-center gap-2 text-ink-gray-9"><Mark class="size-7" /><span class="font-display text-[1.375rem] font-semibold tracking-tight">Brain</span></span>
        <div class="max-w-md"><p class="t-hero text-ink">{t("signin.aside.title")}</p><p class="mt-4 t-text text-ink-2">{t("signin.aside.text")}</p></div>
        <span class="t-small text-ink-3">{t("signin.aside.foot")}</span>
      </>}>
      <Show when={!props.signedInAs} fallback={
        <AuthCard title={t("redeem.signedIn.title")} description={t("redeem.signedIn.text", { name: props.signedInAs ?? "" })}>
          <Button variant="solid" theme="blue" size="lg" loading={signOut.busy()} onClick={() => void signOut.run()}>{t("nav.signOut")}</Button>
        </AuthCard>
      }>
        <Show when={!reset()} fallback={
          <AuthCard title={t("redeem.reset.done.title")} description={t("redeem.reset.done")}>
            <Button variant="solid" theme="blue" size="lg" onClick={leave}>{t("signin.submit")}</Button>
          </AuthCard>
        }>
          <AuthCard title={invite ? t("redeem.invite.title") : t("redeem.reset.title")} description={invite ? t("redeem.invite.text") : t("redeem.reset.text")} error={submit.error() ? <Failure error={submit.error()} /> : undefined}>
            <form class="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit.run(); }}>
              <Show when={invite}>
                <TextInput size="lg" label={t("setup.name")} value={name()} onInput={(event) => setName(event.currentTarget.value)} required maxlength={100} autocomplete="name" disabled={submit.busy()} />
              </Show>
              <div>
                <TextInput size="lg" type={shown() ? "text" : "password"} class={shown() ? "t-code" : ""} label={t("signin.password")} description={t("setup.password.help")} value={password()} onInput={(event) => setPassword(event.currentTarget.value)} required minlength={12} maxlength={128} autocomplete="new-password" disabled={submit.busy()} />
                <button type="button" class="link mt-1 t-small" onClick={() => { setPassword(generatedPassword()); setShown(true); }}>{t("people.add.generate")}</button>
              </div>
              <Button type="submit" variant="solid" theme="blue" size="lg" loading={submit.busy()}>{invite ? t("redeem.invite.submit") : t("redeem.reset.submit")}</Button>
            </form>
          </AuthCard>
        </Show>
      </Show>
      <TabButtons class="self-center" label={t("nav.language")} value={locale()} onValueChange={(value) => setLocale(value as Locale)} options={LOCALES.map((entry) => ({ value: entry.id, label: entry.label }))} />
    </AuthLayout>
  );
}
