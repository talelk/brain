import type { ActorContext } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import { enrollRunners, type GovernorFixture } from "./flow";

/**
 * A run whose Why tab has every kind of choice behind it (ticket #144), made through commands and the runner protocol: a task given to a team member,
 * started by auto-start on the general way of working, and a second attempt (after a model slip) that a runner took with the workspace's model routes
 * offered in order. The first route is out of quota, so the offer says which route was left out and why.
 */
export async function seedWhyRun(governor: GovernorFixture, actor: ActorContext, workspaceId: string, key: string): Promise<{ jobId: string; runId: string; missionId: string }> {
  const brain: Brain = governor.app.brain;
  const cmd = async (type: string, id: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}-${id}`, commandType: type, workspaceId, idempotencyKey: `${key}-${id}`, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, `${key}-${id}`)).receipt;
  const route = (routeId: string, extra: Record<string, unknown>) => ({ routeId, enabled: true, vendor: "Acme", keyRef: `${routeId}-key`, model: `${routeId}-large`, baseUrl: `https://${routeId}.acme.example/v1`, costTier: "standard", inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000, ...extra });
  await cmd("workspace.modelRoutes.set", "routes", { routes: [route("quota-out", {}), route("primary", {}), route("backup", { costTier: "low", enabled: false, inputMicroUsdPerMTok: 50_000, outputMicroUsdPerMTok: 200_000 })] });
  const team = [{ memberId: "researcher", role: "Researcher", agentId: "task-worker", engine: "fixture" }, { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }];
  const missionId = (await cmd("mission.create", "create", { title: "Compare three venues", intent: "Compare venues for the offsite", successCriteria: ["Three venues are compared"] })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "plan", { missionId, origin: "manual", team, tasks: [{ id: "compare", title: "Compare the venues", criteria: ["Venues compared"], dependsOn: [], assignment: { kind: "agent", id: "researcher", role: "specialist" } }] })).resourceId ?? "";
  const version = ((await brain.executeQuery(actor, { queryType: "missions.get", workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await cmd("plan.confirm", "confirm", { planVersionId: planId }, version);
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  const link = async () => ws.prepare("SELECT l.run_id AS runId, l.work_item_id AS workItemId FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE w.mission_id=?").get(missionId) as { runId: string; workItemId: string } | undefined;
  for (let waited = 0; !(await link()) && waited < 20_000; waited += 100) { await brain.autoStart.sweepAll(); await new Promise((resolve) => setTimeout(resolve, 100)); }
  const started = (await link())!;
  // Other queued jobs of a shared demo wait out the hour while the runner below takes this one, so it is offered this run's job and no other.
  const aside = (brain.store.control.prepare("SELECT id FROM jobs WHERE state='queued' AND workflow_run_id<>?").all(started.runId) as Array<{ id: string }>).map((row) => row.id);
  const shift = (ms: number) => { for (const id of aside) brain.store.control.prepare("UPDATE jobs SET ready_at_ms=ready_at_ms+? WHERE id=?").run(ms, id); };
  shift(3_600_000);
  // The first attempt failed as a model slip, so the next one is the second attempt, which may use the hosted routes.
  ws.prepare("UPDATE work_items SET failed_attempts=1, failure_class='model-slip' WHERE id=?").run(started.workItemId);
  // The first route's account ran out of quota on an earlier job, so this job is offered the routes behind it.
  brain.store.control.prepare("INSERT INTO model_route_cooldowns(workspace_id,route_id,until_ms,reason) VALUES (?,?,?,?)").run(workspaceId, "quota-out", brain.store.now() + 3_600_000, "the provider refused for quota or rate");
  const [session] = await enrollRunners(governor, actor, key, ["agents"]);
  const runner = { runnerId: session!.cfg.runnerId, epoch: session!.epoch, organizationId: actor.organizationId };
  let offer: { jobId: string };
  try { offer = brain.jobProtocol.claim(runner, `req-${key}`) as unknown as { jobId: string }; } finally { shift(-3_600_000); }
  const owner = brain.store.control.prepare("SELECT workflow_run_id AS runId FROM jobs WHERE id=?").get(offer.jobId) as { runId: string } | undefined;
  if (owner?.runId !== started.runId) throw new Error(`the runner was offered another run's job (${offer.jobId}), not the one seeded for ${started.runId}: ${JSON.stringify(brain.store.control.prepare("SELECT id, workspace_id, workflow_run_id, priority, state FROM jobs").all())}`);
  return { jobId: offer.jobId, runId: started.runId, missionId };
}
