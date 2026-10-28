import { createSignal, Show } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { AuthCard } from "@talelk/newui-organisms";
import { AuthLayout } from "@talelk/newui-templates";
import { governor } from "../../data/client";
import { ThemeToggle } from "./ThemeToggle";

export function Authentication(props: { setupRequired: boolean; onAuthenticated: () => Promise<void> }) {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [organizationId, setOrganizationId] = createSignal("my-team");
  const [credential, setCredential] = createSignal("");
  const [needsCode, setNeedsCode] = createSignal(false);
  const [recovery, setRecovery] = createSignal(false);
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy()) return;
    setBusy(true); setError("");
    try {
      if (needsCode()) {
        const entered = code(); setCode("");
        await governor(recovery() ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp", { code: entered, trustDevice: false });
      } else if (props.setupRequired) {
        const entered = password(); setPassword("");
        await governor("/v1/setup", { name: name(), organizationId: organizationId(), email: email(), password: entered }, undefined, { authorization: `Setup ${credential()}` });
        setCredential("");
      } else {
        const entered = password(); setPassword("");
        const result = await governor<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", { email: email(), password: entered });
        if (result.twoFactorRedirect) { setNeedsCode(true); return; }
      }
      await props.onAuthenticated();
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-in could not be completed. Try again."); }
    finally { setBusy(false); }
  }

  return <AuthLayout brand={<span class="text-heading font-semibold">Keyrus Brain</span>} header={<ThemeToggle />}>
    <AuthCard title={props.setupRequired ? "Set up Keyrus Brain" : needsCode() ? recovery() ? "Recover your account" : "Verify your sign-in" : "Sign in to Keyrus Brain"}
      description={props.setupRequired ? "Create the first organization with your private setup credential." : "Use your organization account."} error={error() || undefined}>
      <form onSubmit={submit} class="flex flex-col gap-4">
        <Show when={props.setupRequired && !needsCode()}>
          <TextInput label="Setup credential" type="password" autocomplete="off" value={credential()} onInput={(e) => setCredential(e.currentTarget.value)} required disabled={busy()} />
          <TextInput label="Organization name" value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxlength={100} disabled={busy()} />
          <TextInput label="Organization ID" value={organizationId()} onInput={(e) => setOrganizationId(e.currentTarget.value)} required pattern="[A-Za-z0-9][A-Za-z0-9\-_]{0,63}" disabled={busy()} />
        </Show>
        <Show when={!needsCode()} fallback={<>
          <Show when={recovery()} fallback={<TextInput label="Authenticator code" value={code()} onInput={(e) => setCode(e.currentTarget.value)} autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required disabled={busy()} />}>
            <TextInput label="Recovery code" value={code()} onInput={(e) => setCode(e.currentTarget.value)} autocomplete="off" maxlength={128} required disabled={busy()} />
            <p>Recover account access, then replace your authenticator before reviewing actions.</p>
          </Show>
          <Button type="button" onClick={() => {setCode("");setRecovery(!recovery());}} disabled={busy()} class="min-h-11">{recovery() ? "Use authenticator" : "Use a recovery code"}</Button>
        </>}>
          <TextInput label="Email" type="email" autocomplete="username" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required disabled={busy()} />
          <TextInput label="Password" type="password" autocomplete={props.setupRequired ? "new-password" : "current-password"} value={password()} onInput={(e) => setPassword(e.currentTarget.value)} minlength={12} maxlength={128} required disabled={busy()} />
        </Show>
        <Button type="submit" loading={busy()} disabled={busy()} class="min-h-11">{props.setupRequired ? "Create organization" : needsCode() ? recovery() ? "Recover account" : "Verify and continue" : "Sign in"}</Button>
      </form>
    </AuthCard>
  </AuthLayout>;
}

export function AuthenticatorEnrollment(props: { recoveryRequired: boolean; onEnrolled: () => Promise<void> }) {
  const [password, setPassword] = createSignal(""); const [uri, setUri] = createSignal("");
  const [code, setCode] = createSignal(""); const [backupCodes, setBackupCodes] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal("");
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy()) return; setBusy(true); setError("");
    try {
      if (!uri()) {
        const entered = password(); setPassword("");
        if (props.recoveryRequired) await governor("/api/auth/two-factor/disable",{password:entered});
        const result = await governor<{ totpURI: string; backupCodes: string[] }>("/api/auth/two-factor/enable", { password: entered });
        setUri(result.totpURI); setBackupCodes(result.backupCodes);
      } else {
        const entered = code(); setCode("");
        await governor("/api/auth/two-factor/verify-totp", { code: entered, trustDevice: false });
        setUri(""); setBackupCodes([]); await props.onEnrolled();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Authenticator enrollment failed."); }
    finally { setBusy(false); }
  }
  const secret = () => uri() ? new URL(uri()).searchParams.get("secret") : "";
  return <section aria-label="Authenticator setup" class="rounded-card border border-outline-gray-1 p-4">
    <h2 class="text-heading">Set up your authenticator</h2>
    <p>{props.recoveryRequired ? "Account access was recovered. Replace the previous authenticator before reviewing actions." : "Verify an authenticator before reviewing actions that require strong identity."}</p>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <form onSubmit={submit} class="flex flex-col gap-3">
      <Show when={uri()} fallback={<TextInput label="Confirm password" type="password" autocomplete="current-password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} required disabled={busy()} />}>
        <p>Add <a href={uri()}>Keyrus Brain to your authenticator</a>, or enter this setup key manually: <code class="break-all">{secret()}</code></p>
        <p>Save these recovery codes privately before continuing. They are not saved in your browser.</p>
        <pre class="whitespace-pre-wrap break-words">{backupCodes().join("\n")}</pre>
        <TextInput label="Authenticator code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} value={code()} onInput={(e) => setCode(e.currentTarget.value)} required disabled={busy()} />
      </Show>
      <Button type="submit" loading={busy()} disabled={busy()} class="min-h-11">{uri() ? "Verify authenticator" : "Begin setup"}</Button>
    </form>
  </section>;
}
