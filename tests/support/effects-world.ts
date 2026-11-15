import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { approvalSubjectDigest } from "@brain/contracts";
import type { CommandReceipt, JsonValue } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { startLauncher } from "../../apps/launcher/src/server";
import { LauncherClient } from "../../apps/runner/src/launcher-client";
import { enrollAndHello, runOnce, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { setupWorld, stepUp } from "../helpers";
import { fixtureStarter } from "./starter";

const tmp = process.env["TMPDIR"] ?? "/tmp";

/**
 * The world of the effect-tool gate: a Governor, a runner in the host group, a REAL launcher with a host-commands file of the operator's
 * (its restart appends to a counter file, so "ran once" is observable) and a sandbox double that runs the pinned script locally. Read
 * the counter with `restarts()`.
 */
export async function effectsWorld(options: { containers?: string[]; runnerGroup?: string } = {}) {
  const root = mkdtempSync(join(tmp, "brain-effects-"));
  const counter = join(root, "restarts.log");
  writeFileSync(counter, "");
  const socket = join(root, "run", "launcher.sock");
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(join(root, "commands.json"), JSON.stringify({ commands: {
    "docker.ps": { effect: "read", argv: ["sh", "-c", "printf 'demo-app\\tUp 3 minutes (unhealthy)\\nweb\\tUp 2 days\\n'"] },
    "docker.restart": { effect: "privileged", argv: ["sh", "-c", `echo "restarted $0" >> ${counter}`, "{container}"], args: { container: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$" } },
  } }));
  process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
  process.env["BRAIN_LAUNCHER_HOST_COMMANDS"] = join(root, "commands.json");
  await startLauncher();
  const realLauncher = new LauncherClient(socket);
  let toolsDir = "";
  // Host commands go to the real launcher; the sandbox that shapes a tool's output is a local stand-in (Docker is not needed here).
  const launcher = {
    hostCommand: (...args: Parameters<LauncherClient["hostCommand"]>) => realLauncher.hostCommand(...args),
    createSandbox: async (input: { toolsDir?: string }) => { toolsDir = input.toolsDir ?? ""; return { sandboxId: "sb-effects" }; },
    exec: async (_sandboxId: string, script: string, input: string) => {
      const result = spawnSync("/bin/bash", [script.replace(/^\/tools/, toolsDir)], { input, encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" } });
      return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: result.error !== undefined };
    },
    stop: async () => ({ terminationConfirmed: true }),
  } as unknown as LauncherClient;

  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  const w = setupWorld(app.brain);
  const bundle = fixtureStarter();
  const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  w.brain.activateRelease(w.owner, release.digest);
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, workspaceId = w.workspaceId): Promise<CommandReceipt> => (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId, idempotencyKey: key, payload,
  } as never, key)).receipt;
  const group = options.runnerGroup ?? "sre-host";
  await command("runnerGroup.set", "group", { groupId: group, hostTools: true, workspaceIds: [w.workspaceId] });
  await command("workspace.effects.set", "effects", { containers: options.containers ?? ["demo-app"], services: [] });
  const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
  const cfg: RunnerConfig = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-sre", stateDir: join(root, "runner"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport, launcher };
  const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, group).token);
  const runner = { runnerId: cfg.runnerId, epoch: session.epoch, organizationId: w.org };

  const situation = (calls: Array<{ id: string; input: Record<string, unknown> }>): string =>
    ["Look at the demos containers and restart the unhealthy one", "Acceptance criteria:", "1. Says what was checked", ...calls.map((call) => `FIXTURE_CALL_TOOL ${JSON.stringify(call)}`)].join("\n");
  const WATCH_AND_RESTART: Array<{ id: string; input: Record<string, unknown> }> = [{ id: "host.exec", input: { command: "docker.ps" } }, { id: "host.restart", input: { container: "demo-app" } }];
  const dispatch = (key: string, calls = WATCH_AND_RESTART, extra: { workItemId?: string } = {}) => command("workflow.dispatch", key, { workflow: { id: "sre-task", digest: release.digest }, input: { situation: situation(calls) }, ...extra });
  const store = w.brain.store;
  const pendingApproval = async (): Promise<{ id: string; subject_json: string; subject_digest: string; version: number }> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const row = store.control.prepare("SELECT id, subject_json, subject_digest, version FROM approval_requests WHERE state='pending' ORDER BY created_at_ms DESC LIMIT 1").get() as { id: string; subject_json: string; subject_digest: string; version: number } | undefined;
      if (row) return row;
      if (Date.now() > deadline) throw new Error("no approval was requested");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  let approverCount = 0;
  const decide = async (approval: { id: string; subject_digest: string; version: number }, decision: "approve" | "reject") => {
    const approver = await w.grantApprover(`phone-owner-${++approverCount}`);
    const evidence = decision === "approve" ? await stepUp(w, approver, approval.id, approval.subject_digest) : undefined;
    return w.brain.decideApproval(approver.identity, approval.id, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: `dec-${approval.id}-${decision}`, decision, subjectDigest: approval.subject_digest,
      expectedVersion: approval.version, note: decision === "approve" ? "restart it" : "not now", ...(evidence ? { stepUpEvidenceId: evidence } : {}),
    });
  };
  return {
    root, app, w, release, command, cfg, session, runner, dispatch, decide, pendingApproval, store, socket, group,
    run: () => runOnce(cfg, session.sessionToken, session.epoch),
    /** Runs claimable jobs one after another until the runner finds none: a proposal's held act job after its decision, then the resumed task. */
    drain: async (limit = 10): Promise<number> => { let ran = 0; while (ran < limit && await runOnce(cfg, session.sessionToken, session.epoch)) ran++; return ran; },
    /** Attempts a runner holds right now (a slot and a lease): none while a proposal waits for a person. */
    liveAttempts: () => store.control.prepare("SELECT id FROM job_attempts WHERE state IN ('offered','running','uploading','cancelling')").all() as Array<{ id: string }>,
    slotsReserved: () => (store.control.prepare("SELECT slots_reserved AS n FROM runners WHERE id=?").get(cfg.runnerId) as { n: number }).n,
    jobs: () => store.control.prepare("SELECT id, state, queue_reason, step_id, effect_class, priority FROM jobs ORDER BY rowid").all() as Array<{ id: string; state: string; queue_reason: string | null; step_id: string; effect_class: string; priority: number }>,
    calls: () => store.control.prepare("SELECT proposal_id, approval_id, tool_id, parent_job_id, act_job_id, outcome, settled_at_ms FROM effect_calls ORDER BY rowid").all() as Array<{ proposal_id: string; approval_id: string; tool_id: string; parent_job_id: string; act_job_id: string; outcome: string | null; settled_at_ms: number | null }>,
    restarts: (): string[] => readFileSync(counter, "utf8").split("\n").filter(Boolean),
    launcherToken: () => readFileSync(`${socket}.token`, "utf8").trim(),
    digestOf: (subjectJson: string) => approvalSubjectDigest(JSON.parse(subjectJson) as JsonValue),
    attempts: () => store.control.prepare("SELECT id, state FROM job_attempts ORDER BY rowid").all() as Array<{ id: string; state: string }>,
    permits: () => store.control.prepare("SELECT invocation_id, state, approval_id, receipt_digest FROM effect_permits ORDER BY rowid").all() as Array<{ invocation_id: string; state: string; approval_id: string | null; receipt_digest: string | null }>,
    toolEvents: (attemptId: string) => (store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attemptId) as Array<{ event_json: string }>)
      .map((row) => (JSON.parse(row.event_json) as { payload: { kind?: string; payload: Record<string, unknown> } }).payload).filter((entry) => entry.kind === "tool.proposed" || entry.kind === "tool.result"),
  };
}

export type EffectsWorld = Awaited<ReturnType<typeof effectsWorld>>;
