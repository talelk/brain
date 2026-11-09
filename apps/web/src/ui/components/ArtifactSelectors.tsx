import { createSignal, For } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { ArtifactRef } from "@brain/contracts";
import { governor, query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { ActionFeedback } from "./ActionFeedback";

/** Select verified workspace artifacts or upload bytes; never ask an operator to invent a digest or byte count. */
export function ArtifactSelector(props: { label: string; onSelect: (artifact: ArtifactRef) => void; maxBytes?: number }) {
  const app=useApp(); const [selected,setSelected]=createSignal(""); const [error,setError]=createSignal("");
  const read=createScopedRead<ArtifactRef[]>({scope:app.scope,load:async(scope,signal)=>{
    const loaded=await query<{snapshot:{items:ArtifactRef[]};asOf:string;sourceWatermark:number}>({queryType:"artifacts.list",workspaceId:scope.workspaceId},signal);
    return {...loaded,snapshot:loaded.snapshot.items};
  }});
  async function upload(file:File) {
    setError("");
    try {
      if (!file.size || file.size>(props.maxBytes??1024*1024)) throw new Error("Choose a nonempty file within the upload size limit");
      const bytes=await file.arrayBuffer();
      const hash=await crypto.subtle.digest("SHA-256",bytes);
      const expectedDigest=`sha256:${[...new Uint8Array(hash)].map((v)=>v.toString(16).padStart(2,"0")).join("")}`;
      const {uploadId}=await governor<{uploadId:string}>("/v1/artifacts/init",{workspaceId:app.workspaceId(),expectedDigest,expectedBytes:file.size});
      const response=await fetch(`/v1/artifacts/${encodeURIComponent(uploadId)}/content`,{method:"PUT",credentials:"same-origin",body:bytes});
      const artifact=await response.json() as ArtifactRef & {detail?:string};
      if(!response.ok) throw new Error(artifact.detail??"Artifact upload failed");
      await read.refresh(); setSelected(artifact.artifactId); props.onSelect(artifact);
    } catch(e){setError(e instanceof Error?e.message:"Upload failed");}
  }
  return <div class="grid min-w-0 gap-2">
    <Select label={props.label} value={selected()} options={(read.state().data??[]).map((artifact)=>({value:artifact.artifactId,label:`${artifact.artifactId} · ${artifact.mediaType} · ${artifact.bytes} bytes`}))}
      onValueChange={(id)=>{setSelected(id??"");const artifact=read.state().data?.find((a)=>a.artifactId===id);if(artifact)props.onSelect(artifact);}} />
    <TextInput label={`Upload ${props.label.toLowerCase()}`} type="file" onChange={(event)=>{const file=event.currentTarget.files?.[0];if(file)void upload(file);}} />
    <ActionFeedback tone="error" message={error() || read.state().error} />
  </div>;
}

export function EvidenceSelector(props:{onSelect:(digests:string[])=>void}) {
  const [digests,setDigests]=createSignal<string[]>([]);
  const update=(values:string[])=>{setDigests(values);props.onSelect(values);};
  return <div class="flex min-w-0 flex-col gap-2">
    <ArtifactSelector label="Evidence artifact" onSelect={(artifact)=>update([...new Set([...digests(),artifact.digest])])} />
    <For each={digests()}>{(digest)=><div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-control bg-surface-gray-1 px-2 py-1.5"><code class="min-w-0 break-all text-caption text-ink-gray-7">{digest}</code><Button size="sm" variant="ghost" iconLeft="lucide-x" onClick={()=>update(digests().filter((value)=>value!==digest))}>Remove evidence</Button></div>}</For>
  </div>;
}

export function EvidenceBundleSelector(props: { label?: string; workItemId?: string; onSelect: (digest: string) => void }) {
  const app = useApp();
  const [selected, setSelected] = createSignal("");
  const read = createScopedRead<{ digest: string; passedCriteria: string[] }[]>({ scope: app.scope, load: async (scope, signal) => {
    const loaded = await governor<{ items: { digest: string; passedCriteria: string[] }[] }>(`/v1/evidence?workspaceId=${encodeURIComponent(scope.workspaceId)}${props.workItemId ? `&workItemId=${encodeURIComponent(props.workItemId)}` : ""}`, undefined, signal);
    return { snapshot: loaded.items, asOf: new Date().toISOString(), sourceWatermark: 0 };
  } });
  return <div class="flex flex-col gap-control-gap">
    <Select label={props.label ?? "Verified evidence bundle"} value={selected() || null}
      description={props.workItemId ? "Only verified bundles produced by this work item's own runs are listed." : "Only server-verified bundles are listed; an arbitrary artifact digest cannot mark work Done."}
      options={(read.state().data ?? []).map((bundle) => ({ value: bundle.digest, label: `${bundle.passedCriteria.length} passed criteria`, description: bundle.digest }))}
      onValueChange={(digest) => { setSelected(digest ?? ""); if (digest) props.onSelect(digest); }} />
    <ActionFeedback tone="error" message={read.state().error} />
  </div>;
}
