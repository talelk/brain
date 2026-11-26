import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { unwrap } from "solid-js/store";
import { Badge, Button } from "@talelk/newui-atoms";
import { Select, toast } from "@talelk/newui-molecules";
import type { PackInfo, PackUpdate, SnapshotManifest } from "@brain/contracts";
import { withPins } from "@brain/contracts/packs";
import { command, query, useAction, useLive, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { brainOf, brainToml, paths } from "../lib/files";
import { packDiff } from "../lib/packdiff";
import { Failure, Loading } from "./bits";
import { Diff } from "./Diff";

/** What differs between two versions of a pack: 0 is the shipped baseline, a number a release, `working` the platform workspace's copy. */
type Version = number | "working";
const label = (version: Version): string => (version === "working" ? t("packs.version.working") : version === 0 ? t("packs.version.shipped") : `v${version}`);

function VersionDiff(props: { name: string; from: Version; to: Version }): JSX.Element {
  const place = usePlace();
  const text = useLive(() => `${place.id()}|${props.name}|${props.from}|${props.to}`, async () => {
    const [before, after] = await Promise.all([props.from, props.to].map((version) => query("pack.files", { workspaceId: place.id(), name: props.name, version })));
    return packDiff(before?.files ?? [], after?.files ?? []);
  });
  return <Show when={text.data() !== undefined} fallback={<Show when={text.error()} fallback={<Loading />}><Failure error={text.error()} /></Show>}><Diff text={text.data() ?? ""} open /></Show>;
}

/** The platform workspace's packs: working version, releases, who uses what, the difference between two versions and Release. */
export function PacksTab(): JSX.Element {
  const place = usePlace();
  const packs = useQuery("packs.list", () => ({}));
  const [shown, setShown] = createSignal<string>();
  const [from, setFrom] = createSignal<Version>(0);
  const [to, setTo] = createSignal<Version>("working");
  const release = useAction(async (name: string) => {
    const made = await command("pack.release", { workspaceId: place.id(), name });
    toast.success({ title: t("packs.released", { name, version: made.version }) });
    packs.refetch();
  });
  const updateAll = useAction(async () => {
    const made = await command("packs.updateAll", { workspaceId: place.id() });
    toast.success({ title: t("packs.updateAll.done", { count: made.updated.length }) });
    if (made.failed.length > 0) toast.error({ title: t("packs.updateAll.failed", { count: made.failed.length, names: made.failed.map((one) => one.slug).join(", ") }) });
    packs.refetch();
  });
  const options = (pack: PackInfo): { label: string; value: string }[] => [0, ...pack.released, ...(pack.working ? ["working" as const] : [])].map((version) => ({ label: label(version), value: String(version) }));
  const parse = (value: string): Version => (value === "working" ? "working" : Number(value));
  const open = (name: string): void => { setShown(shown() === name ? undefined : name); setFrom(0); setTo("working"); };
  return (
    <div class="flex flex-col gap-4">
      <p class="t-small text-ink-2">{t("packs.hint")}</p>
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="md" loading={updateAll.busy()} onClick={() => void updateAll.run()}>{t("packs.updateAll")}</Button>
        <span class="t-small text-ink-2">{t("packs.updateAll.hint")}</span>
      </div>
      <Failure error={release.error()} />
      <Failure error={updateAll.error()} />
      <Show when={packs.data()} fallback={<Show when={packs.error()} fallback={<Loading />}><Failure error={packs.error()} /></Show>}>
        {(loaded) => (
          <ul class="flex flex-col gap-3">
            <For each={loaded().packs}>
              {(pack) => (
                <li class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="min-w-0">
                      <h3 class="t-head code-ltr text-ink">{pack.name}</h3>
                      <p class="t-small text-ink-2">{pack.working ? t("packs.versions", { working: pack.version, released: pack.released.length === 0 ? "—" : pack.released.map((version) => `v${version}`).join(", ") }) : t("packs.noCopy")}</p>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={pack.working?.changed}><Badge theme="amber" size="md" label={t("packs.changed")} /></Show>
                      <Button variant="outline" size="md" onClick={() => open(pack.name)}>{t("packs.diff")}</Button>
                      <Button variant="solid" theme="blue" size="md" loading={release.busy()} disabled={!pack.working || (pack.working.changed === false && pack.version > 0)} onClick={() => void release.run(pack.name)}>{t("packs.release")}</Button>
                    </div>
                  </div>
                  <p class="mt-2 t-small text-ink-2">
                    {pack.usedBy.length === 0 ? t("packs.usedBy.none") : <>{t("packs.usedBy")} <For each={pack.usedBy}>{(use, at) => <><Show when={at() > 0}>, </Show><span class="code-ltr">{use.slug} {use.pin === 0 ? t("packs.version.shipped") : `v${use.pin}`}</span></>}</For></>}
                  </p>
                  <Show when={shown() === pack.name}>
                    <div class="mt-4 flex flex-col gap-3 border-t border-rule pt-4">
                      <div class="flex flex-wrap gap-3">
                        <div class="w-44"><Select size="md" label={t("packs.from")} options={options(pack)} value={String(from())} onValueChange={(value) => { if (value) setFrom(parse(value)); }} /></div>
                        <div class="w-44"><Select size="md" label={t("packs.to")} options={options(pack)} value={String(to())} onValueChange={(value) => { if (value) setTo(parse(value)); }} /></div>
                      </div>
                      <VersionDiff name={pack.name} from={from()} to={to()} />
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
    </div>
  );
}

/** A workspace whose packs have newer releases: the badge, and for its admin the difference and the button that commits the new pin. */
export function PackUpdates(props: { snapshot: SnapshotManifest; updates: readonly PackUpdate[]; admin: boolean }): JSX.Element {
  const place = usePlace();
  const [shown, setShown] = createSignal<string>();
  const update = useAction(async (change: PackUpdate) => {
    const brain = structuredClone(unwrap(brainOf(props.snapshot)));
    const packs = withPins(brain.packs, [change]);
    await command("file.write", { workspaceId: place.id(), files: [{ path: paths.brain, content: brainToml({ ...brain, packs }) }], message: `Update ${change.pack} to v${change.latest}` });
    toast.success({ title: t("packs.updated", { name: change.pack, version: change.latest }) });
    place.workspace.refetch();
  });
  const names = createMemo(() => props.updates.map((one) => one.pack).join(", "));
  return (
    <Show when={props.updates.length > 0}>
      <div class="mb-6 flex flex-col gap-3 rounded-card border border-outline-gray-2 p-4">
        <div class="flex flex-wrap items-center gap-2"><Badge theme="amber" size="md" label={t("packs.update.badge")} /><span class="t-small text-ink-2">{names()}</span></div>
        <Failure error={update.error()} />
        <For each={props.updates}>
          {(one) => (
            <div class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="t-text text-ink"><span class="code-ltr font-medium">{one.pack}</span> {label(one.pinned)} → {label(one.latest)}</span>
                <div class="flex gap-2">
                  <Button variant="outline" size="md" onClick={() => setShown(shown() === one.pack ? undefined : one.pack)}>{t("packs.diff")}</Button>
                  <Show when={props.admin}><Button variant="solid" theme="blue" size="md" loading={update.busy()} onClick={() => void update.run(one)}>{t("packs.update.to", { version: one.latest })}</Button></Show>
                </div>
              </div>
              <Show when={shown() === one.pack}><VersionDiff name={one.pack} from={one.pinned} to={one.latest} /></Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
