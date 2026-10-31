import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { parse, stringify } from "yaml";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import type { ConfigurationDraft, DocumentDiff, DraftImpact, DraftRevision, PublicationProposal, ValidationRun } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { governor, query } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { BrainPage, PageStack } from "../components/PageLayout";

interface DraftDetails {
  draft: ConfigurationDraft;
  revisions: DraftRevision[];
  validations: ValidationRun[];
  publications: PublicationProposal[];
  diff: DocumentDiff[];
  impact: DraftImpact;
}
interface ReleaseSummary { digest: string; active: boolean }
interface JobRow { id: string; kind: string; needs: string; value: Record<string, unknown> }

export function StudioListPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const kind = () => params.kind ?? "Workflow";
  const [title, setTitle] = createSignal("");
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

  async function create(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const created = await app.run("configDraft.create", { title: title().trim(), kind: kind() });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      navigate(`/studio/${encodeURIComponent(kind())}/${encodeURIComponent(created.resourceId)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Draft creation failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title={`${kind()} Studio`} description="Create immutable configuration revisions, validate them and publish exact Git commits without editing the active release.">
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Draft creation failed" description={error()} /></Show>
      <Section title="New draft" description="Start with a visual Workflow draft or edit the restricted YAML afterward." surface="card">
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-64 flex-1"><TextInput label="Definition title" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Operations workflow" /></div>
          <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !title().trim()} onClick={() => void create()}>Create draft</Button>
        </div>
      </Section>
      <Section title="Drafts" surface="card">
        <ScreenRegion state={drafts.state()} onRetry={() => void drafts.refresh()} emptyTitle="No configuration drafts" emptyDescription="Create a draft to start an immutable authoring and publication pipeline.">
          <div class="flex flex-col gap-2"><For each={drafts.state().data?.items}>{(draft) => <a class="rounded-control border border-outline-gray-2 p-3 focus-visible:focus-ring" href={`/studio/${encodeURIComponent(draft.kind)}/${encodeURIComponent(draft.draftId)}`}>
            <div class="flex flex-wrap items-center justify-between gap-2"><strong>{draft.title}</strong><Badge theme={draft.state === "published" ? "green" : draft.state === "invalid" || draft.state === "failed" ? "red" : "amber"} label={draft.state} /></div>
            <span class="text-caption text-ink-gray-6">{draft.kind} · revision record v{draft.version}</span>
          </a>}</For></div>
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
  const [jobs, setJobs] = createSignal<JobRow[]>([]);
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
    setBindingId(detail.state().data?.draft.bindingId ?? "");
    try {
      const value = parse(document.text) as { spec?: { jobs?: Record<string, Record<string, unknown>> } };
      setJobs(Object.entries(value.spec?.jobs ?? {}).map(([id, job]) => ({ id, kind: String(job["kind"] ?? "dispatch"), needs: Array.isArray(job["needs"]) ? job["needs"].join(", ") : "", value: job })));
    } catch { setJobs([]); }
  });

  function updateJob(index: number, field: "id" | "kind" | "needs", value: string): void {
    setDirty(true);
    setJobs((rows) => rows.map((row, position) => position === index ? { ...row, [field]: value } : row));
  }

  function applyJobs(): void {
    const value = parse(content()) as { spec?: { jobs?: Record<string, Record<string, unknown>> } };
    value.spec ??= {};
    value.spec.jobs = Object.fromEntries(jobs().map((row) => [row.id, { ...row.value, kind: row.kind, needs: row.needs.split(",").map((need) => need.trim()).filter(Boolean) }]));
    setContent(stringify(value));
    setDirty(true);
  }

  async function save(): Promise<void> {
    const draft = detail.state().data?.draft;
    if (!draft || busy()) return;
    setBusy(true); setError("");
    try {
      if (mode() === "visual") applyJobs();
      const updated = await app.run("configDraft.update", {
        draftId: draft.draftId, source: mode(), documents: [{ path: current()!.documents[0]!.path, text: content() }, ...current()!.documents.slice(1)],
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
    actions={<><Button size="lg" variant="outline" disabled={busy()} onClick={() => void run("validate")}>Validate</Button><Button size="lg" variant="outline" disabled={busy()} onClick={() => void run("test")}>Run structural test</Button></>}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Studio action failed" description={error()} /></Show>
      <ScreenRegion state={detail.state()} onRetry={() => void detail.refresh()} emptyTitle="Draft not found" emptyDescription="The draft may belong to another workspace or no longer exist.">
        <div class="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Section title="Definition editor" description="Visual jobs use canonical spec.jobs. Advanced YAML follows the same restricted grammar." surface="card">
            <div class="mb-3 flex flex-wrap gap-2"><Button size="sm" variant={mode() === "visual" ? "solid" : "outline"} onClick={() => setMode("visual")}>Visual jobs</Button><Button size="sm" variant={mode() === "yaml" ? "solid" : "outline"} onClick={() => setMode("yaml")}>Advanced YAML</Button></div>
            <Show when={mode() === "visual"} fallback={<Textarea label="Restricted YAML" value={content()} onInput={(event) => { setContent(event.currentTarget.value); setDirty(true); }} class="min-h-[32rem] font-mono" />}>
              <div class="flex flex-col gap-3"><For each={jobs()}>{(job, index) => <div class="grid gap-3 rounded-card border border-outline-gray-2 p-3 lg:grid-cols-3">
                <TextInput label="Job id" value={job.id} onInput={(event) => updateJob(index(), "id", event.currentTarget.value)} />
                <Select label="Kind" value={job.kind} options={["dispatch", "gate", "eval", "merge", "subgraph", "steer"].map((value) => ({ value, label: value }))} onValueChange={(value) => updateJob(index(), "kind", value ?? "dispatch")} />
                <TextInput label="Needs (comma separated)" value={job.needs} onInput={(event) => updateJob(index(), "needs", event.currentTarget.value)} />
                <div class="lg:col-span-3"><Button size="sm" variant="ghost" theme="red" onClick={() => { setJobs((rows) => rows.filter((_row, position) => position !== index())); setDirty(true); }}>Remove job</Button></div>
              </div>}</For></div>
              <Button size="sm" variant="outline" onClick={() => { setJobs((rows) => [...rows, { id: `job-${rows.length + 1}`, kind: "dispatch", needs: "", value: {} }]); setDirty(true); }}>Add job</Button>
            </Show>
            <div class="mt-3 flex flex-wrap gap-2"><Button size="lg" theme="blue" loading={busy()} disabled={busy() || !dirty()} onClick={() => void save()}>Save immutable revision</Button><Show when={dirty()}><Badge theme="amber" label="unsaved" /></Show></div>
          </Section>

          <PageStack>
            <Section title="Validation and publication" description="Publication requires a passing current revision and a verified configuration write binding." surface="card">
              <Show when={detail.state().data?.validations[0]}>{(validation) => <div class="mb-3"><Badge theme={validation().status === "passed" ? "green" : "red"} label={validation().status} /><ul class="mt-2 flex flex-col gap-1 text-caption"><For each={validation().diagnostics}>{(diagnostic) => <li class={diagnostic.severity === "error" ? "text-ink-red-7" : "text-ink-gray-7"}>{diagnostic.code}: {diagnostic.message}</li>}</For></ul></div>}</Show>
              <TextInput label="Configuration write binding ID" value={bindingId()} onInput={(event) => setBindingId(event.currentTarget.value)} description="Created and verified under Administration → Integrations" />
              <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !bindingId().trim() || detail.state().data?.draft.state === "publishing"} onClick={() => void publish()}>Publish and compile commit</Button>
              <Show when={latestPublication()}>{(publication) => <div class="mt-3 flex flex-col gap-2"><Badge theme={publication().state === "compiled" ? "green" : publication().state === "failed" ? "red" : "amber"} label={publication().state} /><p class="break-all text-caption text-ink-gray-6">commit {publication().commitOid}<br />release {publication().releaseDigest}</p><Show when={publication().error}><p class="text-caption text-ink-red-7">{publication().error}</p></Show><Show when={publication().releaseDigest && activeDigest() !== publication().releaseDigest}><Button size="lg" variant="outline" disabled={busy()} onClick={() => void activate()}>Activate this release</Button></Show></div>}</Show>
            </Section>

            <Section title="Impact" surface="card">
              <p class="text-caption text-ink-gray-7">{detail.state().data?.impact.changedDefinitions.length ?? 0} changed definitions · {detail.state().data?.impact.impactedReferences.length ?? 0} impacted references</p>
              <Show when={detail.state().data?.impact.revalidationRequired}><Badge theme="amber" label="revalidation required" /></Show>
            </Section>

            <Section title="Diff" surface="card">
              <Show when={detail.state().data?.diff.length} fallback={<p class="text-ink-gray-7">No changes from the active document set.</p>}>
                <For each={detail.state().data?.diff}>{(entry) => <details class="mb-2 rounded-control border border-outline-gray-2 p-2"><summary class="cursor-pointer text-base-medium">{entry.path}</summary><pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-caption">{entry.unified}</pre></details>}</For>
              </Show>
            </Section>
          </PageStack>
        </div>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
