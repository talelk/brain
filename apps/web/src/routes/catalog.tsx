import { For, Show, createEffect, createSignal, on } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button, KeyValue, Textarea } from "@talelk/newui-atoms";
import { Select, toast } from "@talelk/newui-molecules";
import { DataTable, Section } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { AgentCatalogEntry, JsonValue, OperationalReadiness, WorkflowCatalogEntry } from "@brain/contracts";
import { governor, query } from "../data/client";
import { createScopedRead } from "../data/screens";
import { useApp } from "../ui/app-context";
import { ScreenRegion } from "../ui/screen-region";

const name = (value: string) => value.replaceAll("-", " ").replace(/^./u, (c) => c.toUpperCase());

export function OperationalChecklist() {
  const app = useApp();
  const check = createScopedRead<OperationalReadiness>({ scope: app.scope,
    load: async (scope, signal) => {
      const snapshot = await governor<OperationalReadiness>(`/v1/doctor?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
      return { snapshot, asOf: snapshot.asOf, sourceWatermark: 0 };
    }, refreshMs: 15000,
  });
  return <Section title="Setup checklist" description="Release, runner and engine readiness for the selected workspace." surface="card">
    <ScreenRegion state={check.state()} onRetry={() => void check.refresh()} emptyTitle="Readiness unavailable" emptyDescription="Select an accessible workspace.">
      <For each={check.state().data?.checks}>{(item) => <div class="border-b border-outline-gray-1 py-2">
        <Badge theme={item.status === "ready" ? "green" : "amber"} label={item.status} /> <strong>{name(item.id)}</strong>
        <p>{item.detail}</p><p class="text-caption text-ink-gray-7">{item.nextAction}</p>
      </div>}</For>
    </ScreenRegion>
  </Section>;
}

function WorkflowForm(props: { workflow: WorkflowCatalogEntry; onDispatched: (runId: string) => void }) {
  const app = useApp();
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [json, setJson] = createSignal("{}");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  type Schema = { properties?: Record<string, { type?: string; title?: string; description?: string; enum?: string[]; const?: JsonValue }>; required?: string[] };
  const schema = () => (props.workflow.inputSchema ?? {}) as Schema;
  const fields = () => Object.entries(schema().properties ?? {});
  createEffect(on(() => props.workflow.release.digest, () => { setValues({}); setError(""); setJson("{}"); }));
  const value = (key: string) => values()[key] ?? "";
  async function dispatch(event: SubmitEvent) {
    event.preventDefault(); if (busy()) return;
    setBusy(true); setError("");
    try {
      const input: Record<string, unknown> = fields().length ? {} : JSON.parse(json());
      for (const [key, field] of fields()) {
        const raw = value(key);
        if (!raw && !schema().required?.includes(key) && field.const === undefined) continue;
        input[key] = field.const ?? (field.type === "integer" || field.type === "number" ? Number(raw) : field.type === "boolean" ? raw === "true" : field.type === "string" ? raw : JSON.parse(raw));
      }
      const receipt = await app.run("workflow.dispatch", { workflow: props.workflow.release, input });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail);
      toast.success({ title: "Workflow accepted", description: "The durable run is ready to inspect." });
      props.onDispatched(receipt.resourceId);
    } catch (e) { setError(e instanceof Error ? e.message : "Dispatch failed"); }
    finally { setBusy(false); }
  }
  return <form onSubmit={dispatch} class="flex flex-col gap-field-gap">
    <For each={fields()}>{([key, field]) => <Show when={field.const === undefined} fallback={<KeyValue label={name(key)} value={String(field.const)} />}>
      <Show when={field.enum || field.type === "boolean"} fallback={
        <Textarea label={field.title ?? name(key)} description={field.description ?? (field.type === "string" ? undefined : "Enter a JSON value")}
          required={schema().required?.includes(key)} value={value(key)} onInput={(e) => setValues((v) => ({ ...v, [key]: e.currentTarget.value }))} />
      }><Select label={field.title ?? name(key)} value={value(key)} options={(field.enum ?? ["true","false"]).map((v) => ({ value: v, label: v }))} onValueChange={(v) => setValues((prev) => ({ ...prev, [key]: v ?? "" }))} /></Show>
    </Show>}</For>
    <Show when={!fields().length}><Textarea label="Workflow input (JSON)" value={json()} onInput={(e) => setJson(e.currentTarget.value)} /></Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Button type="submit" loading={busy()} disabled={!app.canDispatch() || busy()}>Dispatch {name(props.workflow.release.id)}</Button>
  </form>;
}

export function WorkflowsPage() {
  const app = useApp(); const navigate = useNavigate();
  const [selected, setSelected] = createSignal("");
  const read = createScopedRead<WorkflowCatalogEntry[]>({ scope: app.scope,
    load: async (scope, signal) => {
      const view = await query<{ snapshot: { items: WorkflowCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "workflows.list", workspaceId: scope.workspaceId }, signal);
      return { ...view, snapshot: view.snapshot.items };
    }, isEmpty: (items) => !items.length,
  });
  const current = () => read.state().data?.find((item) => item.release.id === selected());
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active workflows" emptyDescription="Compile and activate a release in Settings.">
    <PaneLayout active={current() ? "end" : "start"} start={<Section title="Workflows" surface="card">
      <DataTable title="Workflows" rows={(read.state().data ?? []).map((item) => ({ id: item.release.id, name: name(item.release.id), jobs: String(Object.keys(item.definition.spec.jobs).length) }))}
        columns={[{ id: "name", header: "Workflow", accessorKey: "name" },{ id: "jobs", header: "Jobs", accessorKey: "jobs" }]} selectable actionLabel="Inspect" onRowsAction={(ids) => setSelected(ids[0] ?? "")} />
    </Section>} end={<Show when={current()} keyed fallback={<p>Select a workflow to inspect and dispatch.</p>}>{(workflow) => <Section title={name(workflow.release.id)} surface="card">
      <Button variant="ghost" onClick={() => setSelected("")}>Back to workflows</Button>
      <KeyValue label="Release" value={workflow.configDigest} orientation="vertical" />
      <For each={Object.entries(workflow.definition.spec.jobs)}>{([id, job]) => <p><strong>{name(id)}</strong>: {job.kind} · depends on {job.needs.join(", ") || "input"}{"runsOn" in job ? ` · group ${job.runsOn.group}` : ""}</p>}</For>
      <details><summary>Expected output</summary><pre class="whitespace-pre-wrap break-words">{JSON.stringify(workflow.outputSchema,null,2)}</pre></details>
      <WorkflowForm workflow={workflow} onDispatched={(runId) => void navigate(`/jobs/${runId}`)} />
    </Section>}</Show>} />
  </ScreenRegion>;
}

export function AgentsPage() {
  const app = useApp(); const [selected,setSelected] = createSignal("");
  const read = createScopedRead<AgentCatalogEntry[]>({ scope: app.scope,
    load: async (scope,signal) => {
      const view = await query<{ snapshot: { items: AgentCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "agents.list", workspaceId: scope.workspaceId }, signal);
      return { ...view,snapshot: view.snapshot.items };
    }, isEmpty: (items) => !items.length,
  });
  const current = () => read.state().data?.find((item) => item.release.id === selected());
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="No active agents" emptyDescription="Activate the complete starter release in Settings.">
    <PaneLayout active={current() ? "end" : "start"} start={<Section title="Agents" surface="card"><DataTable title="Agents" selectable actionLabel="Inspect" onRowsAction={(ids) => setSelected(ids[0] ?? "")}
      rows={(read.state().data ?? []).map((item) => ({ id: item.release.id, name: name(item.release.id), engines: item.definition.spec.engine.anyOf.join(", ") }))}
      columns={[{ id: "name",header: "Agent",accessorKey: "name" },{ id: "engines",header: "Engines",accessorKey: "engines" }]} /></Section>}
      end={<Show when={current()} keyed fallback={<p>Select an agent to inspect its instructions and limits.</p>}>{(agent) => <Section title={name(agent.release.id)} surface="card">
        <Button variant="ghost" onClick={() => setSelected("")}>Back to agents</Button>
        <KeyValue label="Release" value={agent.configDigest} orientation="vertical" />
        <KeyValue label="Allowed tools" value={agent.definition.spec.tools.map((tool) => tool.id).join(", ") || "None"} />
        <KeyValue label="Limits" value={`${agent.definition.spec.maxTurns} turns · ${agent.definition.spec.maxTokens} tokens · ${agent.definition.spec.maxMicroUsd} microUSD · ${agent.definition.spec.maxChildren} children · depth ${agent.definition.spec.maxDepth}`} />
        <pre class="whitespace-pre-wrap break-words">{agent.instructions}</pre>
        <AgentDiagnostic agent={agent} />
      </Section>}</Show>} />
  </ScreenRegion>;
}

function AgentDiagnostic(props:{agent:AgentCatalogEntry}) {
  const app=useApp(), navigate=useNavigate(); const [error,setError]=createSignal(""); const [busy,setBusy]=createSignal(false);
  async function run() {
    setBusy(true);setError("");
    try {
      const view=await query<{snapshot:{items:WorkflowCatalogEntry[]}}>({queryType:"workflows.list",workspaceId:app.workspaceId()});
      const workflow=view.snapshot.items.find((item)=>Object.values(item.definition.spec.jobs).some((job)=>job.kind==="dispatch"&&job.uses.type==="agent"&&job.uses.release.digest===props.agent.release.digest));
      const inputs:Record<string,Record<string,unknown>>={"agent-smoke":{message:"BRAIN_OK"},"operations-triage":{situation:"Diagnostic: identify missing facts and safe next checks for an idle test environment. Do not execute any actions."},"support-draft":{title:"Diagnostic ticket",body:"This is a read-only engine diagnostic. Draft a response asking for diagnostic details; do not send anything."}};
      const input=workflow?inputs[workflow.release.id]:undefined;
      if(!workflow||!input){void navigate(`/w/${app.workspaceId()}/workflows`);return;}
      const receipt=await app.run("workflow.dispatch",{workflow:workflow.release,input});
      if(!receipt.accepted||!receipt.resourceId)throw new Error(receipt.detail);
      void navigate(`/jobs/${receipt.resourceId}`);
    } catch(e){setError(e instanceof Error?e.message:"Diagnostic dispatch failed");}finally{setBusy(false);}
  }
  return <><Button disabled={!app.canDispatch()||busy()} loading={busy()} onClick={()=>void run()}>Run diagnostic</Button><Show when={error()}><p role="alert">{error()}</p></Show></>;
}
