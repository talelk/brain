import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { createShare, listShares, revokeShare, type CreatedShare, type ShareLink } from "../../data/result-links";
import { formatDateTime } from "../format";

const LIFETIMES = [{ value: "24", label: "1 day" }, { value: "168", label: "7 days" }, { value: "720", label: "30 days" }];

/**
 * Share one verified result as a read-only link (issue #60, ADR 0013). The link shows that result's text and nothing else, expires,
 * can be withdrawn here at any time, and cannot change anything. Brain shows the link once; afterwards only its state is listed.
 */
export function ShareResult(props: { versionId: string | undefined; verified: boolean }): JSX.Element {
  const app = useApp();
  const [open, setOpen] = createSignal(false);
  const [hours, setHours] = createSignal("168");
  const [created, setCreated] = createSignal<CreatedShare>();
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const shares = createScopedRead<ShareLink[]>({
    scope: app.scope,
    resource: () => (open() ? props.versionId : undefined),
    load: async (scope, signal, resource) => ({ snapshot: resource ? await listShares(scope.workspaceId, resource, signal) : [], asOf: new Date().toISOString(), sourceWatermark: 0 }),
  });
  const canShare = () => props.verified && Boolean(props.versionId) && app.canOperate();
  async function create(): Promise<void> {
    if (!props.versionId || busy()) return;
    setBusy(true); setError(""); setCopied(false);
    try {
      setCreated(await createShare(app.workspaceId(), props.versionId, Number(hours())));
      await shares.refresh({ force: true });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The link was not created."); }
    finally { setBusy(false); }
  }
  async function revoke(link: ShareLink): Promise<void> {
    setError("");
    try { await revokeShare(app.workspaceId(), link.shareId); if (created()?.shareId === link.shareId) setCreated(undefined); await shares.refresh({ force: true }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The link was not withdrawn."); }
  }
  async function copy(url: string): Promise<void> {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  }
  return <Show when={canShare()}>
    <div class="flex min-w-0 flex-col gap-2">
      <Button variant="outline" iconLeft="lucide-share-2" aria-expanded={open()} onClick={() => setOpen(!open())}>Share a read-only link</Button>
      <Show when={open()}>
        <section class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-gray-2 bg-surface-white p-3" aria-label="Share this result" data-testid="share-panel">
          <p class="text-interface text-ink-gray-7">Anyone with the link can read this version of the result, and nothing else, until it expires or you withdraw it. They do not need an account and cannot change anything.</p>
          <div class="flex min-w-0 flex-wrap items-end gap-2">
            <Select label="Link works for" value={hours()} options={LIFETIMES} onValueChange={(value) => setHours(value ?? "168")} />
            <Button variant="solid" theme="blue" loading={busy()} disabled={busy()} onClick={() => void create()}>Create link</Button>
          </div>
          <Show when={error()}><p role="alert" class="text-interface text-ink-red-9">{error()}</p></Show>
          <Show when={created()}>{(link) => <div class="flex min-w-0 flex-col gap-1 rounded-control border border-outline-green-2 bg-surface-green-1 p-3" data-testid="share-created">
            <p class="text-interface font-medium text-ink-green-9">Link created. Copy it now: Brain will not show it again.</p>
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <code class="min-w-0 flex-1 basis-72 break-all rounded-control border border-outline-gray-2 bg-surface-white px-2 py-1.5 text-interface" data-testid="share-url">{link().url}</code>
              <Button variant="outline" iconLeft="lucide-copy" onClick={() => void copy(link().url)}>{copied() ? "Copied" : "Copy"}</Button>
            </div>
            <p class="text-caption text-ink-gray-7">Expires {formatDateTime(link().expiresAt)}.</p>
          </div>}</Show>
          <Show when={(shares.state().data ?? []).length > 0}>
            <div class="flex min-w-0 flex-col gap-1" data-testid="share-list">
              <h4 class="text-interface font-medium text-ink-gray-9">Links for this version</h4>
              <For each={shares.state().data ?? []}>{(link) => <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-1.5" data-state={link.state}>
                <span class="min-w-0 text-caption text-ink-gray-7">
                  <Badge size="sm" variant="subtle" theme={link.state === "active" ? "green" : "gray"} label={link.state === "active" ? "Active" : link.state === "expired" ? "Expired" : "Withdrawn"} />{" "}
                  Created {formatDateTime(link.createdAt)} · expires {formatDateTime(link.expiresAt)} · opened {link.views} {link.views === 1 ? "time" : "times"}
                </span>
                <Show when={link.state === "active"}><Button size="sm" variant="outline" theme="red" onClick={() => void revoke(link)}>Withdraw link</Button></Show>
              </div>}</For>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  </Show>;
}
