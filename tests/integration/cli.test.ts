import { mkdtempSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { runCli } from "../../apps/cli/src/client";
import { credentialStore } from "../../apps/cli/src/credentials";
import { goldenDocs } from "../helpers";
import { totpCode } from "../support/totp";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-cli-")); const app = await createApp({ dataDir: join(root,"data") });
  cleanups.push(async () => { await app.close(); rmSync(root,{recursive:true,force:true}); });
  const env: NodeJS.ProcessEnv = { BRAIN_GOVERNOR_URL:"http://127.0.0.1:3000", BRAIN_CLI_STATE_DIR:join(root,"state"), BRAIN_EMAIL:"cli@example.test", BRAIN_PASSWORD:"cli-test-password-123" };
  let output = ""; let errors = "";
  const run = async (args: string[]) => { output="";errors="";return runCli(args,{ env, fetch: async (request) => app.fetch(request), stdout: (text) => { output+=text; }, stderr: (text) => { errors+=text; } }); };
  const setup = () => run(["setup","--local","--org","org-cli","--name","CLI","--setup-token-file",join(root,"data","setup.token"),"--json"]);
  return { root,app,env,run,setup,output:()=>output,errors:()=>errors, credentials:credentialStore("http://127.0.0.1:3000",env) };
}

describe("CLI native credential flow", () => {
  it("sets up, persists a private native session, runs a shared command and logs out", async () => {
    const x = await fixture(); expect(await x.setup()).toBe(0);
    expect(JSON.parse(x.output())).toEqual({authenticated:true,organizationId:"org-cli"});
    expect(x.output()+x.errors()).not.toContain(x.env["BRAIN_PASSWORD"]!);
    expect(lstatSync(x.env["BRAIN_CLI_STATE_DIR"]!).mode & 0o077).toBe(0);
    const token = x.credentials.read(); expect(token.length).toBeGreaterThan(32); expect(x.output()).not.toContain(token);
    const { actor } = await x.app.brain.resolveActor(new Headers({authorization:`Bearer ${token}`}));
    x.app.brain.createWorkspace(actor,{workspaceId:"ws-cli",slug:"cli"});
    const command = { contractVersion:"brain.command/v1", commandType:"board.create", commandId:"cmd-cli", idempotencyKey:"cli-create", workspaceId:"ws-cli", payload:{title:"Created through CLI",criteria:["verified by an independent evaluator"]} };
    expect(await x.run(["command",JSON.stringify(command),"--json"])).toBe(0);
    expect(x.app.brain.store.workspaceDb("ws-cli","org-cli").prepare("SELECT title FROM cards").get()).toEqual({title:"Created through CLI"});
    expect(await x.run(["logout","--json"])).toBe(0); expect(x.credentials.read()).toBe("");
    await expect(x.app.brain.resolveActor(new Headers({authorization:`Bearer ${token}`}))).rejects.toThrow();
    expect(await x.run(["login","--json"])).toBe(0);
    expect(JSON.parse(x.output())).toEqual({authenticated:true,organizationId:"org-cli"});
  });

  it("completes a native second-factor sign-in without printing credentials", async () => {
    const x = await fixture(); expect(await x.setup()).toBe(0);
    const token = x.credentials.read();
    const send = (path: string, body: unknown) => x.app.fetch(new Request(`http://127.0.0.1:3000/api/auth${path}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify(body)}));
    const enabled = await send("/two-factor/enable",{password:x.env["BRAIN_PASSWORD"]}); expect(enabled.status).toBe(200);
    const {totpURI}=await enabled.json() as {totpURI:string}; const secret=new URL(totpURI).searchParams.get("secret")!;
    const enrolled=await send("/two-factor/verify-totp",{code:totpCode(secret,Date.now()),trustDevice:false});expect(enrolled.status).toBe(200);
    x.credentials.clear(); x.env["BRAIN_TOTP"]=totpCode(secret,Date.now());
    expect(await x.run(["login","--json"])).toBe(0);
    expect((await x.app.brain.resolveActor(new Headers({authorization:`Bearer ${x.credentials.read()}`}))).humanSession!.factorDigest).toBeTruthy();
    expect(x.output()+x.errors()).not.toContain(secret);expect(x.output()+x.errors()).not.toContain(x.env["BRAIN_PASSWORD"]!);expect(x.output()).not.toContain(x.credentials.read());
  });
});

describe("CLI configuration and workflow operations", () => {
  it("compiles a full release without activation, inspects, activates, lists, and dispatches", async () => {
    const x = await fixture(); expect(await x.setup()).toBe(0);
    const token = x.credentials.read();
    const { actor } = await x.app.brain.resolveActor(new Headers({ authorization: `Bearer ${token}` }));
    x.app.brain.createWorkspace(actor, { workspaceId: "ws-cli", slug: "cli" });
    expect(await x.run(["config", "compile", "examples/v1/golden-release", "--json"])).toBe(0);
    const digest = (JSON.parse(x.output()) as { digest: string }).digest;
    expect(x.app.brain.activeRelease("org-cli")).toBeUndefined();
    expect(await x.run(["config", "inspect", digest, "--json"])).toBe(0);
    expect(JSON.parse(x.output()).manifest.tools).toHaveLength(2);
    expect(await x.run(["config", "activate", digest, "--json"])).toBe(0);
    expect(x.app.brain.activeRelease("org-cli")?.digest).toBe(digest);
    expect(await x.run(["workflow", "list", "--workspace", "ws-cli", "--json"])).toBe(0);
    expect(JSON.parse(x.output()).snapshot.items[0].release.id).toBe("fixture-workflow");
    expect(await x.run(["workflow", "run", "fixture-workflow", "--workspace", "ws-cli", "--input", '{"message":"CLI dispatch"}', "--json"])).toBe(0);
    expect(JSON.parse(x.output()).resourceId).toBeTruthy();
    expect(await x.run(["workflow", "run", "fixture-workflow", "--workspace", "ws-cli", "--input", "{malformed", "--json"])).toBe(1);
  });

  it("denies catalog reads for a workspace outside the current membership and anonymous inspection", async () => {
    const x = await fixture(); expect(await x.setup()).toBe(0);
    const token = x.credentials.read();
    const { actor } = await x.app.brain.resolveActor(new Headers({ authorization: `Bearer ${token}` }));
    const { digest } = x.app.brain.stageRelease(actor, goldenDocs(), `sha256:${"b".repeat(64)}`);
    x.app.brain.activateRelease(actor, digest);
    expect(await x.run(["workflow", "list", "--workspace", "ws-other", "--json"])).toBe(1);
    x.credentials.clear();
    expect(await x.run(["config", "inspect", digest, "--json"])).toBe(1);
  });
});
