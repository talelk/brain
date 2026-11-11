import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { parse, stringify } from "yaml";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import { TabButtons } from "@talelk/newui-molecules";
import type { ConfigurationDraft, DocumentDiff, DraftImpact, DraftRevision, PublicationProposal, ValidationRun } from "@brain/contracts";
import { useApp } from "../app-context";
import { AgentCatalog } from "../../routes/catalog";
import { createScopedRead } from "../../data/screens";
import { governor, query } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { BrainPage, PageStack } from "../components/PageLayout";
import { FormSheet } from "../components/BrainForm";

interface DraftDetails {
  draft: ConfigurationDraft;
  revisions: DraftRevision[];
  validations: ValidationRun[];
  publications: PublicationProposal[];
  diff: DocumentDiff[];
  impact: DraftImpact;
}
interface ReleaseSummary { digest: string; active: boolean }
interface StepRow { id: string; kind: string; needs: string; value: Record<string, unknown> }

export function StudioListPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const kind = () => params.kind ?? "Workflow";
  const [title, setTitle] = createSignal("");
  const [createOpen, setCreateOpen] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const drafts = createScopedRead<{ items: ConfigurationDraft[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: ConfigurationDraft[] }; asOf: string; sourceWatermark: number }>({ queryType: "configDrafts.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
    refreshMs: 3000,
  });

  const [attempted, setAttempted] = createSignal(false);
  async function create(): Promise<void> {
    setAttempted(true);
    if (busy() || !title().trim()) return;
    setBusy(true); setError("");
    try {
      const created = await app.run("configDraft.create", { title: title().trim(), kind: kind() });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      navigate(`/studio/${encodeURIComponent(kind())}/${encodeURIComponent(created.resourceId)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Draft creation failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title={`${kind()} studio`} description="Create immutable configuration revisions, validate them and publish exact Git commits without editing the active release."
    actions={<Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => { setError(""); setCreateOpen(true); }}>New draft</Button>}>
    <PageStack>
      <div class="flex min-w-0 flex-wrap items-center gap-3">
        <span class="text-caption font-medium text-ink-gray-7">Customize</span>
        <TabButtons label="Customize" value={kind()} wrap onValueChange={(value) => void navigate(`/studio/${encodeURIComponent(value)}`)}
          options={[{ value: "Agent", label: "Agents" }, { value: "Workflow", label: "Workflows" }, { value: "Play", label: "Plays" }]} />
      </div>
      <Show when={kind() === "Agent"}><AgentCatalog /></Show>
      <FormSheet open={createOpen()} onClose={() => setCreateOpen(false)} title="New draft" centered description={kind() === "Workflow" ? "Start with visual steps or restricted YAML. Publication never edits the active release directly." : kind() === "Agent" ? "Start with the agent contract and versioned instructions, then validate the complete release before publication." : "Author a reviewed definition with restricted YAML, validation, diff and explicit publication."}
        submit="Create draft" icon="lucide-plus" busy={busy()} onSubmit={create} error={error()} errorTitle="Draft creation failed">
        <TextInput label="Definition title" required value={title()} onInput={(event) => setTitle(event.currentTarget.value)} error={attempted() && !title().trim() ? "Give the draft a title." : undefined} placeholder="Operations workflow" />
      </FormSheet>
      <Section title="Drafts" surface="card" density="compact" class="p-3 sm:p-4">
        <ScreenRegion state={drafts.state()} onRetry={() => void drafts.refresh()} emptyTitle="No configuration drafts" emptyDescription="Create a draft to start an immutable authoring and publication pipeline.">
          <Show when={drafts.state().data?.items.some((draft) => draft.kind === kind())} fallback={<div class="border-y border-outline-gray-1 py-4"><p class="text-interface font-medium text-ink-gray-8">No {kind()} drafts</p><p class="mt-1 text-caption text-ink-gray-6">Create a {kind().toLowerCase()} draft to start an immutable authoring and publication pipeline.</p></div>}>
            <div class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1"><For each={drafts.state().data?.items.filter((draft) => draft.kind === kind())}>{(draft) => <a class="group flex min-w-0 flex-col gap-1 py-3 first:pt-0 last:pb-0 focus-visible:focus-ring" href={`/studio/${encodeURIComponent(draft.kind)}/${encodeURIComponent(draft.draftId)}`}>
              <div class="flex min-w-0 flex-wrap items-center justify-between gap-2"><strong class="min-w-0 break-words text-base-medium group-hover:text-ink-blue-link">{draft.title}</strong><Badge size="sm" theme={draft.state === "published" ? "green" : draft.state === "invalid" || draft.state === "failed" ? "red" : "amber"} label={draft.state} /></div>
              <span class="text-caption text-ink-gray-6">{draft.kind} · revision record v{draft.version}</span>
              <code class="break-all text-caption text-ink-gray-6">{draft.draftId}</code>
            </a>}</For></div>
          </Show>
        </ScreenRegion>
      </Section>
    </PageStack>
  </BrainPage>;
}

export function StudioEditorPage(): JSX.Element {
  const app = useApp();
  const params = useParams();
  const draftId = () => params.draftId ?? "";
  const [content, setContent] = createSignal("");
  const [instructions, setInstructions] = createSignal("");
  const [steps, setSteps] = createSignal<StepRow[]>([]);
  const [mode, setMode] = createSignal<"visual" | "yaml">("visual");
  const [dirty, setDirty] = createSignal(false);
  const [bindingId, setBindingId] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const detail = createScopedRead<DraftDetails>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: DraftDetails; asOf: string; sourceWatermark: number }>({ queryType: "configDrafts.get", workspaceId: scope.workspaceId, resourceId: draftId() }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    refreshMs: 2000,
  });
  const releases = createScopedRead<{ items: ReleaseSummary[] }>({
    scope: app.scope,
    load: async (_scope, signal) => ({ snapshot: await governor<{ items: ReleaseSummary[] }>("/v1/config/releases", undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }),
    refreshMs: 5000,
  });
  const current = createMemo(() => detail.state().data?.revisions[0]);
  const activeDigest = () => releases.state().data?.items.find((release) => release.active)?.digest ?? null;
  const latestPublication = () => detail.state().data?.publications[0];

  createEffect(() => {
    const revision = current();
    if (!revision || dirty()) return;
    const document = revision.documents[0];
    if (!document) return;
    setContent(document.text);
    setInstructions(revision.assets.find((asset) => asset.path.endsWith(".md"))?.text ?? "");
    setMode(detail.state().data?.draft.kind === "Workflow" ? "visual" : "yaml");
    setBindingId(detail.state().data?.draft.bindingId ?? "");
    try {
      const value = parse(document.text) as { spec?: { jobs?: Record<string, Record<string, unknown>> } };
      setSteps(Object.entries(value.spec?.jobs ?? {}).map(([id, step]) => ({ id, kind: String(step["kind"] ?? "dispatch"), needs: Array.isArray(step["needs"]) ? step["needs"].join(", ") : "", value: step })));
    } catch { setSteps([]); }
  });

  function updateStep(index: number, field: "id" | "kind" | "needs", value: string): void {
    setDirty(true);
    setSteps((rows) => rows.map((row, position) => position === index ? { ...row, [field]: value } : row));
  }

  function applySteps(): void {
    const value = parse(content()) as { spec?: { jobs?: Record<string, Record<string, unknown>> } };
    value.spec ??= {};
    value.spec.jobs = Object.fromEntries(steps().map((row) => [row.id, { ...row.value, kind: row.kind, needs: row.needs.split(",").map((need) => need.trim()).filter(Boolean) }]));
    setContent(stringify(value));
    setDirty(true);
  }

  async function save(): Promise<void> {
    const draft = detail.state().data?.draft;
    if (!draft || busy()) return;
    setBusy(true); setError("");
    try {
      if (mode() === "visual") applySteps();
      const revision = current()!;
      const updated = await app.run("configDraft.update", {
        draftId: draft.draftId, source: mode(), documents: [{ path: revision.documents[0]!.path, text: content() }, ...revision.documents.slice(1)],
        assets: revision.assets.map((asset) => asset.path.endsWith(".md") ? { ...asset, text: instructions() } : asset),
      }, { expectedVersion: draft.version });
      if (!updated.accepted) throw new Error(updated.detail);
      setDirty(false);
      await detail.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Draft update failed"); }
    finally { setBusy(false); }
  }

  async function run(kind: "validate" | "test"): Promise<void> {
    if (busy()) return;
    if (dirty()) await save();
    setBusy(true); setError("");
    try {
      const result = await app.run(kind === "validate" ? "configDraft.validate" : "configDraft.test", { draftId: draftId() });
      if (!result.accepted) throw new Error(result.detail);
      await detail.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : `${kind} failed`); }
    finally { setBusy(false); }
  }

  async function publish(): Promise<void> {
    const draft = detail.state().data?.draft;
    if (!draft || busy()) return;
    if (dirty()) await save();
    setBusy(true); setError("");
    try {
      const published = await app.run("configDraft.publish", { draftId: draftId(), ...(bindingId().trim() ? { bindingId: bindingId().trim() } : {}) }, { expectedVersion: detail.state().data!.draft.version });
      if (!published.accepted) throw new Error(published.detail);
      await detail.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Publication failed"); }
    finally { setBusy(false); }
  }

  async function activate(): Promise<void> {
    const publication = latestPublication();
    if (!publication?.releaseDigest || busy()) return;
    setBusy(true); setError("");
    try {
      const activated = await app.run("config.activate", { configDigest: publication.releaseDigest, expectedActiveDigest: activeDigest() });
      if (!activated.accepted) throw new Error(activated.detail);
      await releases.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Activation failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title={detail.state().data?.draft.title ?? "Configuration Studio"} description="Edit immutable revisions, run structural checks, publish an exact Git commit, then activate it explicitly."
    actions={<><Button size="sm" variant="outline" disabled={busy()} onClick={() => void run("validate")}>Validate</Button><Button size="sm" variant="outline" disabled={busy()} onClick={() => void run("test")}>Run structural test</Button></>}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Studio action failed" description={error()} /></Show>
      <ScreenRegion state={detail.state()} onRetry={() => void detail.refresh()} emptyTitle="Draft not found" emptyDescription="The draft may belong to another workspace or no longer exist.">
        <div class="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Section title="Definition editor" description={detail.state().data?.draft.kind === "Workflow" ? "Visual steps are stored under the canonical spec.jobs key. Advanced YAML follows the same restricted grammar." : "The restricted declaration and pinned assets remain immutable once published."} surface="card" density="compact" class="p-3 sm:p-4">
            <Show when={detail.state().data?.draft.kind === "Workflow"}><div class="mb-2 flex flex-wrap gap-1.5"><Button size="sm" variant={mode() === "visual" ? "solid" : "outline"} onClick={() => setMode("visual")}>Visual steps</Button><Button size="sm" variant={mode() === "yaml" ? "solid" : "outline"} onClick={() => setMode("yaml")}>Advanced YAML</Button></div></Show>
            <Show when={mode() === "visual"} fallback={<Textarea label="Restricted YAML" value={content()} onInput={(event) => { setContent(event.currentTarget.value); setDirty(true); }} class="min-h-[28rem] min-w-0 max-w-full font-mono text-caption" />}>
              <div class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1"><For each={steps()}>{(step, index) => <div class="grid min-w-0 gap-2 py-3 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto] lg:items-end">
                <TextInput label="Step id" value={step.id} onInput={(event) => updateStep(index(), "id", event.currentTarget.value)} />
                <Select label="Kind" value={step.kind} options={["dispatch", "gate", "eval", "merge", "subgraph", "steer"].map((value) => ({ value, label: value }))} onValueChange={(value) => updateStep(index(), "kind", value ?? "dispatch")} />
                <TextInput label="Needs (comma separated)" value={step.needs} onInput={(event) => updateStep(index(), "needs", event.currentTarget.value)} />
                <Button size="sm" class="justify-self-start" variant="ghost" theme="red" iconLeft="lucide-x" onClick={() => { setSteps((rows) => rows.filter((_row, position) => position !== index())); setDirty(true); }}>Remove job</Button>
              </div>}</For></div>
              <Show when={!steps().length}><p class="py-3 text-caption text-ink-gray-6">No steps defined. Add a step or use Advanced YAML.</p></Show>
              <Button size="sm" class="mt-2" variant="outline" iconLeft="lucide-plus" onClick={() => { setSteps((rows) => [...rows, { id: `step-${rows.length + 1}`, kind: "dispatch", needs: "", value: {} }]); setDirty(true); }}>Add step</Button>
            </Show>
            <Show when={detail.state().data?.draft.kind === "Agent"}><div class="mt-3 border-t border-outline-gray-1 pt-3"><Textarea label="Versioned instructions (Markdown)" value={instructions()} onInput={(event) => { setInstructions(event.currentTarget.value); setDirty(true); }} class="min-h-64 min-w-0 max-w-full" /><p class="mt-2 text-caption text-ink-gray-6">Attempts keep their pinned instructions and tools. This candidate has no effect until its exact release is activated.</p></div></Show>
            <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-outline-gray-1 pt-3"><Button size="sm" variant="solid" theme="blue" loading={busy()} disabled={busy() || !dirty()} onClick={() => void save()}>Save immutable revision</Button><Show when={dirty()}><Badge size="sm" theme="amber" label="unsaved" /></Show></div>
          </Section>

          <PageStack>
            <Section title="Validation and publication" description="Publication requires a passing current revision and a verified configuration write binding." surface="card" density="compact" class="p-3 sm:p-4">
              <Show when={detail.state().data?.validations[0]}>{(validation) => <div class="mb-2 min-w-0"><Badge size="sm" theme={validation().status === "passed" ? "green" : "red"} label={validation().status} /><ul class="mt-2 flex min-w-0 flex-col gap-1 text-caption"><For each={validation().diagnostics}>{(diagnostic) => <li class={`break-words ${diagnostic.severity === "error" ? "text-ink-red-7" : "text-ink-gray-7"}`}><code>{diagnostic.code}</code>: {diagnostic.message}</li>}</For></ul></div>}</Show>
              <TextInput label="Configuration write binding ID" value={bindingId()} onInput={(event) => setBindingId(event.currentTarget.value)} description="Created and verified under Administration → Integrations" />
              <Button size="sm" class="mt-2 max-w-full" variant="solid" theme="blue" loading={busy()} disabled={busy() || !bindingId().trim() || detail.state().data?.draft.state === "publishing"} onClick={() => void publish()}>Publish and compile commit</Button>
              <Show when={latestPublication()}>{(publication) => <div class="mt-3 flex min-w-0 flex-col items-start gap-2 border-t border-outline-gray-1 pt-3"><Badge size="sm" theme={publication().state === "compiled" ? "green" : publication().state === "failed" ? "red" : "amber"} label={publication().state} /><dl class="grid min-w-0 gap-1 text-caption"><dt class="text-ink-gray-6">Commit</dt><dd class="min-w-0"><code class="break-all text-ink-gray-7">{publication().commitOid}</code></dd><dt class="mt-1 text-ink-gray-6">Release</dt><dd class="min-w-0"><code class="break-all text-ink-gray-7">{publication().releaseDigest}</code></dd></dl><Show when={publication().error}><p class="break-words text-caption text-ink-red-7">{publication().error}</p></Show><Show when={publication().releaseDigest && activeDigest() !== publication().releaseDigest}><Button size="sm" variant="outline" disabled={busy()} onClick={() => void activate()}>Activate this release</Button></Show></div>}</Show>
            </Section>

            <Section title="Impact" surface="card" density="compact" class="p-3 sm:p-4">
              <p class="text-caption text-ink-gray-7">{detail.state().data?.impact.changedDefinitions.length ?? 0} changed definitions · {detail.state().data?.impact.impactedReferences.length ?? 0} impacted references</p>
              <Show when={detail.state().data?.impact.revalidationRequired}><Badge size="sm" theme="amber" label="revalidation required" /></Show>
            </Section>

            <Section title="Diff" surface="card" density="compact" class="p-3 sm:p-4">
              <Show when={detail.state().data?.diff.length} fallback={<p class="text-interface text-ink-gray-7">No changes from the active document set.</p>}>
                <For each={detail.state().data?.diff}>{(entry) => <details class="mb-2 min-w-0 max-w-full overflow-hidden rounded-control border border-outline-gray-2 p-2 last:mb-0"><summary class="cursor-pointer break-all text-base-medium">{entry.path}</summary><pre class="mt-2 max-h-96 min-w-0 max-w-full overflow-auto whitespace-pre text-caption">{entry.unified}</pre></details>}</For>
              </Show>
            </Section>
          </PageStack>
        </div>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
