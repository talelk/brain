import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { unwrap } from "solid-js/store";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Select, toast } from "@talelk/newui-molecules";
import type { PackImport, PackInfo, PackUpdate, SnapshotManifest } from "@brain/contracts";
import { withPins } from "@brain/contracts/packs";
import { command, query, useAction, useLive, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { brainOf, brainToml, paths } from "../lib/files";
import { packDiff } from "../lib/packdiff";
import { Details, Failure, Loading } from "./bits";
import { Diff } from "./Diff";

/** What differs between two versions of a pack: 0 is the shipped baseline, a number a release, `working` the platform workspace's copy, `none` nothing. */
type Version = number | "working" | "none";
const label = (version: Version): string => (version === "working" ? t("packs.version.working") : version === "none" ? t("packs.version.none") : version === 0 ? t("packs.version.shipped") : `v${version}`);

function VersionDiff(props: { name: string; from: Version; to: Version }): JSX.Element {
  const place = usePlace();
  const text = useLive(() => `${place.id()}|${props.name}|${props.from}|${props.to}`, async () => {
    const [before, after] = await Promise.all([props.from, props.to].map((version) => (version === "none" ? Promise.resolve({ files: [] }) : query("pack.files", { workspaceId: place.id(), name: props.name, version }))));
    return packDiff(before?.files ?? [], after?.files ?? []);
  });
  return <Show when={text.data() !== undefined} fallback={<Show when={text.error()} fallback={<Loading />}><Failure error={text.error()} /></Show>}><Diff text={text.data() ?? ""} open /></Show>;
}

const hosts = (network: readonly string[]): string => (network.length === 0 ? t("packs.import.noNetwork") : network.includes("*") ? t("packs.import.anyHost") : network.join(", "));

/** Bringing a pack from a git repository into the admin workspace's copy, and what it may do, read before it is released. */
function ImportPack(props: { onImported: () => void }): JSX.Element {
  const place = usePlace();
  const [repo, setRepo] = createSignal("");
  const [ref, setRef] = createSignal("");
  const [path, setPath] = createSignal("");
  const [credential, setCredential] = createSignal("");
  const [found, setFound] = createSignal<PackImport>();
  const bring = useAction(async () => {
    setFound(undefined);
    const given = (value: string): string | undefined => (value.trim() === "" ? undefined : value.trim());
    const refGiven = given(ref());
    const secret = given(credential());
    setFound(await command("pack.import", { workspaceId: place.id(), repo: repo().trim(), path: path().trim(), ...(refGiven ? { ref: refGiven } : {}), ...(secret ? { credential: secret } : {}) }));
    props.onImported();
  });
  return (
    <Details summary={<span>{t("packs.import.title")}</span>}>
      <form class="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void bring.run(); }}>
        <TextInput size="md" class="t-code" label={t("packs.import.repo")} placeholder="https://github.com/acme/packs.git" value={repo()} onInput={(event) => setRepo(event.currentTarget.value)} required />
        <div class="grid gap-3 sm:grid-cols-3">
          <TextInput size="md" class="t-code" label={t("packs.import.path")} placeholder="packs/billing" value={path()} onInput={(event) => setPath(event.currentTarget.value)} />
          <TextInput size="md" class="t-code" label={t("packs.import.ref")} placeholder="main" value={ref()} onInput={(event) => setRef(event.currentTarget.value)} />
          <TextInput size="md" class="t-code" label={t("packs.import.credential")} placeholder="github" value={credential()} onInput={(event) => setCredential(event.currentTarget.value)} />
        </div>
        <div><Button variant="outline" size="md" type="submit" loading={bring.busy()} disabled={repo().trim() === ""}>{t("packs.import.action")}</Button></div>
        <Failure error={bring.error()} />
      </form>
      <Show when={found()}>
        {(pack) => (
          <section class="mt-4 flex flex-col gap-2 rounded-card border border-outline-gray-2 p-4" data-testid="imported-pack" aria-live="polite">
            <p class="t-text text-ink">{t("packs.import.done", { name: pack().name, commit: pack().commit.slice(0, 12) })}</p>
            <Show when={pack().agents.length > 0}><p class="t-small text-ink-2">{t("packs.import.agents", { names: pack().agents.join(", ") })}</p></Show>
            <Show when={pack().plays.length > 0}><p class="t-small text-ink-2">{t("packs.import.plays", { names: pack().plays.join(", ") })}</p></Show>
            <Show when={pack().skills.length > 0}><p class="t-small text-ink-2">{t("packs.import.skills", { names: pack().skills.join(", ") })}</p></Show>
            <Show when={pack().replaces.length > 0}><p class="t-small text-ink-2">{t("packs.import.replaces", { files: pack().replaces.map((file) => `${file.path} (${file.pack})`).join(", ") })}</p></Show>
            <ul class="flex flex-col gap-1">
              <For each={pack().tools}>
                {(tool) => (
                  <li class="flex flex-wrap items-center gap-2 t-small text-ink-2">
                    <span class="code-ltr text-ink">{tool.name}</span>
                    <Badge theme={tool.effect === "read" ? "gray" : "amber"} size="md" label={t(`effect.${tool.effect}`)} />
                    <span>{t("packs.import.reach", { hosts: hosts(tool.network), secrets: tool.secrets.join(", ") || t("packs.import.noSecret") })}</span>
                    <Show when={tool.shippedEffect}>{(standard) => <Badge theme="red" size="md" label={t("packs.import.differs", { effect: t(`effect.${standard()}`) })} />}</Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </Show>
    </Details>
  );
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
  /** What a pack is compared from when nothing else is chosen: what it ships as, else its last release, else nothing. */
  const start = (pack: PackInfo): Version => (pack.shipped ? 0 : pack.released.at(-1) ?? "none");
  const options = (pack: PackInfo): { label: string; value: string }[] => [pack.shipped ? 0 : ("none" as const), ...pack.released, ...(pack.working ? ["working" as const] : [])].map((version) => ({ label: label(version), value: String(version) }));
  const parse = (value: string): Version => (value === "working" || value === "none" ? value : Number(value));
  const open = (pack: PackInfo): void => { setShown(shown() === pack.name ? undefined : pack.name); setFrom(start(pack)); setTo("working"); };
  return (
    <div class="flex flex-col gap-4">
      <p class="t-small text-ink-2">{t("packs.hint")}</p>
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="md" loading={updateAll.busy()} onClick={() => void updateAll.run()}>{t("packs.updateAll")}</Button>
        <span class="t-small text-ink-2">{t("packs.updateAll.hint")}</span>
      </div>
      <ImportPack onImported={() => packs.refetch()} />
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
                      <Button variant="outline" size="md" onClick={() => open(pack)}>{t("packs.diff")}</Button>
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

/** The files the workspace holds its own copy of that the new release changes: the update does not reach them. */
function KeptCopies(props: { update: PackUpdate }): JSX.Element {
  const place = usePlace();
  const kept = useLive(() => `${place.id()}|${props.update.pack}|${props.update.pinned}|${props.update.latest}`, async () => {
    const [own, before, after] = await Promise.all([
      query("workspace.files", { workspaceId: place.id() }),
      query("pack.files", { workspaceId: place.id(), name: props.update.pack, version: props.update.pinned }),
      query("pack.files", { workspaceId: place.id(), name: props.update.pack, version: props.update.latest }),
    ]);
    const was = new Map(before.files.map((file) => [file.path, file.content]));
    const now = new Map(after.files.map((file) => [file.path, file.content]));
    return own.files.filter((file) => file.source === "workspace" && file.replaces === props.update.pack && was.get(file.path) !== now.get(file.path)).map((file) => file.path);
  });
  return (
    <Show when={(kept.data()?.length ?? 0) > 0}>
      <p class="t-small text-ink-2" data-testid="kept-copies">{t("packs.update.kept")} <span class="code-ltr">{kept.data()?.join(", ")}</span></p>
    </Show>
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
              <Show when={props.admin}><KeptCopies update={one} /></Show>
              <Show when={shown() === one.pack}><VersionDiff name={one.pack} from={one.pinned} to={one.latest} /></Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
