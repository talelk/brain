import type { ActorContext, CommandReceipt, Mission, PlanTask, ReuseItem, WorkItem } from "@brain/contracts";
import { putBytes } from "../../apps/governor/src/modules/artifacts/index";
import { workView, type TestWorld } from "../helpers";

export async function command(w: TestWorld, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}

export const getMission = async (w: TestWorld, id: string): Promise<Mission> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: Mission }).snapshot;

export interface AchievedOptions {
  title: string;
  intent: string;
  criteria?: string[];
  /** A rejected verdict (with these findings) comes first, then the fix is verified. */
  rejectedFindings?: string[];
  outputs?: Array<{ name: string; text: string }>;
  decision?: string;
  hostileNote?: string;
  /** What the worker reported (the task-output shape). Defaults to a substantial report so the mission clears the write-up threshold. */
  report?: { summary: string; deliverable: string; criteria?: Array<{ criterion: string; met: boolean; evidence: string }>; assumptions?: string[] } | null;
  /** The workspace setting. The helper turns auto-publish off unless asked, so the Review inbox flows stay deterministic. */
  autoPublish?: boolean;
  /** Close the mission the way a hands-off install does: the Governor itself proposes completion, records the verified verdict and closes it (no person acts). */
  handsOff?: boolean;
  /** Reuse items (`mission:<id>`) the mission keeps before it is planned. */
  reuse?: string[];
}

const DEFAULT_BODY = "The work was done in full and checked against every criterion. The result names the findings, explains the evidence behind each one and lists what to do next, so a later mission can start from it instead of from nothing.";

/** Drives a real mission to closed/achieved on a verified mission bundle, then runs capitalization. */
export async function achievedMission(w: TestWorld, key: string, options: AchievedOptions): Promise<string> {
  await command(w, w.owner, "library.settings.set", `${key}-setting`, { autoPublishKnowledge: options.autoPublish === true });
  const id = (await command(w, w.owner, "mission.create", `${key}-create`, { title: options.title, intent: options.intent, successCriteria: options.criteria ?? ["delivered"] })).resourceId ?? "";
  for (const [index, itemRef] of (options.reuse ?? []).entries()) await command(w, w.owner, "mission.reuse.decide", `${key}-reuse-${index}`, { missionId: id, itemRef, decision: "keep" });
  const task: PlanTask = { id: "only", title: `Do ${options.title}`, criteria: ["only-done"], dependsOn: [] };
  const planId = (await command(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [task] })).resourceId ?? "";
  await command(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await getMission(w, id)).version);
  const item = (await workView(w)).items.find((entry: WorkItem) => entry.missionId === id) as WorkItem;
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  if (options.hostileNote) {
    await command(w, { ...w.owner, kind: "agent" }, "handoff.submit", `${key}-handoff`, { workItemId: item.workItemId, notes: { summary: options.hostileNote } });
    await command(w, w.owner, "mission.message.send", `${key}-msg`, { missionId: id, recipient: { kind: "mission" }, body: options.hostileNote });
  }
  if (options.decision) {
    const brief = (await w.brain.executeQuery(w.owner, { queryType: "missions.brief", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } };
    await command(w, w.owner, "decision.accept", `${key}-decision`, { missionId: id, baseVersion: brief.snapshot.version, statement: options.decision, source: { kind: "human" } });
  }
  if (options.report !== null) {
    const report = options.report ?? { summary: `Finished ${options.title}. ${DEFAULT_BODY}`, deliverable: `# ${options.title}\n\n${DEFAULT_BODY}` };
    const runId = `run-${key}`;
    ws.prepare("INSERT INTO workflow_runs(id,execution_key,config_digest,workflow_digest,adapter_digest,engine_run_id,state,input_digest,created_at_ms) VALUES (?,?,?,?,?,?,'succeeded',?,?)")
      .run(runId, `exec-${key}`, `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`, `engine-${key}`, `sha256:${"4".repeat(64)}`, w.brain.store.now());
    ws.prepare("INSERT INTO execution_links(mission_id,work_item_id,run_id,created_at_ms) VALUES (?,?,?,?)").run(id, item.workItemId, runId, w.brain.store.now());
    ws.prepare("INSERT INTO step_outputs(run_id,step_id,output_json) VALUES (?,?,?)").run(runId, "respond", JSON.stringify({ criteria: [], assumptions: [], ...report }));
  }
  const evidence = `sha256:${"9".repeat(64)}`;
  ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(evidence, item.workItemId);
  const bundleOf = async (step: string): Promise<{ digest: string }> => {
    await command(w, w.owner, "mission.proposeCompletion", `${key}-${step}`, { missionId: id }, (await getMission(w, id)).version);
    return ((await w.brain.executeQuery(w.owner, { queryType: "missionBundles.latest", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { digest: string } }).snapshot;
  };
  if (options.rejectedFindings) {
    const first = await bundleOf("propose-1");
    await command(w, w.owner, "mission.verdict.record", `${key}-reject`, { missionId: id, bundleDigest: first.digest, outcome: "rejected", findings: options.rejectedFindings });
    ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"8".repeat(64)}`, item.workItemId);
  }
  if (options.handsOff) {
    for (const [index, output] of (options.outputs ?? []).entries()) insertOutput(w, ws, key, index, output, item.workItemId, id);
    w.brain.missions.completeFinishedMissions(w.org, w.workspaceId);
    w.brain.runCapitalization();
    return id;
  }
  const bundle = await bundleOf("propose-2");
  await command(w, w.owner, "mission.verdict.record", `${key}-verdict`, { missionId: id, bundleDigest: bundle.digest, outcome: "verified" });
  for (const [index, output] of (options.outputs ?? []).entries()) insertOutput(w, ws, key, index, output, item.workItemId, id);
  await command(w, w.owner, "mission.close", `${key}-close`, { missionId: id, outcome: "achieved" }, (await getMission(w, id)).version);
  w.brain.runCapitalization();
  return id;
}

export async function reuseSearch(w: TestWorld, text: string, missionId?: string, actor: ActorContext = w.owner): Promise<ReuseItem[]> {
  const response = (await w.brain.executeQuery(actor, { queryType: "reuse.search", workspaceId: w.workspaceId, search: text, ...(missionId ? { resourceId: missionId } : {}) })) as unknown as { snapshot: { items: ReuseItem[] } };
  return response.snapshot.items;
}

function insertOutput(w: TestWorld, ws: ReturnType<TestWorld["brain"]["store"]["workspaceDb"]>, key: string, index: number, output: { name: string; text: string }, workItemId: string, missionId: string): void {
  const bytes = new TextEncoder().encode(output.text);
  const digest = putBytes(w.brain.store, bytes);
  ws.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES (?,?,?,?,?,'verified',?)").run(`art-${key}-${index}`, digest, bytes.length, "text/markdown", "internal", w.brain.store.now());
  ws.prepare("INSERT INTO mission_outputs(id,mission_id,name,created_at_ms) VALUES (?,?,?,?)").run(`out-${key}-${index}`, missionId, output.name, w.brain.store.now());
  ws.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES (?,?,?,?, 'final', 1, ?)").run(`ver-${key}-${index}`, `out-${key}-${index}`, workItemId, digest, w.brain.store.now());
}
