import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { Card, EmptyState, FileCard, Select, ToggleGroup, Tree } from "@talelk/newui-molecules";
import type { TreeItem } from "@talelk/newui-molecules";
import { SelectionBar } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import { useNavigate } from "@solidjs/router";
import { useApp } from "../app-context";
import { ScreenRegion } from "../screen-region";
import type { ScreenState } from "../../data/screens";
import { formatRelative, shortDigest } from "../format";
import { LIST_PAGE_SIZE, Pager } from "../components/primitives";
import { ActionFeedback } from "../components/ActionFeedback";
import type { FeedbackTone } from "../components/ActionFeedback";
import { FormSheet } from "../components/BrainForm";
import { missionHref } from "../mission-links";
import type { ArtifactHistory } from "../../data/exec-outputs";
import { ArtifactView } from "./ArtifactView";
import { ArtifactMetaStrip, OutputHistory, resolveWorkItemLink } from "./OutputHistory";
import { OutputReview } from "./OutputReview";
import {
  KIND_ICONS,
  buildFolders,
  formatBytes,
  groupByMission,
  groupByTask,
  inFolder,
  matchesSearch,
  needsReview,
  previewKindLabel,
  resolveFiles,
} from "./output-files";
import type { ArtifactPreviewKind, FolderId, FolderNode, OutputFile, OutputGrouping, OutputItem } from "./output-files";
import { acceptFromArtifact, downloadArtifacts, moveWorkItem, saveAsKnowledge } from "./review-actions";

/**
 * The Output Browser as a file explorer (plan T61): a folder tree (Needs
 * review, All outputs, mission → work item), a grid or list of file cards with
 * type, size, producer and review state, multi-select with one bulk selection
 * bar, and a preview pane that renders each file natively with copy and
 * download. Digest and provenance sit under Details; version history and the
 * two-file compare hand-off stay. The page owns reads and URL state; this
 * component owns only transient UI state (ticked files, bulk feedback).
 */

export type { OutputGrouping, OutputItem } from "./output-files";

/** "current" shows fresh and final output together so new work is never hidden; the rest narrow it. */
const STATE_OPTIONS = [
  { value: "current", label: "Latest output", description: "Fresh and final outputs together" },
  { value: "verified", label: "Final only", description: "Completed outputs bound to their immutable digest" },
  { value: "uploading", label: "Still being produced", description: "Shown only when the runtime actually publishes them" },
  { value: "quarantined", label: "Failed checks", description: "Failed verification; kept for audit" },
  { value: "deleted", label: "Deleted", description: "Removed from the browser; retained for audit" },
] as const;

export interface OutputScope {
  jobId?: string;
  runId?: string;
  workItemId?: string;
}

export type OutputView = "grid" | "list";

export function OutputBrowser(props: {
  artifacts: readonly OutputItem[];
  state: ScreenState<unknown>;
  stateFilter: string;
  onStateFilter: (value: string) => void;
  scope: OutputScope;
  onScopeChange: (scope: OutputScope) => void;
  /** The folder in the URL; absent means the default (Needs review when anything waits, else All outputs). */
  folder: string | undefined;
  onFolder: (folder: FolderId) => void;
  view: OutputView;
  onView: (view: OutputView) => void;
  search: string;
  onSearch: (search: string) => void;
  kind: string;
  onKind: (kind: string) => void;
  selectedId: string | undefined;
  onSelect: (artifactId: string | undefined) => void;
  onCompare: (leftId: string, rightId: string) => void;
  detail: { history?: ArtifactHistory; loading: boolean; error: string };
  grouping: OutputGrouping;
  onRefresh: () => void;
  onOpenDetail: (artifactId: string) => void;
}): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [page, setPage] = createSignal(1);
  const [checked, setChecked] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const [feedback, setFeedback] = createSignal<{ tone: FeedbackTone; message: string }>();
  const [asking, setAsking] = createSignal(false);
  const [reason, setReason] = createSignal("");

  const files = createMemo(() => resolveFiles(props.artifacts, props.grouping));
  const folders = createMemo(() => buildFolders(files()));
  const scoped = () => Boolean(props.scope.jobId || props.scope.runId || props.scope.workItemId);
  const folder = (): FolderId => {
    const requested = props.folder as FolderId | undefined;
    if (requested && (requested === "all" || requested === "review" || flatFolders(folders()).some((node) => node.value === requested))) return requested;
    return !scoped() && files().some(needsReview) ? "review" : "all";
  };
  const folderNode = () => flatFolders(folders()).find((node) => node.value === folder());
  const kinds = createMemo(() => [...new Set(files().map((file) => file.kind))]);
  const visible = createMemo(() =>
    files().filter((file) => inFolder(file, folder()) && matchesSearch(file, props.search) && (!props.kind || file.kind === props.kind)),
  );
  const paged = () => {
    const pageCount = Math.max(1, Math.ceil(visible().length / LIST_PAGE_SIZE));
    const current = Math.min(Math.max(1, page()), pageCount);
    return { current, files: visible().slice((current - 1) * LIST_PAGE_SIZE, current * LIST_PAGE_SIZE) };
  };
  const groups = createMemo(() => groupByMission(paged().files));
  const previewed = () => files().find((file) => file.artifact.artifactId === props.selectedId);

  const checkedFiles = createMemo(() => files().filter((file) => checked().has(file.artifact.artifactId)));
  const toggle = (artifactId: string, on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(artifactId);
      else next.delete(artifactId);
      return next;
    });
  const clearChecked = () => setChecked(new Set<string>());
  /** One entry per work item in review among the ticked files: the item and the first ticked file that carries it. */
  const reviewable = createMemo(() => {
    const byItem = new Map<string, OutputFile>();
    for (const file of checkedFiles()) if (needsReview(file) && file.item && !byItem.has(file.item.workItemId)) byItem.set(file.item.workItemId, file);
    return [...byItem.values()];
  });
  const canReview = () => app.canDispatch() && reviewable().length > 0;

  const resetPage = () => setPage(1);

  async function bulk(label: string, run: (file: OutputFile) => Promise<{ accepted: boolean; detail: string }>, targets: readonly OutputFile[]): Promise<void> {
    if (busy() || targets.length === 0) return;
    setBusy(true);
    setFeedback(undefined);
    const refused: string[] = [];
    for (const file of targets) {
      const result = await run(file);
      if (!result.accepted) refused.push(`${file.item?.title ?? file.name}: ${result.detail}`);
    }
    setBusy(false);
    const done = targets.length - refused.length;
    if (refused.length === 0) {
      setFeedback({ tone: "success", message: `${label} ${done} ${done === 1 ? "item" : "items"}.` });
      clearChecked();
    } else setFeedback({ tone: "warning", message: `${label} ${done} of ${targets.length}. ${refused.join(" · ")}` });
    props.onRefresh();
  }

  const accept = () => bulk("Accepted", (file) => acceptFromArtifact(app, file.item!, file.artifact.artifactId), reviewable());
  const requestChanges = async () => {
    const text = reason().trim();
    if (!text) return;
    await bulk("Sent back", (file) => moveWorkItem(app, file.item!, { state: "in-progress", reason: text }), reviewable());
    setAsking(false);
    setReason("");
  };
  const saveKnowledge = (targets: readonly OutputFile[]) => bulk("Saved to knowledge", (file) => saveAsKnowledge(app, file.artifact), targets);

  const toolbar = (
    <Card padding="sm" class="flex-row flex-wrap items-end gap-3" data-testid="outputs-toolbar">
      <TextInput
        class="min-w-0 flex-1 basis-56"
        label="Search files"
        type="search"
        prefix={<span class="lucide-search size-4 text-ink-gray-6" aria-hidden="true" />}
        placeholder="Name, type or task"
        value={props.search}
        onInput={(event) => {
          resetPage();
          props.onSearch(event.currentTarget.value);
        }}
      />
      <Select
        class="w-full sm:w-48"
        label="Show"
        value={props.stateFilter || "current"}
        options={STATE_OPTIONS.map((option) => ({ value: option.value, label: option.label, description: option.description }))}
        onValueChange={(value) => {
          resetPage();
          clearChecked();
          props.onStateFilter(value ?? "current");
        }}
      />
      <Select
        class="w-full sm:w-40"
        label="Type"
        value={props.kind || "any"}
        options={[{ value: "any", label: "Any type" }, ...kinds().map((kind) => ({ value: kind, label: previewKindLabel(kind) }))]}
        onValueChange={(value) => {
          resetPage();
          props.onKind(!value || value === "any" ? "" : value);
        }}
      />
      <span class="ms-auto flex items-center gap-2">
        <ToggleGroup.Root aria-label="File layout" value={[props.view]} onValueChange={(value) => value[0] && props.onView(value[0] as OutputView)}>
          <ToggleGroup.Item value="grid" icon="lucide-layout-grid" aria-label="Grid" />
          <ToggleGroup.Item value="list" icon="lucide-list" aria-label="List" />
        </ToggleGroup.Root>
        <Button size="sm" variant="ghost" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>
          Refresh
        </Button>
      </span>
      <ScopeChips scope={props.scope} onScopeChange={props.onScopeChange} />
    </Card>
  );

  const filesPane = (
    <section class="flex min-w-0 flex-col gap-3 lg:pe-3" aria-label="Files" data-testid="outputs-files">
      <header class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 class="min-w-0 truncate text-section font-semibold text-ink-gray-9">{folderNode()?.label ?? "All outputs"}</h2>
        <span class="text-caption tabular-nums text-ink-gray-6">
          {visible().length} {visible().length === 1 ? "file" : "files"}
        </span>
      </header>
      <Show when={props.stateFilter === "uploading"}>
        <p class="text-caption text-ink-gray-6">
          Provisional snapshots appear only while the runtime publishes them; Brain binds the final digest and its verification when the run completes.
        </p>
      </Show>
      <SelectionBar
        count={checkedFiles().length}
        placement="sticky"
        summary={reviewable().length ? `${reviewable().length} waiting for your review` : "None of these wait for review"}
        primary={{ label: "Accept", icon: "lucide-check", disabled: !canReview() || busy(), onClick: () => void accept() }}
        secondary={
          <>
            <Button size="sm" variant="outline" iconLeft="lucide-message-square-warning" disabled={!canReview() || busy()} onClick={() => setAsking(true)}>
              Request changes
            </Button>
            <Button size="sm" variant="ghost" iconLeft="lucide-library" disabled={busy()} onClick={() => void saveKnowledge(checkedFiles())}>
              Save as knowledge
            </Button>
            <Button size="sm" variant="ghost" iconLeft="lucide-download" disabled={busy()} onClick={() => downloadArtifacts(checkedFiles().map((file) => file.artifact))}>
              Download
            </Button>
            <Show when={checkedFiles().length === 2}>
              <Button
                size="sm"
                variant="ghost"
                iconLeft="lucide-git-compare"
                onClick={() => props.onCompare(checkedFiles()[0]!.artifact.artifactId, checkedFiles()[1]!.artifact.artifactId)}
              >
                Compare
              </Button>
            </Show>
          </>
        }
        onClear={clearChecked}
      />
      <Show when={feedback()}>{(current) => <ActionFeedback tone={current().tone} message={current().message} title="Some items were not changed" />}</Show>
      <ScreenRegion
        state={props.state}
        skeleton={props.view === "grid" ? "cards" : "rows"}
        onRetry={props.onRefresh}
        emptyTitle={scoped() ? "No outputs from this producer yet" : props.stateFilter === "current" ? "Nothing produced yet" : "No outputs in this view"}
        emptyDescription={
          scoped()
            ? "Clear a scope chip or pick another producer; files appear here as soon as their attempt publishes them."
            : "Files appear here as runs publish them, with previews, verification and version history."
        }
      >
        <Show
          when={visible().length > 0}
          fallback={
            <EmptyState
              size="sm"
              icon={folder() === "review" ? "lucide-inbox" : "lucide-search-x"}
              title={folder() === "review" && !props.search && !props.kind ? "Nothing waits for your review" : "No files match"}
              description={folder() === "review" ? "Every produced file has been reviewed. Browse all outputs to read them again." : "Clear the search or type filter, or open another folder."}
              action={
                <Button size="sm" variant="outline" onClick={() => { props.onSearch(""); props.onKind(""); props.onFolder("all"); }}>
                  Show all outputs
                </Button>
              }
            />
          }
        >
          <div class="flex min-w-0 flex-col gap-5" data-testid="outputs-list">
            <For each={groups()}>
              {(group) => (
                <section class="flex min-w-0 flex-col gap-2" aria-label={group.title} data-testid="outputs-group">
                  <header class="flex min-w-0 items-center gap-2">
                    <span class={`${group.missionId ? "lucide-folder" : "lucide-folder-x"} size-4 shrink-0 text-ink-gray-6`} aria-hidden="true" />
                    <Show when={group.missionId && group.workspaceId} fallback={<h3 class="min-w-0 truncate text-interface font-medium text-ink-gray-9">{group.title}</h3>}>
                      <h3 class="min-w-0 truncate text-interface font-medium">
                        <a
                          class="text-ink-gray-9 hover:underline focus-visible:focus-ring"
                          href={missionHref(group.workspaceId!, group.missionId!, "outputs")}
                          onClick={(event) => {
                            event.preventDefault();
                            void navigate(missionHref(group.workspaceId!, group.missionId!, "outputs"));
                          }}
                        >
                          {group.title}
                        </a>
                      </h3>
                    </Show>
                    <span class="text-caption tabular-nums text-ink-gray-6">{group.files.length}</span>
                  </header>
                  <div class="flex min-w-0 flex-col gap-3">
                    <For each={groupByTask(group.files)}>
                      {(task) => (
                        <div class="flex min-w-0 flex-col gap-1.5" data-testid="output-task">
                          <Show
                            when={task.result}
                            fallback={
                              <p class="text-caption text-ink-gray-6">
                                {task.title ? `${task.title}: ` : ""}no readable result yet. Its technical files are below.
                              </p>
                            }
                          >
                            {(result) => (
                              <div class={props.view === "grid" ? "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2" : "flex min-w-0 flex-col gap-1.5"}>
                                <FileTile
                                  file={result()}
                                  heading={task.title ? `Result: ${task.title}` : undefined}
                                  view={props.view}
                                  previewed={props.selectedId === result().artifact.artifactId}
                                  checked={checked().has(result().artifact.artifactId)}
                                  onOpen={() => props.onSelect(result().artifact.artifactId)}
                                  onCheck={(on) => toggle(result().artifact.artifactId, on)}
                                />
                              </div>
                            )}
                          </Show>
                          <Show when={task.technical.length > 0}>
                            <details class="min-w-0 rounded-card border border-outline-gray-2 px-3 py-1.5" data-testid="output-technical" open={task.technical.some((file) => checked().has(file.artifact.artifactId) || props.selectedId === file.artifact.artifactId)}>
                              <summary class="cursor-pointer text-caption text-ink-gray-7">
                                Technical files ({task.technical.length}): run records and data
                              </summary>
                              <div class={`mt-2 ${props.view === "grid" ? "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2" : "flex min-w-0 flex-col gap-1.5"}`}>
                                <For each={task.technical}>
                                  {(file) => (
                                    <FileTile
                                      file={file}
                                      view={props.view}
                                      previewed={props.selectedId === file.artifact.artifactId}
                                      checked={checked().has(file.artifact.artifactId)}
                                      onOpen={() => props.onSelect(file.artifact.artifactId)}
                                      onCheck={(on) => toggle(file.artifact.artifactId, on)}
                                    />
                                  )}
                                </For>
                              </div>
                            </details>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
          <Pager count={visible().length} page={paged().current} onPage={setPage} label="Output list pagination" />
        </Show>
      </ScreenRegion>
    </section>
  );

  const previewPane = (
    <section class="flex min-w-0 flex-col gap-3" aria-label="Preview" data-testid="outputs-preview">
      <Show
        when={props.selectedId}
        keyed
        fallback={<EmptyState size="sm" icon="lucide-file-search" title="Pick a file to preview it" description="Its preview, review action and history open here without leaving the page." />}
      >
        {(selectedId) => (
          <Show when={previewed()} fallback={<OpenDetailHint artifactId={selectedId} onOpenDetail={props.onOpenDetail} />}>
            {(file) => (
              <div class="brain-detail-stack" data-testid="outputs-detail">
                <div class="flex flex-wrap items-center gap-2 lg:hidden">
                  <Button size="sm" variant="ghost" iconLeft="lucide-arrow-left" onClick={() => props.onSelect(undefined)}>
                    Back to files
                  </Button>
                </div>
                <ArtifactView artifact={file().artifact} />
                <OutputReview
                  item={file().item}
                  link={file().link ?? resolveWorkItemLink(props.grouping.links, props.detail.history)}
                  history={props.detail.history}
                  onChanged={props.onRefresh}
                  bulkSelected={checkedFiles().length}
                />
                <details class="rounded-card border border-outline-gray-2 p-3">
                  <summary class="cursor-pointer text-interface font-medium text-ink-gray-9">Details</summary>
                  <div class="mt-2">
                    <ArtifactMetaStrip history={props.detail.history} loading={props.detail.loading} error={props.detail.error} executions={props.grouping.links} />
                  </div>
                </details>
                <OutputHistory history={props.detail.history} loading={props.detail.loading} error={props.detail.error} />
                <div class="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" iconLeft="lucide-library" disabled={busy()} onClick={() => void saveKnowledge([file()])}>
                    Save as knowledge
                  </Button>
                  <Button size="sm" variant="ghost" iconRight="lucide-external-link" onClick={() => props.onOpenDetail(file().artifact.artifactId)}>
                    Open full page
                  </Button>
                </div>
              </div>
            )}
          </Show>
        )}
      </Show>
    </section>
  );

  return (
    <div class="flex min-w-0 flex-col gap-4">
      {toolbar}
      <div class="grid min-w-0 gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav class="min-w-0" aria-label="Output folders">
          <div class="hidden lg:block">
            <FolderTree folders={folders()} value={folder()} onChange={(value) => { resetPage(); props.onFolder(value); }} />
          </div>
          <div class="lg:hidden">
            <Select
              label="Folder"
              value={folder()}
              options={flatFolders(folders()).map((node) => ({ value: node.value, label: `${node.label} (${node.count})` }))}
              onValueChange={(value) => {
                if (!value) return;
                resetPage();
                props.onFolder(value as FolderId);
              }}
            />
          </div>
        </nav>
        <Card padding="sm" class="min-w-0">
          <PaneLayout
            class="brain-list-detail"
            startSize={46}
            minStartSize={30}
            maxStartSize={64}
            active={props.selectedId ? "end" : "start"}
            resizeLabel="Resize files and preview"
            start={filesPane}
            end={previewPane}
          />
        </Card>
      </div>
      <FormSheet
        open={asking()}
        onClose={() => setAsking(false)}
        centered
        title="Request changes"
        description={`Send ${reviewable().length} ${reviewable().length === 1 ? "work item" : "work items"} back to In progress with one note.`}
        submit="Send back for changes"
        icon="lucide-message-square-warning"
        busy={busy()}
        disabled={!reason().trim()}
        onSubmit={requestChanges}
      >
        <Textarea label="What should change?" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} rows={4} />
      </FormSheet>
    </div>
  );
}

function flatFolders(nodes: readonly FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flatFolders(node.children ?? [])]);
}

/** Folder tree: zag's tree-view for keyboard and ARIA, folders only — the file pane shows their files. */
function FolderTree(props: { folders: readonly FolderNode[]; value: FolderId; onChange: (value: FolderId) => void }): JSX.Element {
  const toItem = (node: FolderNode): TreeItem => ({ value: node.value, label: node.label, folder: node, ...(node.children?.length ? { children: node.children.map(toItem) } : {}) });
  const items = createMemo(() => props.folders.map(toItem));
  // Missions start open; the tree only remembers which ones the person folded.
  const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set());
  const branches = () => props.folders.filter((node) => node.children?.length).map((node) => node.value as string);
  return (
    <Tree.Root
      items={items()}
      selectedValue={[props.value]}
      onSelectionChange={(value) => value[0] && props.onChange(value[0] as FolderId)}
      expandedValue={branches().filter((value) => !folded().has(value))}
      onExpandedChange={(open) => setFolded(new Set(branches().filter((value) => !open.includes(value))))}
      class="brain-folder-tree"
    >
      <Tree.Label class="sr-only">Output folders</Tree.Label>
      <Tree.Tree>
        <For each={items()}>{(node, index) => <FolderTreeNode node={node} indexPath={[index()]} />}</For>
      </Tree.Tree>
    </Tree.Root>
  );
}

function FolderTreeNode(props: { node: TreeItem; indexPath: number[] }): JSX.Element {
  const folder = () => props.node.folder as FolderNode;
  const tail = (
    <>
      <Show when={folder().attention}>
        <span class="size-1.5 shrink-0 rounded-full bg-surface-amber-7" aria-hidden="true" />
      </Show>
      <span class="shrink-0 text-caption tabular-nums text-ink-gray-6">{folder().count}<span class="sr-only"> files</span></span>
    </>
  );
  const icon = () => <span class={`${folder().icon} size-4 shrink-0 text-ink-gray-6`} aria-hidden="true" />;
  return (
    <Show
      when={props.node.children?.length}
      fallback={
        <Tree.Item node={props.node} indexPath={props.indexPath} class="ps-[calc((var(--depth)-1)*1rem+0.5rem)]">
          {icon()}
          <Tree.ItemText node={props.node} indexPath={props.indexPath} class="min-w-0 flex-1">
            {folder().label}
          </Tree.ItemText>
          {tail}
        </Tree.Item>
      }
    >
      <Tree.Branch node={props.node} indexPath={props.indexPath}>
        <Tree.BranchControl node={props.node} indexPath={props.indexPath} class="ps-[calc((var(--depth)-1)*1rem)]">
          <span class="grid size-5 shrink-0 place-items-center">
            <Tree.BranchIndicator node={props.node} indexPath={props.indexPath} />
          </span>
          {icon()}
          <Tree.BranchText node={props.node} indexPath={props.indexPath} class="min-w-0 flex-1">
            {folder().label}
          </Tree.BranchText>
          {tail}
        </Tree.BranchControl>
        <Tree.BranchContent node={props.node} indexPath={props.indexPath}>
          <For each={(props.node.children as TreeItem[] | undefined) ?? []}>
            {(child, index) => <FolderTreeNode node={child} indexPath={[...props.indexPath, index()]} />}
          </For>
        </Tree.BranchContent>
      </Tree.Branch>
    </Show>
  );
}

function FileTile(props: { file: OutputFile; heading?: string | undefined; view: "grid" | "list"; previewed: boolean; checked: boolean; onOpen: () => void; onCheck: (on: boolean) => void }): JSX.Element {
  const meta = () => {
    const parts = [previewKindLabel(props.file.kind as ArtifactPreviewKind), formatBytes(props.file.artifact.bytes)];
    if (props.file.artifact.createdAt) parts.push(formatRelative(props.file.artifact.createdAt));
    if (props.view === "list" && props.file.item) parts.push(props.file.item.title);
    if (props.file.link) parts.push(`from ${props.file.link.runId}`);
    if (props.view === "list" && props.file.item?.assignment) parts.push(`by ${props.file.item.assignment.id}`);
    return parts.join(" · ");
  };
  return (
    <div class="relative min-w-0" data-testid="output-file" data-review={needsReview(props.file) ? "true" : undefined}>
      <FileCard
        as="button"
        size={props.view === "grid" ? "md" : "sm"}
        name={props.heading ?? props.file.name}
        icon={KIND_ICONS[props.file.kind]}
        meta={meta()}
        badge={<Badge size="sm" variant="subtle" theme={props.file.status.theme} label={props.file.status.label} />}
        selected={props.previewed}
        aria-label={`Preview ${props.heading ?? props.file.name}`}
        class={`pe-10 ${props.checked ? "ring-1 ring-outline-blue-4" : ""}`}
        onClick={props.onOpen}
      />
      <div class="absolute end-3 top-1/2 -translate-y-1/2">
        <Checkbox checked={props.checked} onCheckedChange={props.onCheck} label={<span class="sr-only">Select {props.file.name}</span>} />
      </div>
    </div>
  );
}

function ScopeChips(props: { scope: OutputScope; onScopeChange: (scope: OutputScope) => void }): JSX.Element {
  const chips = () => [
    ...(props.scope.jobId ? [{ key: "jobId" as const, label: `Run ${shortDigest(props.scope.jobId, 10)}` }] : []),
    ...(props.scope.runId ? [{ key: "runId" as const, label: `Workflow run ${shortDigest(props.scope.runId, 10)}` }] : []),
    ...(props.scope.workItemId ? [{ key: "workItemId" as const, label: `Work item ${shortDigest(props.scope.workItemId, 10)}` }] : []),
  ];
  return (
    <Show when={chips().length}>
      <fieldset class="m-0 flex basis-full flex-wrap items-center gap-1 border-0 p-0">
        <legend class="sr-only">Scoped to a producer or work item</legend>
        <For each={chips()}>
          {(chip) => (
            <span class="inline-flex items-center gap-1 rounded-control border border-outline-blue-3 bg-surface-blue-1 px-2 py-1 text-caption text-ink-blue-8">
              {chip.label}
              <button type="button" aria-label={`Remove ${chip.label} scope`} class="focus-visible:focus-ring" onClick={() => props.onScopeChange({ ...props.scope, [chip.key]: undefined })}>
                <span class="lucide-x size-3.5" aria-hidden="true" />
              </button>
            </span>
          )}
        </For>
      </fieldset>
    </Show>
  );
}

function OpenDetailHint(props: { artifactId: string; onOpenDetail: (artifactId: string) => void }): JSX.Element {
  return (
    <EmptyState
      size="sm"
      icon="lucide-file-question"
      title="This file is outside the current view"
      description="It is not in this folder or filter. Open it on its own page."
      action={
        <Button size="sm" variant="outline" onClick={() => props.onOpenDetail(props.artifactId)}>
          Open file
        </Button>
      }
    />
  );
}
