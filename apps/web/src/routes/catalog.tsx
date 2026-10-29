import { For, Show, createEffect, createSignal } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { toast } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { AgentCatalogEntry, OperationalReadiness, WorkflowCatalogEntry } from "@brain/contracts";
import { commandStatusQuery } from "../data/governor";
import { governor, GovernorError, query } from "../data/client";
import { createScopedRead } from "../data/screens";
import { useApp } from "../ui/app-context";
import { ScreenRegion } from "../ui/screen-region";
import { PageIntro, KeyValueGrid } from "../ui/components/PageLayout";
import { RecordCollection } from "../ui/components/RecordCollection";
import { DigestValue } from "../ui/components/DigestValue";
import { SchemaForm } from "../ui/components/SchemaForm";
import type { InputSchema } from "../ui/components/SchemaForm";

const name = (value: string) => value.replaceAll("-", " ").replace(/^./u, (letter) => letter.toUpperCase());

export function OperationalChecklist() {
  const app = useApp();
  const navigate = useNavigate();
  const check = createScopedRead<OperationalReadiness>({ scope: app.scope,
    load: async (scope, signal) => {
      const snapshot = await governor<OperationalReadiness>(`/v1/doctor?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
      return { snapshot, asOf: snapshot.asOf, sourceWatermark: 0 };
    }, refreshMs: 15000,
  });
  const action = (id: string) => id.includes("runner") || id.includes("engine") ? "/runners" : id.includes("release") || id.includes("config") ? "/settings?tab=release" : `/w/${app.workspaceId()}/overview`;
  return <Section title="Setup checklist" description="Each check leads to the place where you can resolve it." surface="card">
    <ScreenRegion state={check.state()} onRetry={() => void check.refresh()} emptyTitle="Readiness unavailable" emptyDescription="Select an accessible workspace.">
      <For each={check.state().data?.checks}>{(item) => <div class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-3 last:border-0">
        <div class="min-w-0 max-w-2xl"><strong>{name(item.id)}</strong><p class="text-base text-ink-gray-7">{item.detail}</p><p class="text-caption text-ink-gray-6">{item.nextAction}</p></div>
        <Button variant="outline" class="min-h-11" onClick={() => void navigate(action(item.id))}>{item.status === "ready" ? "Inspect" : "Resolve"}</Button>
      </div>}</For>
    </ScreenRegion>
  </Section>;
}

function WorkflowDetail(props: { workflow: WorkflowCatalogEntry; onBack: () => void; onDispatched: (runId: string) => void }) {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [uncertain, setUncertain] = createSignal(false);
  const [commandId, setCommandId] = createSignal(`web-${crypto.randomUUID()}`);
  const [idempotencyKey, setIdempotencyKey] = createSignal(`web-${crypto.randomUUID()}`);
  const jobs = () => Object.entries(props.workflow.definition.spec.jobs);
  function resetCommand() {
    if (busy()) return;
    setCommandId(`web-${crypto.randomUUID()}`); setIdempotencyKey(`web-${crypto.randomUUID()}`); setUncertain(false); setError("");
  }
  async function dispatch(input: Record<string, unknown>) {
    if (busy()) return;
    setBusy(true); setError("");
    const exactCommand = commandId();
    try {
      const receipt = await app.run("workflow.dispatch", { workflow: props.workflow.release, input }, { commandId: exactCommand, idempotencyKey: idempotencyKey() });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail);
      toast.success({ title: "Workflow accepted", description: "The durable run is ready to inspect." });
      props.onDispatched(receipt.resourceId);
    } catch (reason) {
      if (!(reason instanceof GovernorError) || reason.status >= 500) {
        try {
          const status = await commandStatusQuery(exactCommand);
          if (status.snapshot.receipt.accepted && status.snapshot.receipt.resourceId) { props.onDispatched(status.snapshot.receipt.resourceId); return; }
        } catch { /* The original identifiers remain available for the next explicit retry. */ }
        setUncertain(true);
        setError("Acceptance could not be confirmed. Retry only this exact dispatch; its command and idempotency identifiers are preserved.");
      } else setError(reason.message);
    } finally { setBusy(false); }
  }
  return <div class="brain-detail-stack">
    <PageIntro title={name(props.workflow.release.id)} description="Review the execution plan and inputs before creating a durable run."
      actions={<Button variant="ghost" class="min-h-11" onClick={props.onBack}>Back to Workflows</Button>} />
    <Section title="Execution plan" surface="card">
      <div class="flex flex-col gap-3"><For each={jobs()}>{([id, job], index) => <article class="rounded-card border border-outline-gray-1 p-3">
        <div class="flex flex-wrap items-center gap-2"><span class="text-caption text-ink-gray-6">Step {index() + 1}</span><h3 class="text-base-medium">{name(id)}</h3></div>
        <p class="mt-1 text-base text-ink-gray-7">{job.kind} · depends on {job.needs.length ? job.needs.map(name).join(", ") : "workflow input"}{"runsOn" in job ? ` · runner group ${job.runsOn.group}` : ""}</p>
      </article>}</For></div>
      <details class="mt-4"><summary class="cursor-pointer text-base-medium">Expected output schema</summary><pre class="brain-readable whitespace-pre-wrap pt-2 text-caption">{JSON.stringify(props.workflow.outputSchema, null, 2)}</pre></details>
    </Section>
    <Section title="Dispatch inputs" description="Values stay in this form if validation or the network fails." surface="card">
      <KeyValue label="Immutable release" value={<DigestValue value={props.workflow.configDigest} label="Configuration digest" />} orientation="vertical" />
      <SchemaForm schema={(props.workflow.inputSchema ?? {}) as InputSchema} schemaKey={props.workflow.release.digest}
        submitLabel={uncertain() ? "Retry same dispatch" : `Dispatch ${name(props.workflow.release.id)}`}
        busy={busy()} disabled={!app.canDispatch()} error={error()} onChange={resetCommand} onSubmit={dispatch} />
      <Show when={!app.canDispatch()}><p class="text-caption text-ink-gray-6">Your current role can inspect this Workflow but cannot dispatch it.</p></Show>
    </Section>
  </div>;
}

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
  return <div class="brain-detail-stack"><PageIntro title="Workflow catalog" description="Declared execution plans, their requirements and a recoverable dispatch path." />
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active Workflows" emptyDescription="Compile and activate a release in Settings.">
      <PaneLayout active={current() ? "end" : "start"} start={<Section title="Active Workflows" surface="card">
        <RecordCollection title="Workflows" rows={(read.state().data ?? []).map((item) => ({ id: item.release.id, name: name(item.release.id), jobs: String(Object.keys(item.definition.spec.jobs).length) }))}
          columns={[{ id: "name", header: "Workflow", accessorKey: "name" }, { id: "jobs", header: "Steps", accessorKey: "jobs" }]} onOpen={select} openLabel="Inspect" />
      </Section>} end={<Show when={current()} keyed fallback={<p>Select a Workflow to inspect and dispatch.</p>}>{(workflow) => <WorkflowDetail workflow={workflow} onBack={() => select("")} onDispatched={(runId) => void navigate(`/jobs/${runId}`)} />}</Show>} />
    </ScreenRegion>
  </div>;
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
  return <div class="brain-detail-stack">
    <PageIntro title={name(props.agent.release.id)} description="Instructions, engine requirements and the exact authority available to this Agent."
      actions={<><Button variant="ghost" class="min-h-11" onClick={props.onBack}>Back to Agents</Button><Button class="min-h-11" disabled={!app.canDispatch() || busy()} loading={busy()} onClick={() => void diagnostic()}>Run diagnostic</Button></>} />
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Section title="Capabilities and limits" surface="card"><KeyValueGrid items={[
      { label: "Engines", value: spec().engine.anyOf.join(", ") },
      { label: "Allowed tools", value: spec().tools.map((tool) => tool.id).join(", ") || "None" },
      { label: "Turns / tokens", value: `${spec().maxTurns} turns · ${spec().maxTokens.toLocaleString()} tokens` },
      { label: "Cost / delegation", value: `${spec().maxMicroUsd.toLocaleString()} microUSD · ${spec().maxChildren} children · depth ${spec().maxDepth}` },
      { label: "Configuration", value: <DigestValue value={props.agent.configDigest} label="Configuration digest" /> },
    ]} /></Section>
    <Section title="Pinned instructions" surface="card"><p class="brain-readable whitespace-pre-wrap text-base text-ink-gray-8">{props.agent.instructions || "No instruction asset is attached to this Agent."}</p></Section>
  </div>;
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
  return <div class="brain-detail-stack"><PageIntro title="Agent catalog" description="Inspect what each model can do, which tools are pinned, and the limits every attempt must obey." />
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active Agents" emptyDescription="Activate the complete starter release in Settings.">
      <PaneLayout active={current() ? "end" : "start"} start={<Section title="Active Agents" surface="card">
        <RecordCollection title="Agents" rows={(read.state().data ?? []).map((item) => ({ id: item.release.id, name: name(item.release.id), engines: item.definition.spec.engine.anyOf.join(", ") }))}
          columns={[{ id: "name", header: "Agent", accessorKey: "name" }, { id: "engines", header: "Engines", accessorKey: "engines" }]} onOpen={select} openLabel="Inspect" />
      </Section>} end={<Show when={current()} keyed fallback={<p>Select an Agent to inspect its instructions and limits.</p>}>{(agent) => <AgentDetail agent={agent} onBack={() => select("")} />}</Show>} />
    </ScreenRegion>
  </div>;
}
