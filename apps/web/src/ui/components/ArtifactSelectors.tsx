import { createSignal, For, Show } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { ArtifactRef } from "@brain/contracts";
import { governor, query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";

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
  return <div class="flex flex-col gap-control-gap">
    <Select label={props.label} value={selected()} options={(read.state().data??[]).map((artifact)=>({value:artifact.artifactId,label:`${artifact.artifactId} · ${artifact.mediaType} · ${artifact.bytes} bytes`}))}
      onValueChange={(id)=>{setSelected(id??"");const artifact=read.state().data?.find((a)=>a.artifactId===id);if(artifact)props.onSelect(artifact);}} />
    <TextInput label={`Upload ${props.label.toLowerCase()}`} type="file" onChange={(event)=>{const file=event.currentTarget.files?.[0];if(file)void upload(file);}} />
    <Show when={error()||read.state().error}><p role="alert">{error()||read.state().error}</p></Show>
  </div>;
}

export function EvidenceSelector(props:{onSelect:(digests:string[])=>void}) {
  const [digests,setDigests]=createSignal<string[]>([]);
  const update=(values:string[])=>{setDigests(values);props.onSelect(values);};
  return <div class="flex flex-col gap-control-gap">
    <ArtifactSelector label="Evidence artifact" onSelect={(artifact)=>update([...new Set([...digests(),artifact.digest])])} />
    <For each={digests()}>{(digest)=><div class="flex items-center gap-2"><code class="break-all text-caption">{digest}</code><Button size="sm" variant="ghost" onClick={()=>update(digests().filter((value)=>value!==digest))}>Remove evidence</Button></div>}</For>
  </div>;
}
