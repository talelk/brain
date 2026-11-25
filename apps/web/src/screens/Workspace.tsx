import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, untrack, type JSX } from "solid-js";
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Button, TextInput } from "@talelk/newui-atoms";
import { EmptyState, TabButtons, Tabs } from "@talelk/newui-molecules";
import { PaneLayout } from "@talelk/newui-templates";
import { LIMIT_DEFAULTS } from "@brain/contracts/limits";
import type { AgentFile, FileEntry, Language, MemoryProposal, PlayFile, SnapshotManifest, ToolFile } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { direction, human, locale, t, tn, type MessageKey } from "../i18n";
import { ago } from "../lib/format";
import { paths } from "../lib/files";
import { isSlug, slugify, slugifyTool } from "../lib/model";
import { TeamGraph } from "../components/TeamGraph";
import { FilesTab } from "../components/FilesTab";
import { CodeEditor } from "../components/CodeEditor";
import { LimitsPanel } from "../components/Limits";
import { AgentForm, MarkdownEditor, PlayForm, problemsOf, ProjectsForm, SaveBar, SettingsForm, ToolForm, useWrite } from "../components/forms";
import { Markdown } from "../components/Markdown";
import { ConfirmButton, Failure, Icon, Keyed, Ready } from "../components/bits";
import { WorkspaceActions } from "../components/Share";
import { Head } from "../components/Shell";
import { PacksTab, PackUpdates } from "../components/Packs";

const TABS = ["agents", "team", "tools", "plays", "memory", "projects", "settings", "files", "packs"] as const;
type Tab = (typeof TABS)[number];
interface Item { readonly name: string; readonly title?: string; readonly lead?: string; readonly text: string; readonly source: string }

const isToolName = (name: string): boolean => name.length <= 80 && name.split(".").every(isSlug);
/** The files that make one thing: an agent's folder, a tool's folder, a Play, a memory entry, or `brain.toml`. */
const owns = (tab: Tab, name: string) => (file: FileEntry): boolean =>
  tab === "agents" ? file.path.startsWith(`agents/${name}/`) : tab === "tools" ? file.path.startsWith(`tools/${name}/`) : tab === "plays" ? file.path === paths.play(name) : tab === "memory" ? file.path === paths.memory(name) || file.path === paths.memoryIn(name, "fr") || file.path === paths.memoryIn(name, "ar") : file.path === paths.brain;

const NEW_AGENT: AgentFile = { description: "", engine: ["pi", "claude"], native: "read", tools: [], limits: { turns: LIMIT_DEFAULTS.turns, tokens: LIMIT_DEFAULTS.tokens, spend_usd: LIMIT_DEFAULTS.spend_usd } };
const NEW_TOOL: ToolFile = { description: "", effect: "read", timeout_seconds: 60, needs: ["bash"], network: ["*"], secrets: [], inputs: {} };
const newPlay = (title: string, agent: string): PlayFile => ({ title, description: "", inputs: {}, step: [{ id: slugify(agent) || "step", agent, goal: "", after: [], requires: [], max_rounds: LIMIT_DEFAULTS.max_rounds, approve: false }] });

/** Where a file comes from, in words. */
function origin(files: readonly FileEntry[], fallback: string): string {
  const mine = files.filter((file) => file.source === "workspace");
  const replaced = mine.find((file) => file.replaces)?.replaces;
  if (replaced) return t("workspace.source.replaces", { pack: replaced });
  if (mine.length > 0) return t("workspace.source.workspace");
  return t("workspace.source.pack", { pack: files[0]?.source ?? fallback });
}

/** Every file of one thing, as text: the raw editor. */
function FileEditor(props: { files: readonly FileEntry[]; readOnly: boolean }): JSX.Element {
  const place = usePlace();
  const [path, setPath] = createSignal(props.files[0]?.path ?? "");
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({});
  const file = useQuery("file.read", () => (path() ? { workspaceId: place.id(), path: path() } : undefined));
  const write = useWrite(() => setDrafts({}));
  const text = (): string | undefined => drafts()[path()] ?? file.data()?.content;
  const changed = (): { path: string; content: string }[] => Object.entries(drafts()).map(([at, content]) => ({ path: at, content }));
  return (
    <div>
      <Show when={props.files.length > 1}>
        <TabButtons class="mb-3" label={t("workspace.files")} wrap value={path()} onValueChange={setPath} options={props.files.map((entry) => ({ value: entry.path, label: `${entry.path.split("/").at(-1)}${drafts()[entry.path] !== undefined ? " *" : ""}` }))} />
      </Show>
      <Show when={text() !== undefined} fallback={<Failure error={file.error()} />}>
        <CodeEditor label={path()} value={text() ?? ""} onChange={(value) => setDrafts({ ...drafts(), [path()]: value })} problems={problemsOf(write, path())} readOnly={props.readOnly} rows={16} />
      </Show>
      <Show when={!props.readOnly}><SaveBar write={write} onSave={() => void write.run(changed(), `Change ${changed().map((entry) => entry.path).join(", ")}`)} shown={[path()]} disabled={changed().length === 0} /></Show>
    </div>
  );
}

function Proposal(props: { proposal: MemoryProposal }): JSX.Element {
  const place = usePlace();
  const decide = useAction((decision: "accept" | "reject") => command("memory.decide", { workspaceId: place.id(), proposalId: props.proposal.id, decision }));
  return (
    <li class="rounded-card border border-(--needs-line) bg-surface-elevation-1 p-4">
      <p class="t-small font-semibold text-needs-text">{t("memory.proposal", { by: props.proposal.proposedBy, when: ago(props.proposal.at) })}</p>
      <h3 class="mt-1 t-head text-ink" dir="auto">{props.proposal.title}</h3>
      <div class="mt-3 max-h-64 overflow-auto rounded-xl bg-paper px-4 py-3"><Markdown text={props.proposal.body} /></div>
      <Failure error={decide.error()} class="mt-3" />
      <Show when={place.can("admin")} fallback={<p class="mt-3 t-small text-ink-2">{t("memory.proposal.admin")}</p>}>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="solid" theme="blue" size="md" loading={decide.busy()} onClick={() => void decide.run("accept")}>{t("memory.accept")}</Button>
          <Button variant="outline" size="md" disabled={decide.busy()} onClick={() => void decide.run("reject")}>{t("memory.reject")}</Button>
          <Show when={props.proposal.taskId}>{(taskId) => <A class="link ms-auto t-small" href={place.to(`/tasks/${taskId()}`)}>{t("memory.proposal.task")}</A>}</Show>
        </div>
      </Show>
    </li>
  );
}

/** A memory entry: Markdown whose first line is its title. */
function MemoryEntry(props: { name: string; isNew: boolean; readOnly: boolean; title?: string | undefined; onSaved: () => void }): JSX.Element {
  const place = usePlace();
  const file = useQuery("file.read", () => (props.isNew ? undefined : { workspaceId: place.id(), path: paths.memory(props.name) }));
  const [draft, setDraft] = createSignal<string | undefined>(props.isNew ? `# ${props.title || props.name.replaceAll("-", " ")}\n\n` : undefined);
  const write = useWrite(props.onSaved);
  const text = (): string | undefined => draft() ?? file.data()?.content;
  /** The entry as written for people who read this language, when it has one: shown above the English file agents read. */
  const lang = (): Language | undefined => { const titles = (place.workspace.data()?.snapshot.memory.find((entry) => entry.name === props.name))?.titles; return locale() !== "en" && titles?.[locale() as Language] !== undefined ? (locale() as Language) : undefined; };
  const translated = useQuery("file.read", () => { const at = lang(); return at && !props.isNew ? { workspaceId: place.id(), path: paths.memoryIn(props.name, at) } : undefined; });
  return (
    <Show when={text() !== undefined} fallback={<Failure error={file.error()} />}>
      <Show when={translated.data()?.content}>{(content) => <div class="mb-5 rounded-control bg-surface-gray-2 px-4 py-3" dir="auto"><Markdown text={content()} /><p class="mt-3 t-small text-ink-3">{t("memory.translated")}</p></div>}</Show>
      <MarkdownEditor label={paths.memory(props.name)} value={text() ?? ""} onChange={setDraft} problems={problemsOf(write, paths.memory(props.name))} readOnly={props.readOnly} />
      <Show when={!props.readOnly}><SaveBar write={write} onSave={() => void write.run([{ path: paths.memory(props.name), content: text() ?? "" }], `${props.isNew ? "Add" : "Change"} the memory entry ${props.name}`)} shown={[paths.memory(props.name)]} disabled={draft() === undefined} /></Show>
    </Show>
  );
}

/** Workspace: what the active workspace contains, as forms over its files and as the files themselves. */
export default function WorkspaceScreen(): JSX.Element {
  const place = usePlace();
  const navigate = useNavigate();
  const params = useParams<{ tab?: string; name?: string }>();
  const [search] = useSearchParams<{ new?: string; title?: string }>();
  const tab = (): Tab => (TABS as readonly string[]).includes(params.tab ?? "") ? (params.tab as Tab) : "agents";
  const name = (): string => params.name ?? "";
  const single = (): boolean => tab() === "projects" || tab() === "settings";
  const readOnly = (): boolean => !place.can("admin");
  const files = useQuery("workspace.files", () => ({ workspaceId: place.id() }));
  /** The tasks the Team tab reads handoffs from: the most recent ones of the workspace, sub-tasks included. */
  const recent = useQuery("tasks.list", () => (tab() === "team" ? { workspaceId: place.id(), limit: 200 } : undefined));
  const memory = useQuery("memory.list", () => ({ workspaceId: place.id() }));
  const [raw, setRaw] = createSignal(false);
  const [newName, setNewName] = createSignal<string>();
  createEffect(on(() => [tab(), name()], () => { setRaw(false); setNewName(undefined); }));
  /** On a phone the tabs scroll: the one open is brought into view. */
  createEffect(on(tab, () => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-slot="tabs-list"] [aria-selected="true"]')?.scrollIntoView({ inline: "center", block: "nearest" }))));

  const href = (to: Tab, item = ""): string => place.to(`/workspace/${to}${item ? `/${item}` : ""}`);
  const titleOf = (entry: { title: string; titles?: Readonly<Partial<Record<Language, string>>> }): string => (locale() === "en" ? undefined : entry.titles?.[locale() as Language]) ?? entry.title;
  const items = (snapshot: SnapshotManifest): Item[] => {
    if (tab() === "agents") return Object.entries(snapshot.agents).map(([key, agent]) => ({ name: key, text: human(agent.translations, ["description"], agent.description), source: agent.source }));
    if (tab() === "tools") return Object.entries(snapshot.tools).map(([key, tool]) => ({ name: key, lead: t(`effect.${tool.effect}`), text: human(tool.translations, ["description"], tool.description), source: tool.source }));
    if (tab() === "plays") return Object.entries(snapshot.plays).map(([key, play]) => ({ name: key, title: human(play.translations, ["title"], play.title), text: human(play.translations, ["description"], play.description), source: play.source }));
    if (tab() === "memory") return (memory.data()?.entries ?? snapshot.memory).map((entry) => ({ name: entry.name, title: titleOf(entry), text: "", source: entry.source }));
    return [];
  };
  const mine = createMemo((): FileEntry[] => (files.data()?.files ?? []).filter(owns(tab(), name())));
  const proposals = (): MemoryProposal[] => (memory.data()?.proposals ?? []).filter((proposal) => proposal.state === "pending");
  const remove = useAction(async () => {
    await command("file.delete", { workspaceId: place.id(), paths: mine().filter((file) => file.source === "workspace").map((file) => file.path), message: `Remove ${name()}` });
    navigate(href(tab()));
  });
  /** On a wide screen a list never opens beside an empty panel: its first item is open already. A phone keeps the list first. */
  createEffect(() => {
    const snapshot = place.workspace.data()?.snapshot;
    if (!snapshot || name() || single() || tab() === "team" || tab() === "files" || search.new !== undefined) return;
    if (!window.matchMedia("(min-width: 1024px)").matches || (tab() === "memory" && proposals().length > 0)) return;
    const first = items(snapshot)[0];
    if (first) navigate(href(tab(), first.name), { replace: true });
  });
  /** What a person types in their own words, as the name its file takes: `Release manager` is `release-manager`; a tool keeps its dots. */
  const fileName = (): string => (tab() === "tools" ? slugifyTool : slugify)((newName() ?? "").trim());
  const filePath = (name: string): string => (tab() === "agents" ? `agents/${name}/agent.toml` : tab() === "tools" ? `tools/${name}/tool.toml` : tab() === "plays" ? `plays/${name}.toml` : `memory/${name}.md`);
  const same = (): { source: string } | undefined => items(place.workspace.data()?.snapshot as SnapshotManifest).find((item) => item.name === fileName());
  const taken = (): boolean => same()?.source === "workspace";
  const create = (): void => { const made = fileName(); if (made !== "" && (tab() === "tools" ? isToolName(made) : isSlug(made)) && !taken()) navigate(`${href(tab(), made)}?new=1&title=${encodeURIComponent((newName() ?? "").trim())}`); };
  const nameValid = (): boolean => (newName() ?? "").trim() === "" || (fileName() !== "" && !taken());

  const list = (snapshot: SnapshotManifest): JSX.Element => (
    <div class={name() ? "max-lg:hidden" : ""}>
      <Show when={tab() === "memory" && proposals().length > 0}>
        <p class="mb-2 t-small font-semibold text-needs-text">{tn("memory.proposals", proposals().length)}</p>
      </Show>
      <ul class="flex flex-col gap-0.5">
        <Keyed each={items(snapshot)} by={(item) => item.name}>
          {(item) => (
            <li>
              <A href={href(tab(), item().name)} aria-current={name() === item().name ? "page" : undefined} class="block rounded-control px-3 py-2 hover:bg-surface-gray-2 aria-[current=page]:bg-surface-gray-3 focus-visible:focus-ring">
                <span class="flex items-baseline justify-between gap-2"><span class={`min-w-0 truncate t-text font-semibold text-ink ${item().title ? "" : "t-code"}`}>{item().title ?? item().name}</span><span class="shrink-0 t-small text-ink-2">{item().source === "workspace" ? t("workspace.source.here") : item().source}</span></span>
                <Show when={item().lead}><span class="block t-small text-ink-2">{item().lead}</span></Show>
                <Show when={item().text}><span class="line-clamp-2 t-small text-ink-2" dir="auto">{item().text}</span></Show>
              </A>
            </li>
          )}
        </Keyed>
      </ul>
      <Show when={items(snapshot).length === 0}><p class="px-3 t-small text-ink-3">{t(`workspace.empty.${tab()}` as MessageKey)}</p></Show>
      <Show when={!readOnly()}>
        <Show when={newName() !== undefined} fallback={<Button variant="ghost" size="md" class="mt-2" iconLeft="lucide-plus" onClick={() => setNewName("")}>{t(`workspace.new.${tab()}` as MessageKey)}</Button>}>
          <form class="mt-3 flex items-end gap-2 px-1" onSubmit={(event) => { event.preventDefault(); create(); }}>
            <div class="min-w-0 flex-1"><TextInput size="md" label={t("workspace.new.name")} description={t("workspace.new.name.help")} error={nameValid() ? undefined : taken() ? t("workspace.new.exists", { name: fileName() }) : t(tab() === "tools" ? "workspace.new.name.tool" : "workspace.new.name.slug")} value={newName() ?? ""} onInput={(event) => setNewName(event.currentTarget.value)} autofocus />
              <Show when={fileName() !== ""}><p class="mt-1 t-small text-ink-2" data-testid="file-preview">{t("workspace.new.preview")} <code class="t-code code-ltr">{filePath(fileName())}</code><Show when={same() && !taken()}> {t("workspace.new.replaces", { pack: same()?.source ?? "" })}</Show></p></Show></div>
            <Button type="submit" variant="outline" size="md" disabled={fileName() === "" || !nameValid()}>{t("workspace.new.create")}</Button>
          </form>
        </Show>
      </Show>
    </div>
  );

  return (
    <>
      <Head title={t("nav.workspace")} text={t("nav.workspace")} description={t("workspace.text", { name: place.summary().name })} breadcrumbs={[{ label: place.summary().name, route: place.to() }, { label: t("nav.workspace") }]} actions={<WorkspaceActions />} />
      <Tabs.Root value={tab()} onValueChange={(value) => navigate(href(value as Tab))} variant="underline" size="md">
        <Tabs.List aria-label={t("workspace.tabs")} class="tabs-scroll max-w-full overflow-x-auto overflow-y-hidden">
          <For each={TABS.filter((entry) => entry !== "packs" || (place.summary().platform === "admin" && place.can("admin")))}>{(entry) => <Tabs.Trigger value={entry}>{t(`workspace.tab.${entry}` as MessageKey)}</Tabs.Trigger>}</For>
        </Tabs.List>
        <Tabs.Content value={tab()} class="pt-5">
          {/* The tabs component fixes its own direction to left-to-right; what is in a tab follows the language. */}
          <div dir={direction()}>
          <Ready shape="split" data={place.workspace.data()} error={place.workspace.error()} retry={place.workspace.refetch}>
            {(workspace) => {
              const snapshot = (): SnapshotManifest => workspace().snapshot;
              const exists = (): boolean => items(snapshot()).some((item) => item.name === name());
              const isNew = (): boolean => !exists() && search.new !== undefined;
              const saved = (): void => { if (search.new !== undefined) navigate(href(tab(), name()), { replace: true }); };
              return (
                <Show when={tab() !== "team" && tab() !== "files" && tab() !== "packs"} fallback={
                  <Show when={tab() === "packs"} fallback={<Show when={tab() === "team"} fallback={<Show when={files.data()} fallback={<Failure error={files.error()} />}>{(listed) => <FilesTab files={listed().files} readOnly={readOnly()} />}</Show>}>
                    <TeamGraph snapshot={snapshot()} tasks={recent.data()?.tasks ?? []} href={(agent) => href("agents", agent)} />
                  </Show>}><PacksTab /></Show>
                }>
                <Show when={!single()} fallback={
                  <div class="max-w-[52rem] rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-5 sm:p-6">
                    <Show when={tab() === "settings"}><PackUpdates snapshot={snapshot()} updates={workspace().updates} admin={place.can("admin")} /><LimitsPanel snapshot={snapshot()} readOnly={readOnly()} /></Show>
                    <ModeSwitch raw={raw()} onChange={setRaw} class="mb-6" />
                    <Show when={raw()} fallback={<Show when={tab() === "projects"} fallback={<Show when={workspace().commit} keyed><SettingsForm snapshot={untrack(snapshot)} readOnly={readOnly()} /></Show>}><Show when={workspace().commit} keyed><ProjectsForm snapshot={untrack(snapshot)} readOnly={readOnly()} /></Show></Show>}>
                      <FileEditor files={[{ path: paths.brain, bytes: 0, source: "workspace" }]} readOnly={readOnly()} />
                    </Show>
                  </div>
                }>
                  <PaneLayout active={name() ? "end" : "start"} defaultSize={28} minStartSize={20} maxStartSize={45} resizeLabel={t("task.resize")} start={<div class="lg:pe-5">{list(snapshot())}</div>}
                    end={
                      <div class="min-w-0 lg:ps-6">
                        <Show when={name()} keyed fallback={
                          <Show when={tab() === "memory" && proposals().length > 0} fallback={<div class="max-lg:hidden"><EmptyState bordered icon="lucide-mouse-pointer-click" title={t(`workspace.pick.${tab()}` as MessageKey)} description={t(`workspace.about.${tab()}` as MessageKey)} /></div>}>
                            <ul class="flex flex-col gap-3"><Keyed each={proposals()} by={(proposal) => proposal.id}>{(proposal) => <Proposal proposal={proposal()} />}</Keyed></ul>
                          </Show>
                        }>
                          {(current) => (
                            <Show when={exists() || isNew()} fallback={<EmptyState bordered title={t("workspace.notFound", { name: current })} />}>
                              <A href={href(tab())} class="link mb-3 inline-flex items-center gap-1 t-small lg:hidden"><Icon name="lucide-chevron-left" class="size-3.5 rtl:rotate-180" />{t(`workspace.tab.${tab()}` as MessageKey)}</A>
                              <div class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-5 sm:p-6">
                                <header class="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                                  <div class="min-w-0">
                                    <h2 class="t-title break-words text-ink">{current}</h2>
                                    <p class="mt-1 t-small text-ink-2">{isNew() ? t("workspace.source.new") : origin(mine(), items(snapshot()).find((item) => item.name === current)?.source ?? "")}</p>
                                    <Show when={!isNew() && tab() !== "memory" && locale() !== "en" && items(snapshot()).find((item) => item.name === current)?.text}>{(text) => <p class="mt-2 t-text text-ink" dir="auto">{text()}</p>}</Show>
                                  </div>
                                  <div class="flex items-center gap-2">
                                    <Show when={!isNew() && tab() !== "memory"}><ModeSwitch raw={raw()} onChange={setRaw} /></Show>
                                    <Show when={!readOnly() && mine().some((file) => file.source === "workspace")}>
                                      <ConfirmButton label={mine().some((file) => file.replaces) ? t("workspace.revert") : t("action.delete")} confirm={mine().some((file) => file.replaces) ? t("workspace.revert.confirm") : t("workspace.delete.confirm", { name: current })} busy={remove.busy()} onConfirm={() => void remove.run()} />
                                    </Show>
                                  </div>
                                </header>
                                <Failure error={remove.error()} class="mb-4" />
                                <Show when={readOnly()}><p class="mb-5 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2">{t("workspace.readOnly")}</p></Show>
                                <Show when={!readOnly() && !isNew() && !mine().some((file) => file.source === "workspace")}><p class="mb-5 rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2">{t("workspace.packNote")}</p></Show>
                                <Show when={!raw()} fallback={<FileEditor files={mine()} readOnly={readOnly()} />}>
                                  <Switch>
                                    <Match when={tab() === "agents"}><Show when={!isNew()}><LimitsPanel snapshot={snapshot()} agent={current} readOnly={readOnly()} /></Show><Show when={workspace().commit} keyed><AgentForm name={current} initial={untrack(() => snapshot().agents[current] ?? NEW_AGENT)} isNew={untrack(isNew)} snapshot={snapshot()} readOnly={readOnly()} onSaved={saved} /></Show></Match>
                                    <Match when={tab() === "tools"}><ToolForm name={current} initial={untrack(() => snapshot().tools[current] ?? NEW_TOOL)} isNew={untrack(isNew)} readOnly={readOnly()} onSaved={saved} /></Match>
                                    <Match when={tab() === "plays"}><PlayForm name={current} initial={untrack(() => snapshot().plays[current] ?? newPlay(search.title || current, Object.keys(snapshot().agents)[0] ?? ""))} isNew={untrack(isNew)} snapshot={snapshot()} readOnly={readOnly()} onSaved={saved} /></Match>
                                    <Match when={tab() === "memory"}><MemoryEntry name={current} title={search.title} isNew={untrack(isNew)} readOnly={readOnly()} onSaved={saved} /></Match>
                                  </Switch>
                                </Show>
                              </div>
                            </Show>
                          )}
                        </Show>
                      </div>
                    } />
                </Show>
                </Show>
              );
            }}
          </Ready>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}

function ModeSwitch(props: { raw: boolean; onChange: (raw: boolean) => void; class?: string }): JSX.Element {
  return <TabButtons class={props.class} label={t("workspace.mode")} value={props.raw ? "file" : "form"} onValueChange={(value) => props.onChange(value === "file")} options={[{ value: "form", label: t("workspace.mode.form") }, { value: "file", label: t("workspace.mode.file") }]} />;
}
