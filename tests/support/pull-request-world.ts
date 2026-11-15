import { rmSync } from "node:fs";
import { HostedPullRequestApi } from "../../apps/governor/src/modules/integrations/pull-request";
import { effectsWorld, type EffectsWorld } from "./effects-world";
import { createGitHttpBackend } from "./git-http-backend";
import { command } from "./reuse";

export const TOKEN = "pr-record-secret-token-0123456789";
export const PROPOSAL = { id: "git.open-pr", input: { title: "Raise the demo-app memory limit", body: "The container was killed twice today.", branch: "brain/raise-demo-app-memory", files: [{ path: "docs/demo-app/limits.md", content: "memory: 768m\n" }] } };

/**
 * A world whose workspace may open pull requests: a real Git remote, a connection set up as GitHub Enterprise through commands, and a
 * provider whose API is the only stubbed part (what it is asked and answers is what the provider's own API would see).
 */
export async function pullRequestWorld(cleanup: Array<() => Promise<void> | void>): Promise<{ world: EffectsWorld; remote: Awaited<ReturnType<typeof createGitHttpBackend>>; connectionId: string; provider: { state: "open" | "closed"; merged: boolean; calls: string[] } }> {
  const remote = await createGitHttpBackend();
  cleanup.push(() => remote.cleanup());
  const world = await effectsWorld();
  cleanup.push(() => rmSync(world.root, { recursive: true, force: true }));
  const provider = { state: "open" as "open" | "closed", merged: false, calls: [] as string[] };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    provider.calls.push(`${init.method} ${url}`);
    if (init.method === "GET") return new Response(JSON.stringify({ number: 7, state: provider.state, merged: provider.merged }), { status: 200 });
    return new Response(JSON.stringify({ number: 7, html_url: "https://git.example.test/demo/pull/7" }), { status: 201 });
  }) as unknown as typeof fetch;
  world.w.brain.integrations.usePullRequestApi(new HostedPullRequestApi(fetchImpl));
  const connect = async (commandType: string, key: string, payload: Record<string, unknown>, workspace = false) => (await world.w.brain.executeCommand(world.w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, ...(workspace ? { workspaceId: world.w.workspaceId } : {}), idempotencyKey: key, payload,
  } as never, key)).receipt;
  const connectionId = (await connect("integration.connect", "prr-connect", { provider: "github-enterprise", name: "Demo repo", repositoryUrl: remote.remote, username: "brain-bot", token: TOKEN })).resourceId!;
  await world.w.brain.integrations.verifyPending();
  await connect("integration.bind", "prr-bind", { connectionId, workspaceId: world.w.workspaceId, kind: "project", repositoryKey: remote.remote, access: "write" }, true);
  await world.w.brain.integrations.verifyPending();
  return { world, remote, connectionId, provider };
}

/** A confirmed one-task mission; its work item is what a pull request is opened for. */
export async function missionWithTask(world: EffectsWorld): Promise<{ missionId: string; workItemId: string }> {
  const missionId = (await world.command("mission.create", "prr-mission", { title: "Raise the memory limit", intent: "The demo app is killed for memory", successCriteria: ["a pull request is open"] })).resourceId!;
  const planId = (await world.command("plan.propose", "prr-plan", { missionId, origin: "manual", tasks: [{ id: "a", title: "Open the pull request", criteria: ["the request is open"], dependsOn: [] }] })).resourceId!;
  const mission = ((await world.w.brain.executeQuery(world.w.owner, { queryType: "missions.get", workspaceId: world.w.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot;
  await command(world.w, world.w.owner, "plan.confirm", "prr-confirm", { planVersionId: planId }, mission.version);
  const workItemId = (world.store.workspaceDb(world.w.workspaceId, world.w.org).prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
  return { missionId, workItemId };
}
