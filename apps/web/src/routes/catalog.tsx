import { TaskReview } from "../ui/components/TaskReview";
import type { TaskHandoff } from "../ui/components/TaskReview";
import { TaskEntry } from "../ui/components/TaskEntry";
import { For, Show, createEffect, createSignal } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Badge, Button, createMediaQuery, TextInput } from "@talelk/newui-atoms";
import { DetailHeader } from "@talelk/newui-organisms";
import { EmptyPreview, FactStrip, QueueRow, WorkspaceSection } from "../ui/components/Domain";
import { LIST_PAGE_SIZE as PAGE_SIZE, Pager } from "../ui/components/primitives";
import { PaneLayout } from "@talelk/newui-templates";
import type { AgentCatalogEntry, WorkflowCatalogEntry } from "@brain/contracts";
import { query } from "../data/client";
import { createScopedRead } from "../data/screens";
import { useApp } from "../ui/app-context";
import { ScreenRegion } from "../ui/screen-region";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { ActionFeedback } from "../ui/components/ActionFeedback";
import { DigestValue } from "../ui/components/DigestValue";
import { formatMicroUsd, titleize } from "../ui/format";

/** First paragraph of a long text, heading-stripped and hard-truncated so list rows stay scannable. */
function summary(text: string | undefined, fallback: string, max = 160): string {
  const first = (text ?? "").split(/\n\s*\n/u)[0]?.replace(/^#{1,6}\s+/u, "").trim() ?? "";
  if (!first) return fallback;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** Agent releases a published recipe dispatches — derived from the pinned definition, never invented. */
function recipeAgents(workflow: WorkflowCatalogEntry): string[] {
  const agents = new Set<string>();
  for (const job of Object.values(workflow.definition.spec.jobs)) {
    if (job.kind === "dispatch" && job.uses.type === "agent") agents.add(job.uses.release.id);
  }
  return [...agents];
}

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
  const [workflowPage, setWorkflowPage] = createSignal(1);
  const workflowPageSafe = () => Math.min(workflowPage(), Math.max(1, Math.ceil(workflows().length / PAGE_SIZE)));
  const pagedWorkflows = () => workflows().slice((workflowPageSafe() - 1) * PAGE_SIZE, workflowPageSafe() * PAGE_SIZE);
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
  /** Dispatch handoff: the live console when the run already binds a session, else the run inspector. */
  const handoff = (target: TaskHandoff) => {
    if (target.sessionId) void navigate(`/w/${app.workspaceId()}/live?session=${encodeURIComponent(target.sessionId)}`);
    else void navigate(`/jobs/${target.runId}`);
  };
  return <BrainPage title="Start work" description="Pick or describe the work, choose a published recipe, review the exact inputs, then dispatch." actions={<Show when={canConfigure()}><div class="flex flex-wrap gap-2"><Button size="lg" variant="outline" iconLeft="lucide-file-pen" onClick={() => void navigate("/studio/Workflow")}>Workflow drafts</Button><Button size="lg" variant="outline" iconLeft="lucide-copy" disabled={!current() || busy()} onClick={() => void author("duplicate")}>Clone as candidate</Button><Button size="lg" variant="outline" iconLeft="lucide-square-pen" disabled={!current() || busy()} onClick={() => void author("edit")}>Edit as candidate</Button></div></Show>}>
    <ActionFeedback tone="error" message={error()} />
    <TaskEntry workflows={read.state().data ?? []} onStarted={handoff} catalog={<PageStack>
      <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No published recipes" emptyDescription="Compile and activate a release in Settings; published recipes appear here.">
        <PaneLayout class="brain-list-detail" startSize={38} minStartSize={28} maxStartSize={55} active={current() ? "end" : "start"} start={<WorkspaceSection title="Task catalog" description="Published recipes in the active release. Each row is a real published definition.">
          <TextInput type="search" label="Find a task" value={queryText()} placeholder="Search purpose or task name…" onInput={(event) => { setSearchParams({ q: event.currentTarget.value || undefined, selected: undefined }); setWorkflowPage(1); }} />
          <Show when={workflows().length} fallback={<EmptyPreview icon="lucide-search" title="No matching tasks" description="Clear the search to see every outcome in the active release." />}>
            <div class="brain-queue"><For each={pagedWorkflows()}>{(workflow) => {
              const title = workflow.definition.spec.presentation?.title ?? titleize(workflow.release.id);
              const description = summary(workflow.definition.spec.presentation?.description, "Review the declared inputs and expected result before starting.");
              const external = Object.values(workflow.definition.spec.jobs).some((job) => "effectClass" in job && job.effectClass !== "read");
              const agents = recipeAgents(workflow);
              return <QueueRow title={title} description={description} icon="lucide-workflow" tone={external ? "amber" : "blue"}
                label={`Start task: ${workflow.release.id}`}
                meta={<><Badge variant="outline" theme="gray" label={`${Object.keys(workflow.definition.spec.jobs).length} steps`} /><Badge variant="outline" theme={external ? "amber" : "blue"} label={external ? "Governed effects" : "Analysis / draft"} /><For each={agents}>{(agent) => <Badge variant="outline" theme="gray" label={`Runs ${titleize(agent)}`} />}</For></>}
                selected={current()?.release.id === workflow.release.id} onClick={() => select(workflow.release.id)} />;
            }}</For></div>
            <Pager count={workflows().length} page={workflowPageSafe()} onPage={setWorkflowPage} label="Task catalog pages" />
          </Show>
        </WorkspaceSection>} end={<Show when={current()} keyed fallback={<EmptyPreview icon="lucide-play" title="Choose a recipe to configure" description="Purpose, typed inputs, safety, readiness and the dispatch action will fill this canvas." />}>{(workflow) => <TaskReview workflow={workflow} onBack={() => select("")} onStarted={handoff} />}</Show>} />
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
  // Dispatch always goes through a published recipe: the guided flow collects
  // schema-validated inputs and dispatches with your review. No fabricated
  // per-release diagnostic inputs here.
  const startRecipe = () => {
    const recipe = related()[0]; if (!recipe) return;
    void navigate(`/w/${app.workspaceId()}/workflows?mode=catalog&selected=${encodeURIComponent(recipe.release.id)}`);
  };
  return <PageStack>
    <DetailHeader title={titleize(props.agent.release.id)} headingLevel={2}
      subtitle="Active definition—not an executing agent session. Readiness is rechecked at dispatch and placement."
      actions={[{ label: "Back to Agents", onClick: props.onBack }, ...(app.identity()?.actor.scopes.includes("config:activate") ? [{ label: "Clone", onClick: () => void author("duplicate") }, { label: "Edit candidate", onClick: () => void author("edit") }] : []), ...(related()[0] ? [{ label: "Start a task", onClick: startRecipe }] : [])]} />
    <ActionFeedback tone="error" message={error()} />
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
    <WorkspaceSection title="Published recipes" description="Actual published workflows that dispatch this exact agent release; start one to configure and dispatch with review.">
      <Show when={related().length} fallback={<p class="text-interface text-ink-gray-7">No published recipe currently dispatches this agent release. Agents run through recipes, not directly.</p>}><div class="brain-queue"><For each={related()}>{(workflow) => <QueueRow title={workflow.definition.spec.presentation?.title ?? titleize(workflow.release.id)} description={workflow.definition.spec.presentation?.description ?? "Declared workflow"} icon="lucide-workflow" label={`Start task: ${workflow.release.id}`} onClick={() => void navigate(`/w/${app.workspaceId()}/workflows?mode=catalog&selected=${encodeURIComponent(workflow.release.id)}`)} />}</For></div></Show>
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
  const [agentPage, setAgentPage] = createSignal(1);
  const agents = () => read.state().data ?? [];
  const agentPageSafe = () => Math.min(agentPage(), Math.max(1, Math.ceil(agents().length / PAGE_SIZE)));
  const pagedAgents = () => agents().slice((agentPageSafe() - 1) * PAGE_SIZE, agentPageSafe() * PAGE_SIZE);
  createEffect(() => { if (selected() && read.state().data && !read.state().data?.some((item) => item.release.id === selected())) select(""); });
  return <BrainPage title="Agents" description="Inspect responsibilities, engine requirements, tool authority and release limits before dispatching an agent definition." actions={<Show when={app.identity()?.actor.scopes.includes("config:activate")}><div class="flex flex-wrap gap-2"><Button size="lg" variant="outline" iconLeft="lucide-file-pen" onClick={() => void navigate("/studio/Agent")}>Agent drafts</Button><Button size="lg" theme="blue" iconLeft="lucide-plus" onClick={() => void navigate("/studio/Agent")}>Propose new agent</Button></div></Show>}>
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active Agents" emptyDescription="Activate the complete starter release in Settings.">
      <PaneLayout class="brain-list-detail" startSize={40} minStartSize={30} maxStartSize={58} active={current() ? "end" : "start"} start={<WorkspaceSection title="Capability catalog" description="Definitions in the active release. An active definition is not a running session.">
        <Show when={agents().length} fallback={<EmptyPreview icon="lucide-bot" title="No agent definitions" description="Activated agent definitions appear here; propose a draft to create the first one." />}>
          <div class="brain-queue"><For each={pagedAgents()}>{(agent) => <QueueRow
            title={titleize(agent.release.id)}
            description={summary(agent.instructions, "No purpose summary provided.")}
            icon="lucide-bot" tone="blue"
            meta={<><Badge variant="outline" theme="gray" label={agent.definition.spec.engine.anyOf.join(" / ")} /><Badge variant="outline" theme={agent.definition.spec.tools.length ? "amber" : "blue"} label={`${agent.definition.spec.tools.length} tools`} /></>}
            trailing={<Badge variant="outline" theme="blue" label="Definition" />}
            selected={current()?.release.id === agent.release.id} onClick={() => select(agent.release.id)} />}</For></div>
          <Pager count={agents().length} page={agentPageSafe()} onPage={setAgentPage} label="Agent catalog pages" />
        </Show>
      </WorkspaceSection>} end={<Show when={current()} keyed fallback={<EmptyPreview icon="lucide-bot" title="Select an agent definition" description="Its purpose, inputs and outputs through related workflows, engine requirements, tools and limitations will appear here." />}>{(agent) => <AgentDetail agent={agent} onBack={() => select("")} />}</Show>} />
    </ScreenRegion>
  </BrainPage>;
}
