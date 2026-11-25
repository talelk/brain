import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resultDigest, sha256Digest, signReceipt } from "@brain/contracts";
import type { AttemptEventBody, AttemptFailure, AttemptUsage, BlobRef, CompleteRequest, JobOffer, JsonValue } from "@brain/contracts";
import { execa } from "execa";
import type { RunnerConfig } from "./config";
import { isJsonObject } from "./engines/json-reply";
import type { EngineAdapter, EngineSessionSpec } from "./engines/port";
import { type AbortCause, type AnswerFormat, engineFailure, runEngine } from "./engines/run";
import { SANDBOX_PATHS, SandboxedEngine } from "./engines/sandboxed";
import { createEngine, type EngineHosting, engineHosting, nativeToolsAllowed } from "./engines/select";
import { boundedToolText, toolNameNote } from "./engines/tool-calls";
import { type GovernorClient, isLeaseLost } from "./governor-client";
import { EventSpool } from "./spool";
import { CHECK_SHAPE, composeTask, JUDGE_SHAPE, PLAN_SHAPE, type ReviewPatch, modelCommands } from "./task-text";
import { ToolCalls } from "./tools/calls";
import { scrubValue } from "./tools/script";
import { placeWorkspaceFiles } from "./workspace-files";
import { collectOutputs, prepareWorkingCopy, SetupError, type WorkingCopy } from "./working-copy";

/** What one attempt needs of its runner. */
export interface AttemptContext {
  readonly cfg: RunnerConfig;
  readonly client: GovernorClient;
  readonly privateKeyPem: string;
  /** Whether this runner can start engine sandboxes right now. */
  readonly sandboxAvailable: boolean;
}

/** How often the lease is renewed, and how long before its end the attempt is given up when no renewal got through. */
const RENEW_MS = 15_000;
const LEASE_MARGIN_MS = 5_000;
/** A check or judge answers in one short JSON object, but a reasoning model may think at length first: its reply gets room for both. */
const VERDICT_OUTPUT_TOKENS = 32_768;
const SETUP_TIMEOUT_MS = 20 * 60_000;
const PATCH_MEDIA_TYPE = "text/x-diff";
const INLINE_PATCH_CHARS = 20_000;
const NO_USAGE: AttemptUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0 };

/**
 * The first engine of the agent's list that this runner has and that can give the agent its native tools. Where the runner's fixture
 * stands in for an engine (`fixtureFor`), an agent that names that engine gets the fixture.
 */
export function pickEngine(offer: JobOffer, engines: readonly string[], sandboxAvailable: boolean, fixtureFor: readonly string[] = []): { id: string; hosting: EngineHosting } | undefined {
  for (const named of offer.agent.engines) {
    const id = fixtureFor.includes(named) && engines.includes("fixture") ? "fixture" : named;
    const hosting = engineHosting(id, sandboxAvailable);
    if (engines.includes(id) && hosting !== "unavailable" && (offer.agent.native === "none" || nativeToolsAllowed(hosting))) return { id, hosting };
  }
  return undefined;
}

/** The final answers that must be JSON, by kind (packs/README.md, "Final-answer formats"). */
function answerFormat(offer: JobOffer): AnswerFormat | undefined {
  if (offer.kind === "plan") return { shape: PLAN_SHAPE, problems: (value) => {
    if (!isJsonObject(value)) return ["the answer is not an object"];
    const problems: string[] = [];
    if (typeof value["summary"] !== "string") problems.push('"summary" must be a string');
    const tasks = value["tasks"];
    if (!Array.isArray(tasks)) return [...problems, '"tasks" must be a list'];
    tasks.forEach((task, index) => {
      if (!isJsonObject(task)) { problems.push(`task ${index + 1} is not an object`); return; }
      for (const field of ["title", "goal", "agent"]) if (typeof task[field] !== "string" || !task[field]) problems.push(`task ${index + 1}: "${field}" must be a non-empty string`);
      if (!Array.isArray(task["after"]) || task["after"].some((title) => typeof title !== "string")) problems.push(`task ${index + 1}: "after" must be a list of task titles ([] when it waits for nothing)`);
    });
    return problems;
  } };
  if (offer.kind === "check") return { shape: CHECK_SHAPE, problems: (value) => (!isJsonObject(value) ? ["the answer is not an object"] : [
    ...(typeof value["pass"] === "boolean" ? [] : ['"pass" must be true or false']),
    ...(typeof value["score"] === "number" && value["score"] >= 0 && value["score"] <= 1 ? [] : ['"score" must be a number from 0 to 1']),
    ...(typeof value["findings"] === "string" ? [] : ['"findings" must be a string']),
  ]) };
  if (offer.kind === "judge") {
    const candidates = (offer.context.review ?? []).map((entry) => entry.attemptId);
    return { shape: JUDGE_SHAPE, problems: (value) => (!isJsonObject(value) ? ["the answer is not an object"] : [
      ...(typeof value["keep"] === "string" && candidates.includes(value["keep"]) ? [] : [`"keep" must be the attempt id of one candidate: ${candidates.join(", ")}`]),
      ...(typeof value["findings"] === "string" ? [] : ['"findings" must be a string']),
    ]) };
  }
  return undefined;
}

/** `host` or `host:port` of an address, lower-case, as an egress grant names it. */
function hostOf(address: string): string | undefined {
  try { return new URL(address).host.toLowerCase() || undefined; } catch { return undefined; }
}

interface Ended { readonly outcome: CompleteRequest["outcome"]; readonly result: string; readonly output?: JsonValue; readonly failure?: AttemptFailure; readonly workingCopy?: BlobRef; readonly stateCommits?: Readonly<Record<string, string>> }

/**
 * Runs one claimed attempt to its end: acknowledges it, keeps its lease, sets up its folders and working copy, runs its engine session
 * (or, for `act`, its one approved call), uploads what it produced and completes it with a signed receipt. `abort` stops it: its reason
 * is `stopped` (the Governor no longer wants it) or `lease` (the lease is gone, and then nothing is completed).
 */
export async function runAttempt(context: AttemptContext, offer: JobOffer, abort: AbortController): Promise<void> {
  const { cfg, client } = context;
  const { attemptId, fence } = offer;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(attemptId) || attemptId.includes("..")) throw new Error("the attempt id cannot name a folder");
  const attemptDir = join(cfg.stateDir, "attempts", attemptId);
  const picked = offer.kind === "act" ? undefined : pickEngine(offer, cfg.engines, context.sandboxAvailable, cfg.fixtureFor);
  const engineName = picked?.id ?? "none";
  const stop = (cause: AbortCause): void => { if (!abort.signal.aborted) abort.abort(cause); };

  const lease = await client.ack(attemptId, { fence, engine: engineName });
  if (lease.stop) stop("stopped");
  let deadline = performance.now() + (lease.leaseExpiresAt - Date.now()) - LEASE_MARGIN_MS;
  const spool = new EventSpool((events) => client.events(attemptId, { fence, events }).catch((error: unknown) => { if (isLeaseLost(error)) { spool.discard(); stop("lease"); } throw error; }));
  /** The attempt's model token: a command or the model may print it, and it still works while the attempt runs, so it leaves in no event and no result. */
  const hidden: string[] = [];
  const emit = (event: AttemptEventBody): void => spool.push(scrubValue(event as unknown as JsonValue, hidden) as unknown as AttemptEventBody);
  const renewing = setInterval(() => {
    void client.renew(attemptId, { fence }).then((renewed) => {
      deadline = performance.now() + (renewed.leaseExpiresAt - Date.now()) - LEASE_MARGIN_MS;
      if (renewed.stop) stop("stopped");
    }, (error: unknown) => { if (isLeaseLost(error)) { spool.discard(); stop("lease"); } });
  }, RENEW_MS);
  // The lease is the attempt's right to run: when no renewal got through before it ends, the attempt stops instead of running on unowned.
  const watchdog = setInterval(() => { if (performance.now() >= deadline) stop("lease"); }, 250);

  let usage: AttemptUsage = NO_USAGE;
  let copy: WorkingCopy | undefined;
  let engine: EngineAdapter | undefined;
  let ended: Ended;
  try {
    mkdirSync(join(attemptDir, "work"), { recursive: true });
    mkdirSync(join(attemptDir, "out"), { recursive: true });
    mkdirSync(join(attemptDir, "state"), { recursive: true });
    let uploaded: (BlobRef & { readonly at: string }) | undefined;
    /** The commit of each project the attempt has pushed to the git store so far. */
    let states: Readonly<Record<string, string>> = {};
    /** The working copy's diff as an artifact of the attempt, for people to read; uploaded again only when it changed. */
    const uploadDiff = async (): Promise<BlobRef | undefined> => {
      if (!copy || offer.kind !== "work") return undefined;
      const bytes = await copy.diff(abort.signal);
      const digest = sha256Digest(bytes);
      if (uploaded?.at !== digest) uploaded = { ...(await client.uploadArtifact(attemptId, { fence, name: "working-copy.patch", kind: "patch", mediaType: PATCH_MEDIA_TYPE }, bytes)), at: digest };
      return { digest: uploaded.digest, bytes: uploaded.bytes };
    };
    const tools = new ToolCalls({
      offer, client, launcher: cfg.launcher, attemptDir, emit, signal: abort.signal, unsandboxedForTests: cfg.unsandboxedForTests === true,
      // Before a call with an effect: what has changed is pushed to the store and its diff uploaded, so the Governor has both for the call.
      syncState: async () => { await uploadDiff(); if (copy && offer.kind === "work") states = await copy.push(abort.signal); },
      baseCommits: () => copy?.baseCommits ?? {}, stateCommits: () => states, leaseLost: () => { spool.discard(); stop("lease"); },
      ...(cfg.approval ? { approval: cfg.approval } : {}),
    });

    emit({ kind: "status", phase: "setup", detail: offer.projects.length > 0 ? `preparing the working copy of ${offer.projects.map((project) => project.name).join(", ")}` : "preparing the attempt" });
    const inherited = offer.inheritedStates.map((state, index) => ({ label: `the changes of prerequisite ${index + 1} of ${offer.inheritedStates.length}`, ...state }));
    copy = await prepareWorkingCopy({
      stateDir: cfg.stateDir, workspaceId: offer.workspaceId, attemptDir, projects: offer.projects, inherited, attemptId, store: offer.store, signal: abort.signal,
      credential: async (project) => (await client.secret(attemptId, { fence, name: project.credential!, use: { project: project.name } })).value,
    });

    if (offer.kind === "act") {
      if (!offer.act) throw new SetupError("an act attempt carries no call to run");
      const done = await tools.act(offer.act);
      // The attempt did its work when the call was run and its outcome is on record, whichever way the call went.
      ended = { outcome: "succeeded", result: boundedToolText(done.output), output: { tool: offer.act.tool, outcome: done.outcome, output: done.output } };
    } else if (!picked) {
      const wanted = `${offer.agent.engines.join(", ")}${offer.agent.native === "none" ? "" : ` with native tools "${offer.agent.native}"`}`;
      ended = { outcome: "failed", result: "", failure: { reason: "runner", detail: `this runner cannot run agent ${offer.agent.name}: it needs one of ${wanted}, and the runner has ${cfg.engines.join(", ")}${context.sandboxAvailable ? "" : " without an engine sandbox"}`, infrastructure: true } };
    } else {
      const sandboxed = picked.hosting === "sandboxed";
      // The agent sees the working copy only through its own tools, so only an agent that has them is shown where it is.
      const seesFiles = offer.agent.native !== "none";
      const paths = sandboxed ? SANDBOX_PATHS : { work: join(attemptDir, "work"), out: join(attemptDir, "out"), state: join(attemptDir, "state") };
      const reviewed = new Map<string, ReviewPatch>();
      // The files a reviewed attempt kept: a file the agent can read, or (when it can read no files) the start of its text.
      const reviewedFiles = new Map<string, ReviewPatch>();
      for (const entry of offer.context.review ?? []) {
        for (const file of entry.files) {
          const name = file.name.split("/").filter((part) => part && part !== "..").join("/") || "file";
          const text = new TextDecoder().decode(await client.blob(file));
          if (!seesFiles) { reviewedFiles.set(`${entry.attemptId}/${file.name}`, { inline: text.length > INLINE_PATCH_CHARS ? `${text.slice(0, INLINE_PATCH_CHARS)}\n[cut: ${text.length} characters in all]` : text }); continue; }
          const target = join(attemptDir, "work", ".brain", entry.attemptId, "files", name);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, text);
          reviewedFiles.set(`${entry.attemptId}/${file.name}`, { path: `${paths.work}/.brain/${entry.attemptId}/files/${name}` });
        }
        if (!entry.diff) continue;
        // The diff is `git diff` text with every path under its project's folder, as the files lie in the working copy.
        const text = new TextDecoder().decode(await client.blob(entry.diff));
        if (!text) continue;
        if (!seesFiles) { reviewed.set(entry.attemptId, { inline: text.length > INLINE_PATCH_CHARS ? `${text.slice(0, INLINE_PATCH_CHARS)}\n[cut: ${text.length} characters in all]` : text }); continue; }
        mkdirSync(join(attemptDir, "work", ".brain"), { recursive: true });
        writeFileSync(join(attemptDir, "work", ".brain", `${entry.attemptId}.patch`), text);
        reviewed.set(entry.attemptId, { path: `${paths.work}/.brain/${entry.attemptId}.patch` });
      }
      // An agent that reads files is given the workspace's own definition to read, beside the working copy and never part of it.
      const workspace = seesFiles && (await placeWorkspaceFiles(client, offer.snapshotDigest, join(attemptDir, "work", ".workspace")).then(() => true, () => false)) ? `${paths.work}/.workspace` : undefined;
      const prompt = new TextDecoder().decode(await client.blob({ digest: offer.agent.promptDigest }));
      const model = { baseUrl: offer.model.gatewayUrl, token: picked.id === "fixture" ? "" : (await client.modelToken(attemptId, { fence })).token, name: offer.model.route, contextTokens: offer.model.contextTokens, compactAt: offer.model.compactAt };

      hidden.push(model.token);
      if (sandboxed) {
        const launcher = cfg.launcher!;
        const wanted = [hostOf(offer.model.gatewayUrl), ...offer.projects.flatMap((project) => project.network.map((host) => host.toLowerCase()))].filter((host): host is string => host !== undefined);
        // The egress proxy grants exact names; a pattern cannot be granted and is left out, in the open.
        const patterns = wanted.filter((host) => host !== "*" && host.includes("*"));
        if (patterns.length > 0) emit({ kind: "status", phase: "setup", detail: `the egress proxy grants exact host names only, so these are not reachable: ${patterns.join(", ")}` });
        const sandbox = new SandboxedEngine(() => launcher.openEngine({
          engine: picked.id, attemptId, requestId: `engine-${attemptId}-${fence}`, cpuMillicores: cfg.sandbox.cpuMillicores, memoryMb: cfg.sandbox.memoryMb,
          work: offer.agent.native === "all" ? "rw" : offer.agent.native === "read" ? "ro" : "none", egressHosts: [...new Set(wanted.filter((host) => host === "*" || !host.includes("*")))],
        }), picked.id);
        engine = sandbox;
      } else {
        engine = createEngine(picked.id);
        if (!engine) throw new SetupError(`engine ${picked.id} is not known to this runner`, true);
      }
      // A project's setup command prepares the working copy for work on it, in the sandbox the agent will use; an agent that cannot write there has no use for it.
      // A setup command that fails does not fail the attempt: the agent is told what failed, with the end of the output, and may retry or work around it.
      const setupNotes: string[] = [];
      for (const project of offer.projects) {
        if (!project.setup || offer.agent.native !== "all") continue;
        emit({ kind: "status", phase: "setup", detail: `running the setup command of ${project.name}` });
        const ran = engine instanceof SandboxedEngine ? await engine.exec(project.setup, `${SANDBOX_PATHS.work}/${project.name}`, SETUP_TIMEOUT_MS, abort.signal)
          : cfg.unsandboxedForTests === true ? await setupDirectlyForTests(project.setup, join(attemptDir, "work", project.name), abort.signal) : undefined;
        if (!ran) emit({ kind: "status", phase: "setup", detail: `the setup command of ${project.name} was not run: the ${picked.id} engine runs outside a sandbox` });
        else if (ran.timedOut || ran.exitCode !== 0) {
          const note = `The setup command of project ${project.name} (${project.setup}) ${ran.timedOut ? "ran too long and was stopped" : `failed with exit code ${ran.exitCode}`}: ${ran.output.trim().slice(-400)}`;
          setupNotes.push(note);
          emit({ kind: "status", phase: "setup", detail: note });
        }
      }

      emit({ kind: "status", phase: "engine", detail: `${picked.id} runs agent ${offer.agent.name}` });
      const offered = offer.tools.filter((tool) => offer.agent.tools.includes(tool.name));
      const commandEnv = modelCommands(offer) ? { BRAIN_MODEL_URL: `${model.baseUrl}/commands`, BRAIN_MODEL_TOKEN: model.token, BRAIN_MODEL_NAME: model.name, BRAIN_MODEL_API: offer.model.provider } : undefined;
      const spec: EngineSessionSpec = {
        attemptId, instructions: prompt + toolNameNote(offered), model, native: offer.agent.native, outDir: paths.out, stateDir: paths.state, ...(commandEnv ? { commandEnv } : {}),
        task: composeTask(offer, { ...(seesFiles ? { work: paths.work } : {}), ...(workspace ? { workspace } : {}), out: paths.out }, reviewed, reviewedFiles) + (setupNotes.length > 0 ? `\n\n# Setup did not finish\n${setupNotes.join("\n")}\nDependencies may be missing; run what you need yourself, or say so in your result if you cannot.` : ""),
        ...(seesFiles ? { workDir: paths.work } : {}),
        tools: offered.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, effect: tool.effect })),
        limits: { timeoutMs: cfg.attemptTimeoutMs, maxTokens: offer.agent.limits.tokens, maxMicroUsd: offer.agent.limits.spendMicroUsd, maxTurns: offer.agent.limits.turns, ...(offer.kind === "check" || offer.kind === "judge" ? { maxOutputTokens: VERDICT_OUTPUT_TOKENS } : {}) },
      };
      const session = await runEngine({ engine, spec, emit, signal: abort.signal, executeTool: (tool, input, signal) => tools.call(tool, input, signal) }, answerFormat(offer));
      usage = { inputTokens: session.usage.inputTokens, outputTokens: session.usage.outputTokens, cachedInputTokens: session.usage.cachedInputTokens, microUsd: session.usage.microUsd };
      if (!session.ok) ended = { outcome: "failed", result: session.text, failure: session.failure! };
      else {
        emit({ kind: "status", phase: "upload", detail: "uploading what the attempt produced" });
        const outputs = collectOutputs(join(attemptDir, "out"));
        for (const file of outputs.files) await client.uploadArtifact(attemptId, { fence, name: file.name, kind: "output", mediaType: file.mediaType }, file.bytes);
        if (outputs.skipped.length > 0) emit({ kind: "text", channel: "diagnostic", text: `Not kept from the output folder (links, files that are too large or too many): ${outputs.skipped.slice(0, 20).join(", ")}` });
        const workingCopy = await uploadDiff();
        // What the attempt changed is handed on through the git store: the next attempt starts from it, on any runner.
        const stateCommits = copy && offer.kind === "work" ? await copy.push(abort.signal) : {};
        // A call left waiting for a person ends the attempt held: the session finished, the call has not happened.
        ended = { outcome: tools.held > 0 ? "held" : "succeeded", result: session.text, ...(session.output !== undefined ? { output: session.output } : {}), ...(workingCopy ? { workingCopy } : {}), stateCommits };
      }
    }
  } catch (error) {
    const cause = abort.signal.aborted ? abort.signal.reason as AbortCause : undefined;
    const failure: AttemptFailure = cause === "stopped" ? { reason: "stopped", detail: "the attempt was stopped", infrastructure: false }
      : error instanceof SetupError ? { reason: "setup", detail: error.message.slice(0, 1000), infrastructure: error.infrastructure }
      : isLeaseLost(error) || cause === "lease" ? { reason: "runner", detail: "the lease on the attempt was lost", infrastructure: true }
      : engineFailure(error instanceof Error ? error.message : "the runner failed");
    ended = { outcome: "failed", result: "", failure: failure.reason === "engine" ? { reason: "runner", detail: failure.detail, infrastructure: true } : failure };
  } finally {
    if (engine instanceof SandboxedEngine) await engine.close();
  }

  try {
    // An attempt whose lease is gone belongs to someone else now: nothing more is said about it.
    if (abort.signal.aborted && abort.signal.reason === ("lease" satisfies AbortCause)) return;
    await spool.drain().catch(() => undefined);
    const result = scrubValue(ended.result, hidden) as string;
    const output = ended.output === undefined ? undefined : scrubValue(ended.output, hidden);
    const receipt = { attemptId, fence, snapshotDigest: offer.snapshotDigest, resultDigest: resultDigest(result, output ?? null) };
    await client.complete(attemptId, {
      fence, outcome: ended.outcome, result, usage, engine: engineName, baseCommits: copy?.baseCommits ?? {}, stateCommits: ended.stateCommits ?? {},
      ...(output !== undefined ? { output } : {}), ...(ended.failure ? { failure: ended.failure } : {}), ...(ended.workingCopy ? { workingCopy: ended.workingCopy } : {}),
      receipt: { receipt, signature: signReceipt(receipt, context.privateKeyPem) },
    }).catch((error: unknown) => { if (!isLeaseLost(error)) throw error; });
  } finally {
    clearInterval(renewing);
    clearInterval(watchdog);
    spool.discard();
    if (existsSync(attemptDir)) rmSync(attemptDir, { recursive: true, force: true });
  }
}

/** TEST ONLY: a project's setup command on this host, in the working copy. There is no sandbox here. */
async function setupDirectlyForTests(command: string, cwd: string, signal: AbortSignal): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const result = await execa("/bin/bash", ["-c", command], { cwd, all: true, timeout: SETUP_TIMEOUT_MS, extendEnv: false, reject: false, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" }, cancelSignal: signal });
  return { exitCode: result.exitCode ?? 1, output: String(result.all ?? ""), timedOut: result.timedOut === true };
}
