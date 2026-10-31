import { test as base, expect } from "@playwright/test";
import { createAdaptorServer } from "@hono/node-server";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/governor/src/http/app";

export const test = base.extend<{ requireTwoFactor: boolean; integrationUrls: boolean; localRuntime: boolean; governor: { url: string; credential: string; app: Awaited<ReturnType<typeof createApp>> } }>({
  requireTwoFactor: [false, { option: true }],
  integrationUrls: [false, { option: true }],
  localRuntime: [false, { option: true }],
  governor: async ({ browserName, requireTwoFactor, integrationUrls, localRuntime }, use) => {
    const dir = mkdtempSync(join(tmpdir(),`brain-browser-${browserName}-`));
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const server = createAdaptorServer({fetch:(request) => app ? app.fetch(request) : new Response("starting",{status:503})});
    const previous = process.env["BRAIN_BASE_URL"];
    const previousRuntime = process.env["BRAIN_LOCAL_RUNTIME_DIR"];
    if (localRuntime) process.env["BRAIN_LOCAL_RUNTIME_DIR"] = join(dir, "local-runtime");
    try {
      await new Promise<void>((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("browser fixture failed to obtain its listener");
      const url = `http://localhost:${address.port}`;
      process.env["BRAIN_BASE_URL"]=url;
      app=await createApp({dataDir:dir,runtime:{requireTwoFactor,memoryUiUrl:integrationUrls?"https://memory.example.test/":null}});
      await use({url,app,credential:readFileSync(join(dir,"setup.token"),"utf8").trim()});
    } finally {
      if(previous===undefined) delete process.env["BRAIN_BASE_URL"]; else process.env["BRAIN_BASE_URL"]=previous;
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => {server.close(()=>resolve());});
      await app?.close();
      if (previousRuntime === undefined) delete process.env["BRAIN_LOCAL_RUNTIME_DIR"]; else process.env["BRAIN_LOCAL_RUNTIME_DIR"] = previousRuntime;
      rmSync(dir,{recursive:true,force:true});
    }
  },
});
export { expect };
