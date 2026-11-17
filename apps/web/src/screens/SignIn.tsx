import { createSignal, Show, type JSX } from "solid-js";
import { nameFromEmail } from "../lib/people";
import { Button, TextInput } from "@talelk/newui-atoms";
import { TabButtons } from "@talelk/newui-molecules";
import { AuthCard } from "@talelk/newui-organisms";
import { AuthLayout } from "@talelk/newui-templates";
import { ApiFailure, command, useAction } from "../data/api";
import { authClient } from "../data/auth-client";
import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";
import { Failure } from "../components/bits";
import { Mark } from "../components/Shell";

/** better-auth answers `{message}` on a refusal; its routes are called directly so a second factor fits the same form. */
async function auth<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/auth${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as T & { message?: string };
  // A refused sign-in is said in the person's language; anything else keeps the server's own words.
  if (!response.ok) throw new ApiFailure(response.status === 429 ? "CONFLICT" : "UNAUTHENTICATED", response.status === 429 ? t("signin.error.tooMany") : response.status === 401 ? t(path.startsWith("/two-factor") ? "signin.error.code" : "signin.error.refused") : answer.message ?? t("signin.error.refused"));
  return answer;
}

/** The setup token may arrive in the address (`?token=` or `#token=`), as the install prints it. */
function tokenFromAddress(): string {
  return new URLSearchParams(location.search).get("token") ?? new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
}

/** First-run setup, then sign-in with a password, a passkey and a second factor. */
export function SignIn(props: { setupRequired: boolean; onDone: () => void }): JSX.Element {
  const [token, setToken] = createSignal(tokenFromAddress());
  const [name, setName] = createSignal("");
  const [named, setNamed] = createSignal(false);
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [step, setStep] = createSignal<"password" | "code" | "recovery">("password");

  const signIn = async (): Promise<void> => {
    const answer = await auth<{ twoFactorRedirect?: boolean }>("/sign-in/email", { email: email(), password: password() });
    if (answer.twoFactorRedirect) { setStep("code"); return; }
    setPassword("");
    props.onDone();
  };
  const submit = useAction(async () => {
    if (step() !== "password") {
      await auth(step() === "code" ? "/two-factor/verify-totp" : "/two-factor/verify-backup-code", { code: code().trim(), trustDevice: false });
      setCode("");
      props.onDone();
    } else if (props.setupRequired) {
      await command("setup.create", { token: token().trim(), name: name(), email: email(), password: password() });
      // Setup signs the first person in: its answer carries the session.
      history.replaceState(null, "", location.pathname);
      setPassword("");
      props.onDone();
    } else await signIn();
  });
  const passkey = useAction(async () => {
    const result = await authClient.signIn.passkey();
    if (result?.error) throw new ApiFailure("UNAUTHENTICATED", result.error.message ?? t("signin.error.passkey"));
    props.onDone();
  });
  const busy = (): boolean => submit.busy() || passkey.busy();
  const title = (): string => (props.setupRequired ? t("setup.title") : step() === "password" ? t("signin.title") : step() === "code" ? t("signin.code.title") : t("signin.recovery.title"));
  const text = (): string => (props.setupRequired ? t("setup.text") : step() === "password" ? t("signin.text") : step() === "code" ? t("signin.code.text") : t("signin.recovery.text"));

  return (
    <AuthLayout
      brand={<span class="flex items-center gap-2 text-ink-gray-9"><Mark class="size-7" /><span class="font-display text-[1.375rem] font-semibold tracking-tight">Brain</span></span>}
      header={<span />}
      aside={<>
        <span class="flex items-center gap-2 text-ink-gray-9"><Mark class="size-7" /><span class="font-display text-[1.375rem] font-semibold tracking-tight">Brain</span></span>
        <div class="max-w-md"><p class="t-hero text-ink">{t("signin.aside.title")}</p><p class="mt-4 t-text text-ink-2">{t("signin.aside.text")}</p></div>
        <span class="t-small text-ink-3">{t("signin.aside.foot")}</span>
      </>}>
      <AuthCard title={title()} description={text()} error={(submit.error() ?? passkey.error()) ? <Failure error={submit.error() ?? passkey.error()} /> : undefined}>
        <form class="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit.run(); }}>
          <Show when={step() === "password"} fallback={
            <TextInput size="lg" label={step() === "code" ? t("signin.code.label") : t("signin.recovery.label")} value={code()} onInput={(event) => setCode(event.currentTarget.value)} required autofocus
              autocomplete={step() === "code" ? "one-time-code" : "off"} inputmode={step() === "code" ? "numeric" : "text"} maxlength={step() === "code" ? 6 : 128} disabled={busy()} />
          }>
            <Show when={props.setupRequired}>
              <TextInput size="lg" label={t("setup.token")} description={t("setup.token.help")} value={token()} onInput={(event) => setToken(event.currentTarget.value)} required autocomplete="off" disabled={busy()} class="t-code" />
              <TextInput size="lg" label={t("setup.name")} value={name()} onInput={(event) => { setNamed(true); setName(event.currentTarget.value); }} required maxlength={100} autocomplete="name" disabled={busy()} />
            </Show>
            <TextInput size="lg" type="email" label={t("signin.email")} value={email()} onInput={(event) => { setEmail(event.currentTarget.value); if (props.setupRequired && !named()) setName(nameFromEmail(event.currentTarget.value)); }} required autocomplete="username webauthn" disabled={busy()} />
            <TextInput size="lg" type="password" label={t("signin.password")} description={props.setupRequired ? t("setup.password.help") : undefined} value={password()} onInput={(event) => setPassword(event.currentTarget.value)} required minlength={12} maxlength={128}
              autocomplete={props.setupRequired ? "new-password" : "current-password webauthn"} disabled={busy()} />
          </Show>
          <Button type="submit" variant="solid" theme="blue" size="lg" loading={submit.busy()} disabled={passkey.busy()}>
            {props.setupRequired ? t("setup.submit") : step() === "password" ? t("signin.submit") : t("signin.code.submit")}
          </Button>
          <Show when={!props.setupRequired && step() === "password"}>
            <Button variant="outline" size="lg" iconLeft="lucide-key-round" loading={passkey.busy()} disabled={submit.busy()} onClick={() => void passkey.run()}>{t("signin.passkey")}</Button>
          </Show>
          <Show when={step() !== "password"}>
            <button type="button" class="link self-start t-small" onClick={() => { setCode(""); submit.clear(); setStep(step() === "code" ? "recovery" : "code"); }}>{step() === "code" ? t("signin.recovery.use") : t("signin.code.use")}</button>
          </Show>
        </form>
      </AuthCard>
      <TabButtons class="self-center" label={t("nav.language")} value={locale()} onValueChange={(value) => setLocale(value as Locale)} options={LOCALES.map((entry) => ({ value: entry.id, label: entry.label }))} />
    </AuthLayout>
  );
}
