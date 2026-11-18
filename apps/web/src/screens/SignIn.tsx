import { createSignal, Show, type JSX } from "solid-js";
import { nameFromEmail } from "../lib/people";
import { Button, TextInput } from "@talelk/newui-atoms";
import { TabButtons } from "@talelk/newui-molecules";
import { AuthCard } from "@talelk/newui-organisms";
import { AuthLayout } from "@talelk/newui-templates";
import { ApiFailure, command, useAction } from "../data/api";
import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";
import { Failure } from "../components/bits";
import { Mark } from "../components/Shell";

/** The password sign-in of better-auth; it answers `{message}` on a refusal. */
async function auth(body: unknown): Promise<void> {
  const response = await fetch("/api/auth/sign-in/email", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // A refused sign-in is said in the person's language, the same for a wrong password and a deactivated account.
  if (!response.ok) throw new ApiFailure(response.status === 429 ? "CONFLICT" : "UNAUTHENTICATED", t(response.status === 429 ? "signin.error.tooMany" : "signin.error.refused"));
}

/** The setup token may arrive in the address (`?token=` or `#token=`), as the install prints it. */
function tokenFromAddress(): string {
  return new URLSearchParams(location.search).get("token") ?? new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
}

/** First-run setup, then sign-in with a password. */
export function SignIn(props: { setupRequired: boolean; onDone: () => void }): JSX.Element {
  const [token, setToken] = createSignal(tokenFromAddress());
  const [name, setName] = createSignal("");
  const [named, setNamed] = createSignal(false);
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");

  const submit = useAction(async () => {
    if (props.setupRequired) {
      await command("setup.create", { token: token().trim(), name: name(), email: email(), password: password() });
      // Setup signs the first person in: its answer carries the session.
      history.replaceState(null, "", location.pathname);
    } else await auth({ email: email(), password: password() });
    setPassword("");
    props.onDone();
  });
  const title = (): string => t(props.setupRequired ? "setup.title" : "signin.title");
  const text = (): string => t(props.setupRequired ? "setup.text" : "signin.text");

  return (
    <AuthLayout
      brand={<span class="flex items-center gap-2 text-ink-gray-9"><Mark class="size-7" /><span class="font-display text-[1.375rem] font-semibold tracking-tight">Brain</span></span>}
      header={<span />}
      aside={<>
        <span class="flex items-center gap-2 text-ink-gray-9"><Mark class="size-7" /><span class="font-display text-[1.375rem] font-semibold tracking-tight">Brain</span></span>
        <div class="max-w-md"><p class="t-hero text-ink">{t("signin.aside.title")}</p><p class="mt-4 t-text text-ink-2">{t("signin.aside.text")}</p></div>
        <span class="t-small text-ink-3">{t("signin.aside.foot")}</span>
      </>}>
      <AuthCard title={title()} description={text()} error={submit.error() ? <Failure error={submit.error()} /> : undefined}>
        <form class="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit.run(); }}>
          <Show when={props.setupRequired}>
              <TextInput size="lg" label={t("setup.token")} description={t("setup.token.help")} value={token()} onInput={(event) => setToken(event.currentTarget.value)} required autocomplete="off" disabled={submit.busy()} class="t-code" />
              <TextInput size="lg" label={t("setup.name")} value={name()} onInput={(event) => { setNamed(true); setName(event.currentTarget.value); }} required maxlength={100} autocomplete="name" disabled={submit.busy()} />
          </Show>
          <TextInput size="lg" type="email" label={t("signin.email")} value={email()} onInput={(event) => { setEmail(event.currentTarget.value); if (props.setupRequired && !named()) setName(nameFromEmail(event.currentTarget.value)); }} required autocomplete="username" disabled={submit.busy()} />
            <TextInput size="lg" type="password" label={t("signin.password")} description={props.setupRequired ? t("setup.password.help") : undefined} value={password()} onInput={(event) => setPassword(event.currentTarget.value)} required minlength={12} maxlength={128}
              autocomplete={props.setupRequired ? "new-password" : "current-password"} disabled={submit.busy()} />
          <Button type="submit" variant="solid" theme="blue" size="lg" loading={submit.busy()}>{t(props.setupRequired ? "setup.submit" : "signin.submit")}</Button>
        </form>
      </AuthCard>
      <TabButtons class="self-center" label={t("nav.language")} value={locale()} onValueChange={(value) => setLocale(value as Locale)} options={LOCALES.map((entry) => ({ value: entry.id, label: entry.label }))} />
    </AuthLayout>
  );
}
