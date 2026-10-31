import { createSignal, onMount, Show } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { AuthCard } from "@talelk/newui-organisms";
import { AuthLayout } from "@talelk/newui-templates";
import { useParams } from "@solidjs/router";
import { governor, GovernorError } from "../../data/client";
import { authClient } from "../../data/auth-client";
import { useApp } from "../app-context";
import { ThemeToggle } from "./ThemeToggle";
import { ActionFeedback } from "./ActionFeedback";

export function Authentication(props: { setupRequired: boolean; onAuthenticated: () => Promise<void>; invitationId?: string }) {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [organizationId, setOrganizationId] = createSignal("my-team");
  const [credential, setCredential] = createSignal("");
  const [needsCode, setNeedsCode] = createSignal(false);
  const [recovery, setRecovery] = createSignal(false);
  const [signUp, setSignUp] = createSignal(false);
  const [verificationSent, setVerificationSent] = createSignal(false);
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
      } else if (signUp() && props.invitationId) {
        const entered = password(); setPassword("");
        await governor("/api/auth/sign-up/email", { name: name(), email: email(), password: entered });
        setVerificationSent(true);
        return;
      } else {
        const entered = password(); setPassword("");
        const result = await governor<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", { email: email(), password: entered });
        if (result.twoFactorRedirect) { setNeedsCode(true); return; }
      }
      await props.onAuthenticated();
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-in could not be completed. Try again."); }
    finally { setBusy(false); }
  }

  async function passkeySignIn() {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const result = await authClient.signIn.passkey();
      if (result.error) throw new Error(result.error.message || "Passkey sign-in failed");
      await props.onAuthenticated();
    } catch (e) { setError(e instanceof Error ? e.message : "Passkey sign-in could not be completed"); }
    finally { setBusy(false); }
  }

  async function resendVerification() {
    setBusy(true); setError("");
    try {
      await governor("/api/auth/send-verification-email", { email: email(), callbackURL: props.invitationId ? `/accept-invitation/${encodeURIComponent(props.invitationId)}` : "/" });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not send verification email"); }
    finally { setBusy(false); }
  }

  const title = () => props.setupRequired ? "Set up Keyrus Brain" : needsCode() ? recovery() ? "Recover your account" : "Verify your sign-in" : props.invitationId ? signUp() ? "Create your invited account" : "Accept organization invitation" : "Sign in to Keyrus Brain";
  return <AuthLayout brand={<span class="text-heading font-semibold">Keyrus Brain</span>} header={<ThemeToggle />}>
    <AuthCard title={verificationSent() ? "Verify your email" : title()}
      description={verificationSent() ? "Open the verification link sent to your email address, then return to this invitation." : props.setupRequired ? "Create the first organization with your private setup credential." : props.invitationId ? "Sign in or create the invited account. Email verification is required before acceptance." : "Use your organization account."} error={error() || undefined}>
      <Show when={!verificationSent()} fallback={<div class="flex flex-col gap-4"><p>Your account was created. Membership is not granted until you verify your email and explicitly accept the invitation.</p><Button size="lg" variant="outline" loading={busy()} onClick={() => void resendVerification()}>Resend verification email</Button></div>}>
        <form onSubmit={submit} class="flex flex-col gap-4">
          <Show when={props.setupRequired && !needsCode()}>
            <TextInput label="Setup credential" type="password" autocomplete="off" value={credential()} onInput={(e) => setCredential(e.currentTarget.value)} required disabled={busy()} />
            <TextInput label="Organization name" value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxlength={100} disabled={busy()} />
            <TextInput label="Organization ID" value={organizationId()} onInput={(e) => setOrganizationId(e.currentTarget.value)} required pattern="[A-Za-z0-9][A-Za-z0-9\-_]{0,63}" disabled={busy()} />
          </Show>
          <Show when={signUp() && !props.setupRequired}><TextInput label="Your name" value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxlength={100} disabled={busy()} /></Show>
          <Show when={!needsCode()} fallback={<>
            <Show when={recovery()} fallback={<TextInput label="Authenticator code" value={code()} onInput={(e) => setCode(e.currentTarget.value)} autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required disabled={busy()} />}>
              <TextInput label="Recovery code" value={code()} onInput={(e) => setCode(e.currentTarget.value)} autocomplete="off" maxlength={128} required disabled={busy()} />
              <p>Recover account access, then replace your authenticator before reviewing actions.</p>
            </Show>
            <Button size="lg" type="button" onClick={() => {setCode("");setRecovery(!recovery());}} disabled={busy()}>{recovery() ? "Use authenticator" : "Use a recovery code"}</Button>
          </>}>
            <TextInput label="Email" type="email" autocomplete="username webauthn" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required disabled={busy()} />
            <TextInput label="Password" type="password" autocomplete={props.setupRequired || signUp() ? "new-password" : "current-password webauthn"} value={password()} onInput={(e) => setPassword(e.currentTarget.value)} minlength={12} maxlength={128} required disabled={busy()} />
          </Show>
          <Button size="lg" type="submit" variant="solid" theme="blue" loading={busy()} disabled={busy()}>{props.setupRequired ? "Create organization" : needsCode() ? recovery() ? "Recover account" : "Verify and continue" : signUp() ? "Create account and send verification" : "Sign in"}</Button>
          <Show when={!props.setupRequired && !needsCode() && !signUp()}><Button size="lg" type="button" variant="outline" iconLeft="lucide-key-round" onClick={() => void passkeySignIn()} disabled={busy()}>Sign in with a passkey</Button></Show>
          <Show when={props.invitationId && !needsCode()}><Button size="lg" type="button" variant="ghost" onClick={() => { setSignUp(!signUp()); setError(""); }} disabled={busy()}>{signUp() ? "Use an existing account" : "New to Brain? Create the invited account"}</Button></Show>
        </form>
      </Show>
    </AuthCard>
  </AuthLayout>;
}

export function InvitationAcceptancePage() {
  const app = useApp();
  const params = useParams<{ id: string }>();
  const [busy, setBusy] = createSignal(false);
  const [accepted, setAccepted] = createSignal(false);
  const [vendorSession, setVendorSession] = createSignal(false);
  const [sessionReady, setSessionReady] = createSignal(false);
  const [error, setError] = createSignal("");

  async function loadSession() {
    try { setVendorSession(Boolean(await governor<{ user?: { id: string } } | null>("/api/auth/get-session"))); }
    catch { setVendorSession(false); }
    finally { setSessionReady(true); }
  }
  onMount(() => void loadSession());

  async function accept() {
    if (busy() || accepted()) return;
    setBusy(true); setError("");
    try {
      await governor("/api/auth/organization/accept-invitation", { invitationId: params.id });
      setAccepted(true);
      await app.reloadIdentity();
    } catch (e) { setError(e instanceof Error ? e.message : "Invitation acceptance failed"); }
    finally { setBusy(false); }
  }

  return <AuthLayout brand={<span class="text-heading font-semibold">Keyrus Brain</span>} header={<ThemeToggle />}>
    <Show when={app.ready() && sessionReady()} fallback={<AuthCard title="Loading invitation"><p>Checking your account…</p></AuthCard>}>
      <Show when={app.identity() || vendorSession()} fallback={<Authentication setupRequired={false} invitationId={params.id} onAuthenticated={async () => { await app.reloadIdentity(); await loadSession(); }} />}>
        <AuthCard title={accepted() ? "Invitation accepted" : "Accept organization invitation"} description={accepted() ? "Your organization membership is ready. Workspace access is granted separately by an administrator." : "Confirm this invitation with your verified account."} error={error() || undefined}>
          <Show when={accepted()} fallback={<Button size="lg" variant="solid" theme="blue" loading={busy()} onClick={() => void accept()}>Accept invitation</Button>}>
            <a class="text-ink-blue-link underline" href="/today">Continue to Brain</a>
          </Show>
        </AuthCard>
      </Show>
    </Show>
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
    <ActionFeedback tone="error" message={error()} />
    <form onSubmit={submit} class="flex flex-col gap-3">
      <Show when={uri()} fallback={<TextInput label="Confirm password" type="password" autocomplete="current-password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} required disabled={busy()} />}>
        <p>Add <a href={uri()}>Keyrus Brain to your authenticator</a>, or enter this setup key manually: <code class="break-all">{secret()}</code></p>
        <p>Save these recovery codes privately before continuing. They are not saved in your browser.</p>
        <pre class="whitespace-pre-wrap break-words">{backupCodes().join("\n")}</pre>
        <TextInput label="Authenticator code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} value={code()} onInput={(e) => setCode(e.currentTarget.value)} required disabled={busy()} />
      </Show>
      <Button size="lg" type="submit" variant="solid" theme="blue" loading={busy()} disabled={busy()}>{uri() ? "Verify authenticator" : "Begin setup"}</Button>
    </form>
  </section>;
}

export function InitialPasswordChange(props: { onChanged: () => Promise<void> }) {
  const [current, setCurrent] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy()) return;
    setBusy(true); setError("");
    try {
      if (!current()) throw new Error("Enter the temporary password you used to sign in.");
      if (password().length < 12 || password().length > 128) throw new Error("Use 12–128 characters for your new password. Spaces are allowed.");
      if (current() === password()) throw new Error("Choose a new password that differs from your temporary password.");
      await governor("/api/auth/change-password", { currentPassword: current(), newPassword: password(), revokeOtherSessions: true });
      setCurrent(""); setPassword(""); await props.onChanged();
    } catch (e) { setError(e instanceof GovernorError && e.code === "INVALID_PASSWORD" ? "The temporary password is incorrect. Enter the password you used to sign in; keep your new password in the New password field." : e instanceof Error ? e.message : "Password change failed."); }
    finally { setBusy(false); }
  }
  return <AuthLayout brand="Keyrus Brain"><AuthCard title="Welcome to Brain" description="Your workspace and starter tasks are prepared. Replace your temporary password to continue." error={error() || undefined}>
    <form onSubmit={submit} class="flex flex-col gap-4" novalidate>
      <TextInput description="Enter the temporary password you used to sign in, not your new password." label="Temporary password" type="password" autocomplete="current-password" value={current()} onInput={(e) => setCurrent(e.currentTarget.value)} required disabled={busy()} />
      <TextInput label="New password" description="Use 12–128 characters. Spaces are allowed. Choose a different password from your temporary one." type="password" autocomplete="new-password" minlength={12} maxlength={128} value={password()} onInput={(e) => setPassword(e.currentTarget.value)} required disabled={busy()} />
      <Button size="lg" type="submit" variant="solid" theme="blue" loading={busy()} disabled={busy()}>Save password and continue</Button>
    </form>
  </AuthCard></AuthLayout>;
}
