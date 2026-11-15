import type { ActorContext } from "@brain/contracts";
import { DIGEST_A, workView, type TestWorld } from "../helpers";
import { ownBundleJob } from "./evidence";
import { command } from "./reuse";

export interface SeededCheck { readonly criterionId: string; readonly checkId: string; readonly status: "passed" | "failed" }

/**
 * Finishes a confirmed plan task the way a person does: start (unless a run already did), review, then Done on verified evidence of its own run, through commands.
 * The one exception is the evidence itself: a verified bundle and its accepted verdict are seeded as rows, because producing them needs a
 * real run on a runner (the browser specs walk that). `checks` are what the seeded evaluator reported; by default one check that names
 * the task's own criterion, as a workflow's checks do not name a mission's success criteria. `summary` is what the handoff says (default: "<task> finished").
 */
export async function finishTask(w: TestWorld, missionId: string, taskId: string, digestChar: string, checks?: readonly SeededCheck[], summary?: string): Promise<void> {
  const current = async () => (await workView(w)).items.find((entry) => entry.missionId === missionId && entry.planTaskId === taskId && entry.state !== "abandoned")!;
  const agent: ActorContext = { ...w.owner, kind: "agent" };
  const digest = `sha256:${digestChar.repeat(64)}`;
  if ((await current()).state !== "in-progress") await command(w, w.owner, "workItem.transition", `${missionId}-${taskId}-start`, { workItemId: (await current()).workItemId, state: "in-progress" }, (await current()).version);
  await command(w, w.owner, "workItem.transition", `${missionId}-${taskId}-review`, { workItemId: (await current()).workItemId, state: "review" }, (await current()).version);
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const reported = (checks ?? [{ criterionId: `${taskId}-done`, checkId: `c-${taskId}`, status: "passed" as const }]).map((check) => ({ ...check, oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" }));
  const manifest = { contractVersion: "brain.evidence/v1", bundleId: `bundle-${digestChar}`, organizationId: w.org, workspaceId: w.workspaceId, workflowRunId: "run-seed", jobId: `job-${digestChar}`, attemptId: "att-seed", jobFence: 1, sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [], artifacts: [], checks: reported, approvalIds: [], effects: [], createdAt: new Date().toISOString() };
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run(digest, manifest.bundleId, manifest.jobId, "att-seed", JSON.stringify(manifest), w.brain.store.now());
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run(`verdict-${digestChar}`, digest, "eval-seed", DIGEST_A, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
  ownBundleJob(ws, (await current()).workItemId, manifest.jobId, w.brain.store.now());
  await command(w, agent, "handoff.submit", `${missionId}-${taskId}-handoff`, { workItemId: (await current()).workItemId, notes: { summary: summary ?? `${taskId} finished` } });
  const done = await command(w, w.owner, "workItem.transition", `${missionId}-${taskId}-done`, { workItemId: (await current()).workItemId, state: "done", evidenceDigest: digest }, (await current()).version);
  if (!done.accepted) throw new Error(`task ${taskId} did not reach Done: ${JSON.stringify(done.error)}`);
}
