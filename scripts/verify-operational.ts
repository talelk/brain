import { LauncherClient } from "../apps/runner/src/launcher-client";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "../apps/governor/src/http/app";
import { runCli } from "../apps/cli/src/client";
import { enrollAndHello, runOnce } from "../apps/runner/src/supervisor";

const engine = process.env["BRAIN_OPERATIONAL_ENGINE"] ?? "pi";
assert(["pi", "claude"].includes(engine), "BRAIN_OPERATIONAL_ENGINE must select pi or claude; this proof never substitutes a fixture");
function sourceSnapshot() {
  const paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter((path) => /^(apps|packages|contracts|scripts|tests|examples|deploy)\//u.test(path) || /^(package.json|pnpm-lock.yaml|README.md|Dockerfile|docker-compose.yml)$/u.test(path)))].sort();
  const sources = paths.map((path) => ({ path, sha256: existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null }));
  return { sources, fingerprint: createHash("sha256").update(JSON.stringify(sources)).digest("hex") };
}
const initialSource = sourceSnapshot();
const startedAt = new Date().toISOString();
const root = mkdtempSync(join(tmpdir(), "brain-operational-"));
const evidenceDir = resolve(process.env["BRAIN_OPERATIONAL_EVIDENCE_DIR"] ?? `artifacts/implementation/operational-${Date.now()}`);
mkdirSync(evidenceDir, { recursive: true });
process.env["BRAIN_PI_AGENT_DIR"] = join(root, "pi");
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const server = createAdaptorServer({ fetch: (request) => app ? app.fetch(request) : new Response("starting", { status: 503 }) });
const commands: { argv: string[]; exitCode: number }[] = [];
const runs: Record<string, unknown>[] = [];
let failed = false;
let launcher: ReturnType<typeof spawn> | undefined;
const heartbeatTimers: ReturnType<typeof setInterval>[] = [];
try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  process.env["BRAIN_BASE_URL"] = url;
  app = await createApp({ dataDir: join(root, "data") });
  const env = { ...process.env, BRAIN_GOVERNOR_URL: url, BRAIN_CLI_STATE_DIR: join(root, "cli"), BRAIN_EMAIL: "operator@example.test", BRAIN_PASSWORD: randomBytes(24).toString("base64url") };
  async function cli(argv: string[]) {
    let output = ""; let errors = "";
    const exitCode = await runCli([...argv, "--json"], { env, stdout: (s) => { output += s; }, stderr: (s) => { errors += s; } });
    commands.push({ argv: ["brain", ...argv.map((v) => v.startsWith(root) ? v.replace(root, "<disposable>") : v)], exitCode });
    assert.equal(exitCode, 0, `${argv.join(" ")}: ${errors || output}`);
    return JSON.parse(output);
  }
  await cli(["setup", "--local", "--org", "org-local", "--name", "Operational proof", "--setup-token-file", join(root, "data", "setup.token")]);
  await cli(["workspace", "create", "operations", "--slug", "operations"]);
  const release = await cli(["config", "compile", "examples/v1/starter-release"]);
  await cli(["config", "inspect", release.digest]);
  await cli(["config", "activate", release.digest]);
  await cli(["workflow", "list", "--workspace", "operations"]);
  // The validation tool runs through the actual trusted launcher and Docker.
  execFileSync("docker",["run","--rm","brain-sandbox-evaluator","/bin/bash","-lc","python3 --version"],{stdio:"pipe",timeout:30000});
  process.env["BRAIN_LAUNCHER_SOCKET"] = join(root,"launcher.sock");
  launcher = spawn(process.execPath,["--import","tsx","apps/launcher/src/main.ts"],{env:process.env,stdio:["ignore","pipe","pipe"]});
  let launcherLog = "";
  launcher.stdout?.on("data",(bytes:Buffer) => { launcherLog += bytes.toString(); });
  launcher.stderr?.on("data",(bytes:Buffer) => { launcherLog += bytes.toString(); });
  let launcherReady = false;
  for (let n=0;n<50;n++) {
    try { launcherReady = (await LauncherClient.fromEnv().health()).docker; if (launcherReady) break; } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve,100));
  }
  writeFileSync(join(evidenceDir,"launcher.log"),launcherLog);
  assert(launcherReady,"trusted launcher and Docker must be ready");
  const caps = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"];
  const cfg = (group: string) => ({ governorUrl: url, runnerId: `runner-${group}`, stateDir: join(root, group), capabilities: caps, engines: group === "agents" ? [engine] : ["fixture"] });
  const author = cfg("agents"), evaluator = cfg("evaluators");
  const authorSession = await enrollAndHello(author, (await cli(["runner", "token", "create", "--group", "agents"])).token);
  const evalSession = await enrollAndHello(evaluator, (await cli(["runner", "token", "create", "--group", "evaluators"])).token);
  for (const session of [authorSession, evalSession]) {
    let sequence = 0;
    heartbeatTimers.push(setInterval(() => {
      void fetch(`${url}/runner/v1/heartbeat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.sessionToken}` }, body: JSON.stringify({ sequence: ++sequence }), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }, 10000));
  }
  for (const [id, input] of [
    ["agent-smoke", { message: "BRAIN_OK" }],
    ["operations-triage", { situation: "After a deployment, error rates rose. No rollback has been attempted. Outline read-only checks and missing information." }],
    ["support-draft", { title: "Unable to sign in", body: "I see an expired session error. Draft a response asking for useful diagnostic details. Do not send it." }],
  ] as const) {
    const receipt = await cli(["workflow", "run", id, "--workspace", "operations", "--input", JSON.stringify(input)]);
    assert(receipt.resourceId, "dispatch must return a durable run ID");
    assert(await runOnce(author, authorSession.sessionToken, authorSession.epoch), "author runner must claim the agent job");
    const evaluated = await runOnce(evaluator, evalSession.sessionToken, evalSession.epoch);
    if (!evaluated) {
      const diagnostics = {
        jobs: app.brain.store.control.prepare("SELECT id,state,step_id FROM jobs WHERE workflow_run_id=?").all(receipt.resourceId),
        outputs: app.brain.store.control.prepare("SELECT name FROM sqlite_master WHERE name='job_outputs'").get() ? app.brain.store.control.prepare("SELECT * FROM job_outputs").all() : [],
        events: app.brain.store.control.prepare("SELECT * FROM attempt_events").all(),
      };
      writeFileSync(join(evidenceDir, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
    }
    assert(evaluated, "independent evaluator must claim the validation job");
    const ws = app.brain.store.workspaceDb("operations", "org-local");
    const run = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(receipt.resourceId) as { state: string };
    if (run.state !== "succeeded") {
      writeFileSync(join(evidenceDir, `${id}-failure.json`), JSON.stringify({
        run, outputs: app.brain.store.control.prepare("SELECT * FROM job_outputs").all(),
        events: app.brain.store.control.prepare("SELECT * FROM attempt_events").all(),
        verdicts: ws.prepare("SELECT manifest_json FROM verification_verdicts").all(),
      }, null, 2));
    }
    assert.equal(run.state, "succeeded", `${id}: workflow must finish with accepted independent evidence`);
    const bundle = ws.prepare("SELECT digest,manifest_json FROM evidence_bundles WHERE json_extract(manifest_json,'$.workflowRunId')=?").get(receipt.resourceId) as { digest: string; manifest_json: string };
    assert(bundle, "author evidence must exist");
    const verdict = ws.prepare("SELECT outcome,evaluator_attempt_id FROM verification_verdicts WHERE bundle_digest=?").get(bundle.digest);
    const output = ws.prepare("SELECT output_json FROM step_outputs WHERE run_id=? AND step_id='respond'").get(receipt.resourceId) as { output_json: string };
    const events = app.brain.store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=(SELECT id FROM job_attempts WHERE job_id=(SELECT id FROM jobs WHERE workflow_run_id=? AND step_id='respond')) ORDER BY seq").all(receipt.resourceId);
    const manifest = JSON.parse(bundle.manifest_json);
    if (id === "operations-triage") {
      const toolReleases = (manifest.toolReleases ?? []) as { id: string; digest: string }[];
      assert(toolReleases.some((tool) => tool.id === "operations.context" && tool.digest.startsWith("sha256:")), "operations-triage evidence must pin the governed operations.context release");
      const brokerObserved = events.some((entry) => {
        const event = JSON.parse(entry.event_json) as { kind?: string; payload?: { kind?: string; phase?: string } };
        return event.payload?.kind === "tool.proposed" || event.payload?.phase === "governed-tool-result";
      });
      assert(brokerObserved, "operations-triage must exercise the governed tool broker; no tool.proposed or governed-tool-result event was recorded");
    }
    runs.push({ workflowId: id, runId: receipt.resourceId, bundleDigest: bundle.digest, jobId: manifest.jobId, attemptId: manifest.attemptId, artifacts: manifest.artifacts, verdict, output: JSON.parse(output.output_json), engineEvents: events });
    console.log(`${id}: accepted ${receipt.resourceId} (${bundle.digest})`);
  }
  console.log(`All workflows accepted with ${engine}; checking final source identity`);
} catch (error) {
  failed = true;
  writeFileSync(join(evidenceDir, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
  throw error;
} finally {
  for (const timer of heartbeatTimers) clearInterval(timer);
  if (launcher && launcher.exitCode === null) {
    const exited = new Promise<void>((resolve) => launcher!.once("exit",()=>resolve()));
    launcher.kill("SIGTERM"); await exited;
  }
  await app?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    const finalSource = sourceSnapshot();
    const sourceStable = finalSource.fingerprint === initialSource.fingerprint;
    const passed = !failed && runs.length === 3 && sourceStable;
    writeFileSync(join(evidenceDir, "run.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), engine, modelId: process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b", head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceFingerprint: initialSource.fingerprint, finalSourceFingerprint: finalSource.fingerprint, sourceStable, sources: initialSource.sources, commands, runs, passed }, null, 2) + "\n");
    if (!failed && !passed) throw new Error("Operational proof is not current: source changed during execution");
    if (passed) console.log(`Operational proof passed; evidence: ${evidenceDir}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
