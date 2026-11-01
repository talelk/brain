import { TaskReview } from "../ui/components/TaskReview";
import { TaskEntry } from "../ui/components/TaskEntry";
import { For, Show, createEffect, createSignal } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Badge, Button, createMediaQuery, TextInput } from "@talelk/newui-atoms";
import { DetailHeader } from "@talelk/newui-organisms";
import { EmptyPreview, FactStrip, QueueRow, WorkspaceSection } from "../ui/components/Domain";
import { PaneLayout } from "@talelk/newui-templates";
import type { AgentCatalogEntry, WorkflowCatalogEntry } from "@brain/contracts";
import { query } from "../data/client";
import { createScopedRead } from "../data/screens";
import { useApp } from "../ui/app-context";
import { ScreenRegion } from "../ui/screen-region";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { DigestValue } from "../ui/components/DigestValue";
import { formatMicroUsd, titleize } from "../ui/format";


export function WorkflowsPage() {
  const app = useApp(); const navigate = useNavigate(); const [searchParams, setSearchParams] = useSearchParams();
  const desktop = createMediaQuery("(min-width: 1024px)");
  const [selected, setSelected] = createSignal(typeof searchParams.selected === "string" ? searchParams.selected : "");
  const read = createScopedRead<WorkflowCatalogEntry[]>({ scope: app.scope,
    load: async (scope, signal) => {
      const view = await query<{ snapshot: { items: WorkflowCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "workflows.list", workspaceId: scope.workspaceId }, signal);
      return { ...view, snapshot: view.snapshot.items };
    }, isEmpty: (items) => !items.length,
  });
  const queryText = () => typeof searchParams.q === "string" ? searchParams.q : "";
  const workflows = () => (read.state().data ?? []).filter((item) => !item.definition.spec.presentation?.system || searchParams.diagnostics === "true").filter((item) => `${item.release.id} ${item.definition.spec.presentation?.title ?? ""} ${item.definition.spec.presentation?.description ?? ""}`.toLowerCase().includes(queryText().toLowerCase()));
  const current = () => workflows().find((item) => item.release.id === selected()) ?? (desktop() ? workflows()[0] : undefined);
  const select = (id: string) => { setSelected(id); setSearchParams({ selected: id || undefined }); };
  const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal("");
  const canConfigure = () => Boolean(app.identity()?.actor.scopes.includes("config:activate"));
  async function author(mode: "edit" | "duplicate") {
    const workflow = current(); if (!workflow || busy()) return;
    setBusy(true); setError("");
    try {
      const title = workflow.definition.spec.presentation?.title ?? titleize(workflow.release.id);
      const receipt = await app.run("configDraft.create", { title: mode === "duplicate" ? `Copy of ${title}` : title, kind: "Workflow", sourceDefinition: { kind: "Workflow", id: workflow.release.id, mode } });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail);
      void navigate(`/studio/Workflow/${encodeURIComponent(receipt.resourceId)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the workflow candidate"); }
    finally { setBusy(false); }
  }
  return <BrainPage title="Start work" description="Choose how to begin, review the exact task and inputs, then follow its authoritative execution." actions={<Show when={canConfigure()}><div class="flex flex-wrap gap-2"><Button size="lg" variant="outline" onClick={() => void navigate("/studio/Workflow")}>Workflow drafts</Button><Button size="lg" variant="outline" disabled={!current() || busy()} onClick={() => void author("duplicate")}>Clone as candidate</Button><Button size="lg" variant="outline" disabled={!current() || busy()} onClick={() => void author("edit")}>Edit as candidate</Button></div></Show>}>
    <Show when={error()}><p role="alert" class="text-ink-red-7">{error()}</p></Show>
    <TaskEntry workflows={read.state().data ?? []} onStarted={(runId) => void navigate(`/jobs/${runId}`)} catalog={<PageStack>
      <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active Workflows" emptyDescription="Compile and activate a release in Settings.">
        <PaneLayout class="brain-list-detail" startSize={38} minStartSize={28} maxStartSize={55} active={current() ? "end" : "start"} start={<WorkspaceSection title="Task catalog" description="Declared outcomes in the active release.">
          <TextInput type="search" label="Find a task" value={queryText()} placeholder="Search purpose or task name…" onInput={(event) => setSearchParams({ q: event.currentTarget.value || undefined, selected: undefined })} />
          <Show when={workflows().length} fallback={<EmptyPreview icon="lucide-search" title="No matching tasks" description="Clear the search to see every outcome in the active release." />}>
            <div class="grid gap-3"><For each={workflows()}>{(workflow) => {
              const title = workflow.definition.spec.presentation?.title ?? titleize(workflow.release.id);
              const description = workflow.definition.spec.presentation?.description ?? "Review the declared inputs and expected result before starting.";
              const external = Object.values(workflow.definition.spec.jobs).some((job) => "effectClass" in job && job.effectClass !== "read");
              return <button type="button" class="brain-selection-card" data-selected={current()?.release.id === workflow.release.id} aria-label={`Start task: ${workflow.release.id}`} onClick={() => select(workflow.release.id)}>
                <span class="flex w-full items-start justify-between gap-3"><span class="text-base-medium text-ink-gray-9">{title}</span><span class="lucide-arrow-up-right size-4 shrink-0 text-ink-gray-6" aria-hidden="true" /></span>
                <span class="text-interface text-ink-gray-6">{description}</span>
                <span class="mt-auto flex flex-wrap gap-2"><Badge variant="outline" theme="gray" label={`${Object.keys(workflow.definition.spec.jobs).length} steps`} /><Badge variant="outline" theme={external ? "amber" : "blue"} label={external ? "Governed effects" : "Analysis / draft"} /></span>
              </button>;
            }}</For></div>
          </Show>
        </WorkspaceSection>} end={<Show when={current()} keyed fallback={<EmptyPreview icon="lucide-play" title="Choose a task to configure" description="Purpose, typed inputs, safety, readiness and the launch action will fill this canvas." />}>{(workflow) => <TaskReview workflow={workflow} onBack={() => select("")} onStarted={(runId) => void navigate(`/jobs/${runId}`)} />}</Show>} />
      </ScreenRegion>
    </PageStack>} />
  </BrainPage>;
}

function AgentDetail(props: { agent: AgentCatalogEntry; onBack: () => void }) {
  const app = useApp(); const navigate = useNavigate();
  const [error, setError] = createSignal(""); const [busy, setBusy] = createSignal(false);
  const spec = () => props.agent.definition.spec;
  const workflows = createScopedRead<WorkflowCatalogEntry[]>({ scope: app.scope, load: async (scope, signal) => {
    const view = await query<{ snapshot: { items: WorkflowCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "workflows.list", workspaceId: scope.workspaceId }, signal);
    return { ...view, snapshot: [...view.snapshot.items] };
  } });
  const related = () => (workflows.state().data ?? []).filter((item) => Object.values(item.definition.spec.jobs).some((job) => job.kind === "dispatch" && job.uses.type === "agent" && job.uses.release.digest === props.agent.release.digest));
  const purpose = () => {
    const paragraphs = props.agent.instructions.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
    return paragraphs.find((part) => !part.startsWith("#"))?.trim()
      || paragraphs[0]?.replace(/^#{1,6}\s+/u, "")
      || "No purpose summary is attached to this definition.";
  };
  async function diagnostic() {
    setBusy(true); setError("");
    try {
      const workflow = related()[0];
      if (!workflow) { void navigate(`/w/${app.workspaceId()}/workflows`); return; }
      const inputs: Record<string, Record<string, unknown>> = { "agent-smoke": { message: "BRAIN_OK" }, "operations-triage": { situation: "Diagnostic: identify missing facts and safe next checks for an idle test environment. Do not execute any actions." }, "support-draft": { title: "Diagnostic ticket", body: "This is a read-only engine diagnostic. Draft a response asking for diagnostic details; do not send anything." } };
      const input = inputs[workflow.release.id];
      if (!input) { void navigate(`/w/${app.workspaceId()}/workflows?selected=${encodeURIComponent(workflow.release.id)}`); return; }
      const receipt = await app.run("workflow.dispatch", { workflow: workflow.release, input });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail);
      void navigate(`/jobs/${receipt.resourceId}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Diagnostic dispatch failed"); } finally { setBusy(false); }
  }
  async function author(mode: "edit" | "duplicate") {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const title = titleize(props.agent.release.id);
      const receipt = await app.run("configDraft.create", { title: mode === "duplicate" ? `Copy of ${title}` : title, kind: "Agent", sourceDefinition: { kind: "Agent", id: props.agent.release.id, mode } });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail);
      void navigate(`/studio/Agent/${encodeURIComponent(receipt.resourceId)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the agent candidate"); }
    finally { setBusy(false); }
  }
  return <PageStack>
    <DetailHeader title={titleize(props.agent.release.id)} headingLevel={2}
      subtitle="Active definition—not an executing agent session. Readiness is rechecked at dispatch and placement."
      actions={[{ label: "Back to Agents", onClick: props.onBack }, ...(app.identity()?.actor.scopes.includes("config:activate") ? [{ label: "Clone", onClick: () => void author("duplicate") }, { label: "Edit candidate", onClick: () => void author("edit") }] : []), { label: busy() ? "Working…" : "Run diagnostic", onClick: () => void diagnostic() }]} />
    <Show when={error()}><p role="alert" class="text-ink-red-7">{error()}</p></Show>
    <FactStrip label="Agent capability summary" items={[
      { label: "Engine requirement", value: spec().engine.anyOf.join(" or "), hint: "One compatible engine is required", icon: "lucide-cpu" },
      { label: "Allowed tools", value: String(spec().tools.length), hint: spec().tools.length ? "Pinned releases only" : "No tool authority", icon: "lucide-wrench" },
      { label: "Turn / token limits", value: `${spec().maxTurns} · ${spec().maxTokens.toLocaleString()}`, hint: "Per attempt", icon: "lucide-gauge" },
      { label: "Maximum cost", value: formatMicroUsd(spec().maxMicroUsd), hint: `${spec().maxChildren} children · depth ${spec().maxDepth}`, icon: "lucide-wallet-cards" },
    ]} />
    <WorkspaceSection title="Purpose and responsibility" description="Derived from the pinned instruction asset; not an inferred model capability."><p class="brain-prose whitespace-pre-wrap text-interface text-ink-gray-8">{purpose()}</p></WorkspaceSection>
    <WorkspaceSection title="Trust and scope" description="This definition has no authority beyond the following pinned tools and limits.">
      <Show when={spec().tools.length} fallback={<p class="text-interface text-ink-gray-7">No tools are allowed. This agent can produce model output only.</p>}><div class="flex flex-wrap gap-2"><For each={spec().tools}>{(tool) => <Badge variant="outline" theme="gray" label={tool.id} />}</For></div></Show>
    </WorkspaceSection>
    <WorkspaceSection title="Related workflows" description="Actual active workflows that dispatch this exact agent release.">
      <Show when={related().length} fallback={<p class="text-interface text-ink-gray-7">No active workflow currently references this agent release.</p>}><div class="brain-queue"><For each={related()}>{(workflow) => <QueueRow title={workflow.definition.spec.presentation?.title ?? titleize(workflow.release.id)} description={workflow.definition.spec.presentation?.description ?? "Declared workflow"} icon="lucide-workflow" onClick={() => void navigate(`/w/${app.workspaceId()}/workflows?selected=${encodeURIComponent(workflow.release.id)}`)} />}</For></div></Show>
    </WorkspaceSection>
    <TechnicalDetails label="Pinned instructions and release"><p class="brain-readable whitespace-pre-wrap text-interface text-ink-gray-8">{props.agent.instructions || "No instruction asset is attached to this Agent."}</p><div class="mt-3"><DigestValue value={props.agent.configDigest} label="Configuration digest" /></div></TechnicalDetails>
  </PageStack>;
}

export function AgentsPage() {
  const app = useApp(); const navigate = useNavigate(); const [searchParams, setSearchParams] = useSearchParams();
  const desktop = createMediaQuery("(min-width: 1024px)");
  const [selected, setSelected] = createSignal(typeof searchParams.selected === "string" ? searchParams.selected : "");
  const read = createScopedRead<AgentCatalogEntry[]>({ scope: app.scope,
    load: async (scope, signal) => {
      const view = await query<{ snapshot: { items: AgentCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "agents.list", workspaceId: scope.workspaceId }, signal);
      return { ...view, snapshot: view.snapshot.items };
    }, isEmpty: (items) => !items.length,
  });
  const current = () => read.state().data?.find((item) => item.release.id === selected()) ?? (desktop() ? read.state().data?.[0] : undefined);
  const select = (id: string) => { setSelected(id); setSearchParams({ selected: id || undefined }); };
  createEffect(() => { if (selected() && read.state().data && !read.state().data?.some((item) => item.release.id === selected())) select(""); });
  return <BrainPage title="Agents" description="Inspect responsibilities, engine requirements, tool authority and release limits before dispatching an agent definition." actions={<Show when={app.identity()?.actor.scopes.includes("config:activate")}><div class="flex flex-wrap gap-2"><Button size="lg" variant="outline" onClick={() => void navigate("/studio/Agent")}>Agent drafts</Button><Button size="lg" theme="blue" iconLeft="lucide-plus" onClick={() => void navigate("/studio/Agent")}>Propose new agent</Button></div></Show>}>
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active Agents" emptyDescription="Activate the complete starter release in Settings.">
      <PaneLayout class="brain-list-detail" startSize={40} minStartSize={30} maxStartSize={58} active={current() ? "end" : "start"} start={<WorkspaceSection title="Capability catalog" description="Definitions in the active release. An active definition is not a running session.">
        <div class="grid gap-3"><For each={read.state().data ?? []}>{(agent) => <button type="button" class="brain-selection-card" data-selected={current()?.release.id === agent.release.id} onClick={() => select(agent.release.id)}>
          <span class="flex w-full items-start justify-between gap-2"><span class="text-base-medium">{titleize(agent.release.id)}</span><Badge variant="outline" theme="blue" label="Definition" /></span>
          <span class="line-clamp-3 text-interface text-ink-gray-6">{agent.instructions.split(/\n\s*\n/u)[0] || "No purpose summary provided."}</span>
          <span class="mt-auto flex flex-wrap gap-2"><Badge variant="outline" theme="gray" label={agent.definition.spec.engine.anyOf.join(" / ")} /><Badge variant="outline" theme={agent.definition.spec.tools.length ? "amber" : "blue"} label={`${agent.definition.spec.tools.length} tools`} /></span>
        </button>}</For></div>
      </WorkspaceSection>} end={<Show when={current()} keyed fallback={<EmptyPreview icon="lucide-bot" title="Select an agent definition" description="Its purpose, inputs and outputs through related workflows, engine requirements, tools and limitations will appear here." />}>{(agent) => <AgentDetail agent={agent} onBack={() => select("")} />}</Show>} />
    </ScreenRegion>
  </BrainPage>;
}
