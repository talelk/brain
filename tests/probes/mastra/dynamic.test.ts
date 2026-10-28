import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";

describe("pinned Mastra dynamic nested durable waits",()=>{
  it("addresses parallel nested waits independently and restores the remaining wait after shutdown",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"brain-dynamic-"));
    const invoked:string[]=[];
    const make=async()=>{
      const primitive=(id:string)=>createWorkflow({id,inputSchema:z.object({runId:z.string()}),outputSchema:z.object({done:z.string()})})
        .then(createStep({id:"invoke",inputSchema:z.object({runId:z.string()}),outputSchema:z.object({done:z.string()}),
          suspendSchema:z.object({reason:z.string()}),resumeSchema:z.object({ready:z.boolean()}),
          execute:async({inputData,resumeData,suspend})=>{
            if(!resumeData?.ready)return suspend({reason:id});
            invoked.push(`${inputData.runId}:${id}`);return {done:id};
          }})).commit();
      const storage=new LibSQLStore({id:"dynamic-proof",url:`file:${join(dir,"workspace.mastra.db")}`});
      const workflows:Record<string,ReturnType<typeof primitive>>={left:primitive("left"),right:primitive("right")};
      const mastra=new Mastra({workflows,storage,logger:false});
      await mastra.addDynamicWorkflow({id:"brain-dynamic",inputSchema:{type:"object",properties:{runId:{type:"string"}},required:["runId"]},outputSchema:{type:"object"},
        graph:[{type:"parallel",id:"brain-jobs",steps:[{type:"workflow",id:"left-call",workflowId:"left"},{type:"workflow",id:"right-call",workflowId:"right"}]}]});
      return mastra;
    };
    let mastra=await make();
    try {
      const run=await mastra.getWorkflow("brain-dynamic").createRun({runId:"root-run"});
      const started=await run.start({inputData:{runId:"root-run"}});
      expect(started.status).toBe("suspended");
      if(started.status!=="suspended")throw new Error("expected suspension");
      expect(started.suspended).toHaveLength(2);
      writeFileSync("/tmp/brain-mastra-snapshot.json",JSON.stringify(await mastra.getWorkflow("brain-dynamic").getWorkflowRunById("root-run",{fields:["steps","suspendedPaths"]}),null,2));
      const left=started.suspended.find(path=>path[0]==="left-call");
      expect(left).toBeTruthy();
      const partial=await run.resume({step:left!,resumeData:{ready:true}});
      expect(partial.status).toBe("suspended");
      expect(invoked).toEqual(["root-run:left"]);
      await mastra.shutdown();
      mastra=await make();
      const restored=await mastra.getWorkflow("brain-dynamic").createRun({runId:"root-run"});
      const complete=await restored.resume({step:["right-call","invoke"],resumeData:{ready:true}});
      expect(complete.status).toBe("success");
      expect(invoked).toEqual(["root-run:left","root-run:right"]);
    }finally{await mastra.shutdown();}
  },60_000);
});
