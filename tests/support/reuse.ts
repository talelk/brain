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
}

/** Drives a real mission to closed/achieved on a verified mission bundle, then runs capitalization. */
export async function achievedMission(w: TestWorld, key: string, options: AchievedOptions): Promise<string> {
  const id = (await command(w, w.owner, "mission.create", `${key}-create`, { title: options.title, intent: options.intent, successCriteria: options.criteria ?? ["delivered"] })).resourceId ?? "";
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
  const bundle = await bundleOf("propose-2");
  await command(w, w.owner, "mission.verdict.record", `${key}-verdict`, { missionId: id, bundleDigest: bundle.digest, outcome: "verified" });
  for (const [index, output] of (options.outputs ?? []).entries()) {
    const bytes = new TextEncoder().encode(output.text);
    const digest = putBytes(w.brain.store, bytes);
    ws.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES (?,?,?,?,?,'verified',?)").run(`art-${key}-${index}`, digest, bytes.length, "text/markdown", "internal", w.brain.store.now());
    ws.prepare("INSERT INTO mission_outputs(id,mission_id,name,created_at_ms) VALUES (?,?,?,?)").run(`out-${key}-${index}`, id, output.name, w.brain.store.now());
    ws.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES (?,?,?,?, 'final', 1, ?)").run(`ver-${key}-${index}`, `out-${key}-${index}`, item.workItemId, digest, w.brain.store.now());
  }
  await command(w, w.owner, "mission.close", `${key}-close`, { missionId: id, outcome: "achieved" }, (await getMission(w, id)).version);
  w.brain.runCapitalization();
  return id;
}

export async function reuseSearch(w: TestWorld, text: string, missionId?: string, actor: ActorContext = w.owner): Promise<ReuseItem[]> {
  const response = (await w.brain.executeQuery(actor, { queryType: "reuse.search", workspaceId: w.workspaceId, search: text, ...(missionId ? { resourceId: missionId } : {}) })) as unknown as { snapshot: { items: ReuseItem[] } };
  return response.snapshot.items;
}
