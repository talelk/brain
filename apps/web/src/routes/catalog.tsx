import { TaskReview } from "../ui/components/TaskReview";
import { TaskEntry } from "../ui/components/TaskEntry";
import { Show, createEffect, createSignal } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { DetailHeader, Section } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { AgentCatalogEntry, WorkflowCatalogEntry } from "@brain/contracts";
import { query } from "../data/client";
import { createScopedRead } from "../data/screens";
import { useApp } from "../ui/app-context";
import { ScreenRegion } from "../ui/screen-region";
import { BrainPage, KeyValueGrid, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { RecordCollection } from "../ui/components/RecordCollection";
import { DigestValue } from "../ui/components/DigestValue";
import { formatMicroUsd, titleize } from "../ui/format";


export function WorkflowsPage() {
  const app = useApp(); const navigate = useNavigate(); const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = createSignal(typeof searchParams.selected === "string" ? searchParams.selected : "");
  const read = createScopedRead<WorkflowCatalogEntry[]>({ scope: app.scope,
    load: async (scope, signal) => {
      const view = await query<{ snapshot: { items: WorkflowCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "workflows.list", workspaceId: scope.workspaceId }, signal);
      return { ...view, snapshot: view.snapshot.items };
    }, isEmpty: (items) => !items.length,
  });
  const current = () => read.state().data?.find((item) => item.release.id === selected());
  const select = (id: string) => { setSelected(id); setSearchParams({ selected: id || undefined }); };
  return <BrainPage title="Start work" description="Choose a declared outcome, provide its validated inputs, and follow the run through independent verification.">
    <TaskEntry workflows={read.state().data ?? []} onStarted={(runId) => void navigate(`/jobs/${runId}`)} catalog={<PageStack>
      <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active Workflows" emptyDescription="Compile and activate a release in Settings.">
        <PaneLayout active={current() ? "end" : "start"} start={<Section title="Choose a task" description="Outcomes available in the active release." surface="card">
          <RecordCollection title="Workflows" rows={(read.state().data ?? []).filter((item) => !item.definition.spec.presentation?.system || searchParams.diagnostics === "true").map((item) => ({ id: item.release.id, name: item.definition.spec.presentation?.title ?? titleize(item.release.id), jobs: String(Object.keys(item.definition.spec.jobs).length) }))}
            columns={[{ id: "name", header: "Workflow", accessorKey: "name", meta: { mobile: "title" } }, { id: "jobs", header: "Steps", accessorKey: "jobs", meta: { mobile: "meta" } }]} onOpen={select} openLabel="Start task" />
        </Section>} end={<Show when={current()} keyed fallback={<p class="text-interface text-ink-gray-7">Choose a task to see what it produces and enter your inputs.</p>}>{(workflow) => <TaskReview workflow={workflow} onBack={() => select("")} onStarted={(runId) => void navigate(`/jobs/${runId}`)} />}</Show>} />
      </ScreenRegion>
    </PageStack>} />
  </BrainPage>;
}

function AgentDetail(props: { agent: AgentCatalogEntry; onBack: () => void }) {
  const app = useApp(); const navigate = useNavigate();
  const [error, setError] = createSignal(""); const [busy, setBusy] = createSignal(false);
  const spec = () => props.agent.definition.spec;
  async function diagnostic() {
    setBusy(true); setError("");
    try {
      const view = await query<{ snapshot: { items: WorkflowCatalogEntry[] } }>({ queryType: "workflows.list", workspaceId: app.workspaceId() });
      const workflow = view.snapshot.items.find((item) => Object.values(item.definition.spec.jobs).some((job) => job.kind === "dispatch" && job.uses.type === "agent" && job.uses.release.digest === props.agent.release.digest));
      if (!workflow) { void navigate(`/w/${app.workspaceId()}/workflows`); return; }
      const inputs: Record<string, Record<string, unknown>> = { "agent-smoke": { message: "BRAIN_OK" }, "operations-triage": { situation: "Diagnostic: identify missing facts and safe next checks for an idle test environment. Do not execute any actions." }, "support-draft": { title: "Diagnostic ticket", body: "This is a read-only engine diagnostic. Draft a response asking for diagnostic details; do not send anything." } };
      const input = inputs[workflow.release.id];
      if (!input) { void navigate(`/w/${app.workspaceId()}/workflows?selected=${encodeURIComponent(workflow.release.id)}`); return; }
      const receipt = await app.run("workflow.dispatch", { workflow: workflow.release, input });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail);
      void navigate(`/jobs/${receipt.resourceId}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Diagnostic dispatch failed"); } finally { setBusy(false); }
  }
  return <PageStack>
    <DetailHeader title={titleize(props.agent.release.id)} headingLevel={2}
      subtitle="Instructions, engine requirements, and the exact authority available to this Agent."
      actions={[{ label: "Back to Agents", onClick: props.onBack }, { label: busy() ? "Running…" : "Run diagnostic", onClick: () => void diagnostic() }]} />
    <Show when={error()}><p role="alert" class="text-ink-red-7">{error()}</p></Show>
    <Section title="Capabilities and limits" surface="card"><KeyValueGrid items={[
      { label: "Engines", value: spec().engine.anyOf.join(", ") },
      { label: "Allowed tools", value: spec().tools.map((tool) => tool.id).join(", ") || "None" },
      { label: "Turns / tokens", value: `${spec().maxTurns} turns · ${spec().maxTokens.toLocaleString()} tokens` },
      { label: "Cost / delegation", value: `${formatMicroUsd(spec().maxMicroUsd)} · ${spec().maxChildren} children · depth ${spec().maxDepth}` },
    ]} /></Section>
    <Section title="Pinned instructions" surface="card"><p class="brain-readable whitespace-pre-wrap text-interface text-ink-gray-8">{props.agent.instructions || "No instruction asset is attached to this Agent."}</p></Section>
    <TechnicalDetails label="Configuration digest"><DigestValue value={props.agent.configDigest} label="Configuration digest" /></TechnicalDetails>
  </PageStack>;
}

export function AgentsPage() {
  const app = useApp(); const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = createSignal(typeof searchParams.selected === "string" ? searchParams.selected : "");
  const read = createScopedRead<AgentCatalogEntry[]>({ scope: app.scope,
    load: async (scope, signal) => {
      const view = await query<{ snapshot: { items: AgentCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "agents.list", workspaceId: scope.workspaceId }, signal);
      return { ...view, snapshot: view.snapshot.items };
    }, isEmpty: (items) => !items.length,
  });
  const current = () => read.state().data?.find((item) => item.release.id === selected());
  const select = (id: string) => { setSelected(id); setSearchParams({ selected: id || undefined }); };
  createEffect(() => { if (selected() && read.state().data && !current()) select(""); });
  return <BrainPage title="Agents" description="Inspect what each model can do, which tools are pinned, and the limits every attempt must obey.">
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active Agents" emptyDescription="Activate the complete starter release in Settings.">
      <PaneLayout active={current() ? "end" : "start"} start={<Section title="Active Agents" surface="card">
        <RecordCollection title="Agents" rows={(read.state().data ?? []).map((item) => ({ id: item.release.id, name: titleize(item.release.id), engines: item.definition.spec.engine.anyOf.join(", ") }))}
          columns={[{ id: "name", header: "Agent", accessorKey: "name", meta: { mobile: "title" } }, { id: "engines", header: "Engines", accessorKey: "engines", meta: { mobile: "meta" } }]} onOpen={select} openLabel="Inspect" />
      </Section>} end={<Show when={current()} keyed fallback={<p class="text-interface text-ink-gray-7">Select an Agent to inspect its instructions and limits.</p>}>{(agent) => <AgentDetail agent={agent} onBack={() => select("")} />}</Show>} />
    </ScreenRegion>
  </BrainPage>;
}
