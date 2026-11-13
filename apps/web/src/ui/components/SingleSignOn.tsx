import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { OIDC_ROLES, oidcSettingsRead, workspaceChoices, type OidcRole, type OidcSettings } from "../../data/engine";
import { ScreenRegion } from "../screen-region";
import { formatDateTime } from "../format";
import { WorkspaceSection } from "./Domain";
import { t } from "../../i18n";

const isRole = (value: string): value is OidcRole => (OIDC_ROLES as readonly string[]).includes(value);
const entries = (text: string): string[] => [...new Set(text.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean))];

/** "group = role" lines to the pairs the command takes; a line that is not that names itself in the error. */
function parseGroupRoles(text: string): { ok: true; value: { group: string; role: OidcRole }[] } | { ok: false; line: string } {
  const value: { group: string; role: OidcRole }[] = [];
  for (const line of text.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const at = line.lastIndexOf("=");
    const group = at > 0 ? line.slice(0, at).trim() : "";
    const role = at > 0 ? line.slice(at + 1).trim() : "";
    if (!group || !isRole(role)) return { ok: false, line };
    value.push({ group, role });
  }
  return { ok: true, value };
}

/**
 * Company single sign-on (ADR 0026): the directory, how new people are given an account and which roles a directory group carries.
 * The client secret is only ever named by a reference (a file the server reads, or an environment variable); the page never shows or
 * accepts the secret itself.
 */
export function SingleSignOn(): JSX.Element {
  const app = useApp();
  const mayEdit = () => Boolean(app.identity()?.actor.scopes.includes("identity:security"));
  const read = createScopedRead<OidcSettings>({ scope: app.scope, live: true, load: (_scope, signal) => oidcSettingsRead(signal) });
  const workspaces = createScopedRead<{ workspaceId: string; displayName: string }[]>({ scope: app.scope, load: (_scope, signal) => workspaceChoices(signal) });
  type Draft = Partial<{ enabled: boolean; issuer: string; clientId: string; secretRef: string; autoProvision: boolean; defaultRole: string; groupClaim: string; groupRoles: string; domains: string; workspaceIds: string[] }>;
  const [draft, setDraft] = createSignal<Draft>({});
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | undefined>();
  const current = () => read.state().data;
  const field = <K extends keyof Draft>(key: K): Draft[K] => draft()[key];
  const set = (change: Draft) => setDraft({ ...draft(), ...change });
  const value = {
    enabled: () => field("enabled") ?? current()?.enabled ?? false,
    issuer: () => field("issuer") ?? current()?.issuer ?? "",
    clientId: () => field("clientId") ?? current()?.clientId ?? "",
    secretRef: () => field("secretRef") ?? current()?.secretRef ?? "",
    autoProvision: () => field("autoProvision") ?? current()?.autoProvision ?? false,
    defaultRole: () => field("defaultRole") ?? current()?.defaultRole ?? "",
    groupClaim: () => field("groupClaim") ?? current()?.groupClaim ?? "groups",
    groupRoles: () => field("groupRoles") ?? (current()?.groupRoles ?? []).map((entry) => `${entry.group} = ${entry.role}`).join("\n"),
    domains: () => field("domains") ?? (current()?.allowedDomains ?? []).join("\n"),
    workspaceIds: () => field("workspaceIds") ?? current()?.workspaceIds ?? [],
  };
  const stateKey = () => !current()?.configured ? "none" : current()?.enabled ? "on" : "off";
  async function save(): Promise<void> {
    if (busy()) return;
    const roles = parseGroupRoles(value.groupRoles());
    if (!roles.ok) { setResult({ ok: false, text: t("sso.badGroup", { line: roles.line }) }); return; }
    setBusy(true); setResult(undefined);
    try {
      const receipt = await app.run("identity.oidc.set", {
        enabled: value.enabled(), issuer: value.issuer().trim(), clientId: value.clientId().trim(), secretRef: value.secretRef().trim(), autoProvision: value.autoProvision(),
        ...(isRole(value.defaultRole()) ? { defaultRole: value.defaultRole() as OidcRole } : {}),
        groupClaim: value.groupClaim().trim() || "groups", groupRoles: roles.value, workspaceIds: value.workspaceIds(), allowedDomains: entries(value.domains()).map((domain) => domain.toLowerCase()),
      });
      if (!receipt.accepted) throw new Error(receipt.detail);
      setDraft({}); setResult({ ok: true, text: t("sso.saved") });
      await read.refresh({ force: true });
    } catch (cause) { setResult({ ok: false, text: cause instanceof Error ? cause.message : t("decision.refused") }); } finally { setBusy(false); }
  }
  return <WorkspaceSection title={t("sso.title")} description={t("sso.description")}>
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle={t("sso.title")} emptyDescription={t("sso.unavailable")} onRetry={() => void read.refresh({ force: true })}>
      <Show when={current()}>{(settings) => <div class="flex min-w-0 flex-col gap-3" data-sso data-sso-state={stateKey()}>
        <p class="m-0 flex flex-wrap items-center gap-2 text-interface text-ink-gray-8"><Badge variant="outline" theme={stateKey() === "on" ? "green" : stateKey() === "off" ? "amber" : "gray"} label={t(stateKey() === "on" ? "sso.state.on" : stateKey() === "off" ? "sso.state.off" : "sso.state.none")} />
          <Show when={settings().updatedAt}>{(when) => <span class="text-caption text-ink-gray-6">{t("sso.updated", { when: formatDateTime(when()) })}</span>}</Show></p>
        <div class="flex min-w-0 flex-col gap-0.5"><span class="text-caption text-ink-gray-6">{t("sso.redirect")}</span><code class="break-all text-interface text-ink-gray-9" data-sso-redirect>{settings().redirectUri}</code></div>
        <Show when={settings().configured}><p class="m-0 text-caption text-ink-gray-7" data-sso-secret={settings().secretReadable ? "readable" : "unreadable"}>{settings().secretReadable ? t("sso.secret.readable") : t("sso.secret.unreadable")}</p></Show>
        <Show when={!mayEdit()}><p class="m-0 text-interface text-ink-gray-7">{t("sso.readOnly")}</p></Show>
        <Show when={mayEdit()}>
          <Checkbox checked={value.enabled()} onCheckedChange={(checked) => set({ enabled: checked === true })} label={t("sso.enable")} />
          <TextInput label={t("sso.issuer")} description={t("sso.issuerHint")} type="url" value={value.issuer()} onInput={(event) => set({ issuer: event.currentTarget.value })} />
          <TextInput label={t("sso.clientId")} value={value.clientId()} onInput={(event) => set({ clientId: event.currentTarget.value })} />
          <TextInput label={t("sso.secretRef")} description={t("sso.secretRefHint")} autocomplete="off" spellcheck={false} value={value.secretRef()} placeholder="file:/run/secrets/brain-sso" onInput={(event) => set({ secretRef: event.currentTarget.value })} />
          <Checkbox checked={value.autoProvision()} onCheckedChange={(checked) => set({ autoProvision: checked === true })} label={t("sso.autoProvision")} />
          <Select label={t("sso.defaultRole")} value={value.defaultRole() || ""} onValueChange={(next) => set({ defaultRole: next ?? "" })}
            options={[{ value: "", label: t("sso.defaultRoleNone") }, ...OIDC_ROLES.map((role) => ({ value: role, label: role }))]} />
          <TextInput label={t("sso.groupClaim")} value={value.groupClaim()} onInput={(event) => set({ groupClaim: event.currentTarget.value })} />
          <Textarea label={t("sso.groupRoles")} description={t("sso.groupRolesHint")} rows={3} value={value.groupRoles()} onInput={(event) => set({ groupRoles: event.currentTarget.value })} />
          <Textarea label={t("sso.domains")} description={t("sso.domainsHint")} rows={2} value={value.domains()} onInput={(event) => set({ domains: event.currentTarget.value })} />
          <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"><legend class="mb-1 text-interface font-medium text-ink-gray-8">{t("sso.workspaces")}</legend>
            <For each={workspaces.state().data ?? []}>{(entry) => <Checkbox checked={value.workspaceIds().includes(entry.workspaceId)} label={entry.displayName}
              onCheckedChange={(checked) => set({ workspaceIds: checked === true ? [...new Set([...value.workspaceIds(), entry.workspaceId])] : value.workspaceIds().filter((id) => id !== entry.workspaceId) })} />}</For>
          </fieldset>
          <div><Button variant="solid" theme="blue" size="sm" loading={busy()} disabled={busy() || !value.issuer().trim() || !value.clientId().trim() || !value.secretRef().trim()} onClick={() => void save()}>{t("sso.save")}</Button></div>
        </Show>
        <Show when={result()}>{(outcome) => <p role={outcome().ok ? "status" : "alert"} class={`m-0 text-interface ${outcome().ok ? "text-ink-green-8" : "text-ink-red-8"}`}>{outcome().text}</p>}</Show>
      </div>}</Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
