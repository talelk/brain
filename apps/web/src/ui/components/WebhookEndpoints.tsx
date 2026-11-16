import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, EmptyState, Select } from "@talelk/newui-molecules";
import type { WebhookKind } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { formatDateTime } from "../format";
import { t } from "../../i18n";
import { WorkspaceSection } from "./Domain";
import { FormSheet } from "./BrainForm";

interface EndpointView {
  endpointId: string; kind: WebhookKind; workspaceId: string; workspaceName: string; path: string; createdAt: string; rotatedAt?: string;
  deliveries: Array<{ event: string; status: "applied" | "ignored"; detail?: string; receivedAt: string }>;
}
interface Reveal { kind: WebhookKind; url: string; secret: string }

const KINDS: readonly WebhookKind[] = ["github", "gitlab", "ticket"];
const kindLabel = (kind: WebhookKind): string => t(`webhooks.kind.${kind}` as "webhooks.kind.github");
/** 32 random bytes as hex, made here so the secret exists only in this browser and the request that stores it. */
const newSecret = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");

function CopyField(props: { label: string; value: string; testId: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(props.value); setCopied(true); } catch { setCopied(false); }
  }
  return <div class="flex min-w-0 items-end gap-2">
    <div class="min-w-0 flex-1" data-testid={props.testId}><TextInput label={props.label} value={props.value} readonly /></div>
    <Button size="sm" variant="outline" iconLeft="lucide-copy" onClick={() => void copy()}>{copied() ? t("webhooks.copied") : t("webhooks.copy")}</Button>
  </div>;
}

/**
 * Administration > Integrations: the signed webhook addresses of this organization (ADR 0077). Each shows where to point the provider,
 * which workspace it feeds and the last deliveries, status only. The secret is made here, shown once after it is saved, and only
 * ever replaced by rotation: nothing in this view can read it back.
 */
export function WebhookEndpoints(): JSX.Element {
  const app = useApp();
  const list = createScopedRead<{ endpoints: EndpointView[] }>({
    scope: app.scope,
    load: async (_scope, signal) => {
      const response = await query<{ snapshot: { endpoints: EndpointView[] }; asOf: string; sourceWatermark: number }>({ queryType: "webhooks.list" }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.endpoints.length === 0,
  });
  const [addOpen, setAddOpen] = createSignal(false);
  const [rotating, setRotating] = createSignal<EndpointView | undefined>();
  const [kind, setKind] = createSignal<WebhookKind>("github");
  const [secret, setSecret] = createSignal(newSecret());
  const [reveal, setReveal] = createSignal<Reveal | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const fullUrl = (path: string): string => `${window.location.origin}${path}`;

  async function add(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const created = await app.run("webhook.create", { kind: kind(), workspaceId: app.workspaceId(), secret: secret() });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      setReveal({ kind: kind(), url: fullUrl(`/hooks/${kind()}/${created.resourceId}`), secret: secret() });
      setAddOpen(false);
      await list.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("webhooks.failed")); }
    finally { setBusy(false); }
  }

  async function rotate(): Promise<void> {
    const endpoint = rotating();
    if (busy() || !endpoint) return;
    setBusy(true); setError("");
    try {
      const done = await app.run("webhook.rotate", { endpointId: endpoint.endpointId, secret: secret() });
      if (!done.accepted) throw new Error(done.detail);
      setReveal({ kind: endpoint.kind, url: fullUrl(endpoint.path), secret: secret() });
      setRotating(undefined);
      await list.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("webhooks.failed")); }
    finally { setBusy(false); }
  }

  const openAdd = (): void => { setError(""); setSecret(newSecret()); setKind("github"); setAddOpen(true); };
  const openRotate = (endpoint: EndpointView): void => { setError(""); setSecret(newSecret()); setRotating(endpoint); };
  const secretField = (): JSX.Element => <div class="flex min-w-0 flex-col gap-2">
    <CopyField label={t("webhooks.secret")} value={secret()} testId="webhook-secret-field" />
    <p class="text-caption text-ink-gray-6">{t("webhooks.secret.hint")}</p>
    <div><Button size="sm" variant="ghost" iconLeft="lucide-refresh-cw" onClick={() => setSecret(newSecret())}>{t("webhooks.secret.generate")}</Button></div>
  </div>;

  return <WorkspaceSection title={t("webhooks.title")} description={t("webhooks.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-testid="webhooks">
      <Show when={reveal()}>{(shown) => <div class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-green-2 bg-surface-green-1 p-3" role="status" data-testid="webhook-reveal">
        <div><h3 class="text-base-medium">{t("webhooks.reveal.title")}</h3><p class="text-caption text-ink-gray-7">{t("webhooks.reveal.description")}</p></div>
        <CopyField label={t("webhooks.url")} value={shown().url} testId="webhook-reveal-url" />
        <CopyField label={t("webhooks.secret")} value={shown().secret} testId="webhook-reveal-secret" />
        <p class="text-caption text-ink-gray-7">{t(`webhooks.help.${shown().kind}` as "webhooks.help.github")}</p>
        <div><Button size="sm" variant="solid" theme="blue" onClick={() => setReveal(undefined)}>{t("webhooks.reveal.done")}</Button></div>
      </div>}</Show>
      <div><Button size="sm" variant="outline" iconLeft="lucide-plus" onClick={openAdd}>{t("webhooks.add")}</Button></div>
      <Show when={(list.state().data?.endpoints ?? []).length > 0} fallback={<EmptyState size="sm" icon="lucide-webhook" title={t("webhooks.empty.title")} description={t("webhooks.empty.description")} />}>
        <ul class="flex min-w-0 flex-col divide-y divide-outline-gray-1 border-y border-outline-gray-1">
          <For each={list.state().data?.endpoints ?? []}>{(endpoint) => <li class="flex min-w-0 flex-col gap-2 py-3" data-testid="webhook-endpoint" data-webhook-kind={endpoint.kind}>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-base-medium">{kindLabel(endpoint.kind)}</h3>
              <Button size="sm" variant="outline" iconLeft="lucide-key-round" onClick={() => openRotate(endpoint)}>{t("webhooks.rotate")}</Button>
            </div>
            <p class="break-all text-caption text-ink-gray-8" data-testid="webhook-url"><span class="sr-only">{t("webhooks.url")}: </span><code>{fullUrl(endpoint.path)}</code></p>
            <p class="text-caption text-ink-gray-6">{t("webhooks.workspace", { name: endpoint.workspaceName })} · {t("webhooks.created", { when: formatDateTime(endpoint.createdAt) })}<Show when={endpoint.rotatedAt}> · {t("webhooks.rotated", { when: formatDateTime(endpoint.rotatedAt!) })}</Show></p>
            <p class="text-caption text-ink-gray-6">{t("webhooks.secret.stored")}</p>
            <div>
              <h4 class="text-caption font-medium text-ink-gray-8">{t("webhooks.deliveries")}</h4>
              <Show when={endpoint.deliveries.length > 0} fallback={<p class="text-caption text-ink-gray-6">{t("webhooks.deliveries.none")}</p>}>
                <ul class="mt-1 flex list-none flex-col gap-1 p-0" data-testid="webhook-deliveries">
                  <For each={endpoint.deliveries}>{(delivery) => <li class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                    <Badge variant="outline" theme={delivery.status === "applied" ? "green" : "gray"} label={t(`webhooks.delivery.${delivery.status}` as "webhooks.delivery.applied")} />
                    <span class="font-medium">{delivery.event}</span>
                    <Show when={delivery.detail}><span class="min-w-0 break-words text-ink-gray-6">{delivery.detail}</span></Show>
                    <span class="text-ink-gray-6">{formatDateTime(delivery.receivedAt)}</span>
                  </li>}</For>
                </ul>
              </Show>
            </div>
          </li>}</For>
        </ul>
      </Show>
    </div>
    <FormSheet open={addOpen()} onClose={() => setAddOpen(false)} title={t("webhooks.form.title")} centered description={t("webhooks.form.description")}
      submit={t("webhooks.form.submit")} icon="lucide-webhook" busy={busy()} onSubmit={add} error={error()} errorTitle={t("webhooks.failed")}>
      <Select label={t("webhooks.kind")} value={kind()} options={KINDS.map((value) => ({ value, label: kindLabel(value) }))} onValueChange={(value) => setKind((value ?? "github") as WebhookKind)} />
      {secretField()}
    </FormSheet>
    <FormSheet open={Boolean(rotating())} onClose={() => setRotating(undefined)} title={t("webhooks.rotate.title")} centered description={t("webhooks.rotate.description")}
      submit={t("webhooks.rotate.submit")} icon="lucide-key-round" busy={busy()} onSubmit={rotate} error={error()} errorTitle={t("webhooks.failed")}>
      <Alert theme="amber" variant="outline" title={t("webhooks.rotate.title")} description={t("webhooks.rotate.description")} />
      {secretField()}
    </FormSheet>
  </WorkspaceSection>;
}
