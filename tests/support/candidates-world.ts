import type { ActorContext, JsonValue, Mission, TeamMember, WorkItem } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import { DIGEST_A } from "../helpers";
import { fixtureStarter } from "./starter";

// A mission whose one task runs as best-of-N candidates (#127, ADR 0071), made through commands, with each candidate's run finished and
// judged the way the runner protocol would: its one step reports a written result (or fails) and its evaluator's verdict row names its run.
// Shared by the integration, browser and visual-baseline specs so all look at the same data.

export const CANDIDATE_TEAM: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "reviewer", role: "Reviewer", agentId: "operations-assistant", engine: "fixture" },
];
export const CANDIDATES = [{ id: "c1", memberId: "writer" }, { id: "c2", memberId: "reviewer" }, { id: "c3", workflowId: "general-single-b" }];

/** Activates the starter release plus two single-step copies of the general task workflow, so a candidate's run can finish by itself. */
export function stageSingleStepWorkflows(brain: Brain, actor: ActorContext): void {
  try { brain.loadWorkflow(actor.organizationId, "general-single-b"); return; } catch { /* not staged yet */ }
  const bundle = fixtureStarter();
  const source = bundle.documents.find((doc) => doc.path.endsWith("general-task.yaml"))!;
  for (const id of ["general-single", "general-single-b"]) {
    const workflow = JSON.parse(source.text);
    workflow.metadata.id = id;
    workflow.spec.presentation.title = id === "general-single" ? "Single pass" : "Second opinion";
    delete workflow.spec.jobs["validate"];
    workflow.spec.outputs["passed"] = { source: "literal", value: true };
    bundle.documents.push({ path: `config/${id}.yaml`, text: JSON.stringify(workflow, null, 2) + "\n" });
  }
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
}

async function command(brain: Brain, actor: ActorContext, workspaceId: string, type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) {
  return (await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
}

/** A confirmed one-task mission; its candidates start by themselves when `autoStart` is true. */
export async function seedCandidateMission(brain: Brain, actor: ActorContext, workspaceId: string, input: { key: string; title: string; autoStart: boolean; candidates?: boolean }): Promise<{ missionId: string; workItemId: string }> {
  const missionId = (await command(brain, actor, workspaceId, "mission.create", `${input.key}-create`, { title: input.title, intent: input.title, successCriteria: ["The brief is written"], autoStart: input.autoStart })).resourceId ?? "";
  const task = { id: "brief", title: "Write the one-page brief", criteria: ["The brief is written up"], dependsOn: [], workflowId: "general-single", assignment: { kind: "agent", id: "writer", role: "specialist" }, ...(input.candidates === false ? {} : { candidates: CANDIDATES }) };
  const planId = (await command(brain, actor, workspaceId, "plan.propose", `${input.key}-plan`, { missionId, origin: "manual", tasks: [task], team: CANDIDATE_TEAM })).resourceId ?? "";
  const version = ((await brain.executeQuery(actor, { queryType: "missions.get", workspaceId, resourceId: missionId } as never)) as unknown as { snapshot: Mission }).snapshot.version;
  await command(brain, actor, workspaceId, "plan.confirm", `${input.key}-confirm`, { planVersionId: planId }, version);
  const workItemId = (brain.store.workspaceDb(workspaceId, actor.organizationId).prepare("SELECT id FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY rowid DESC LIMIT 1").get(missionId) as { id: string }).id;
  return { missionId, workItemId };
}

export const itemOf = async (brain: Brain, actor: ActorContext, workspaceId: string, workItemId: string): Promise<WorkItem> =>
  ((await brain.executeQuery(actor, { queryType: "workItems.get", workspaceId, resourceId: workItemId } as never)) as unknown as { snapshot: WorkItem }).snapshot;

/** The run of one candidate of the task's latest round. */
export function runOfCandidate(brain: Brain, actor: ActorContext, workspaceId: string, workItemId: string, candidateId: string): string {
  return (brain.store.workspaceDb(workspaceId, actor.organizationId).prepare("SELECT run_id FROM execution_links WHERE work_item_id=? AND candidate_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(workItemId, candidateId) as { run_id: string }).run_id;
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) { if (Date.now() > deadline) throw new Error(`not reached in time: ${what}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

/** A candidate's run reaches its end: its one step reports a written result, or fails. */
export async function finishCandidateRun(brain: Brain, actor: ActorContext, workspaceId: string, runId: string, result: { title: string } | "fail"): Promise<void> {
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  await until(() => Boolean(brain.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(runId)), "the respond job exists");
  const output = result === "fail" ? { error: "the model used its whole output limit" } : {
    summary: `${result.title} is ready.`,
    deliverable: `# ${result.title}\n\n## Findings\n\n${`The brief weighs the options and ${result.title} recommends one for stated reasons. `.repeat(3)}\n\n## Assumptions\n\nNone beyond the request.`,
    criteria: [{ criterion: "The brief is written up", met: true, evidence: "The Findings section covers it." }], assumptions: [],
  };
  brain.workflows.completeStep(actor.organizationId, workspaceId, runId, "respond", output as unknown as JsonValue, result !== "fail");
  await until(() => ["succeeded", "failed"].includes((ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state), "the run ends");
}

/** What a candidate's own evaluator step produced: a bundle of its run and the verdict on it. Returns the bundle's digest. */
export function seedCandidateVerdict(brain: Brain, actor: ActorContext, workspaceId: string, runId: string, outcome: "verified" | "rejected", tag: string): string {
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  const digest = `sha256:${tag.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/gu, "a")}`;
  const job = brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=?").get(runId) as { id: string };
  const manifest = {
    contractVersion: "brain.evidence/v1", bundleId: `bundle-${tag}`, organizationId: actor.organizationId, workspaceId, workflowRunId: runId, jobId: job.id, attemptId: `att-${tag}`, jobFence: 1,
    sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [], artifacts: [],
    checks: ["structure", "safety", "deliverable", "criteria-met"].map((id) => ({ criterionId: id, checkId: id, status: outcome === "verified" ? "passed" : "failed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" })),
    approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  };
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(digest, manifest.bundleId, job.id, manifest.attemptId, outcome === "verified" ? "verified" : "rejected", JSON.stringify(manifest), brain.store.now());
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(`verdict-${tag}`, digest, `eval-${tag}`, DIGEST_A, outcome, JSON.stringify({ checks: [], acceptedBy: "seed" }), brain.store.now());
  return digest;
}

/** Candidates one and two finish with a written brief and the third fails; only the first is verified, so Brain suggests it. */
export async function finishCandidates(brain: Brain, actor: ActorContext, workspaceId: string, workItemId: string): Promise<{ verifiedDigest: string; rejectedDigest: string }> {
  const run = (candidate: string) => runOfCandidate(brain, actor, workspaceId, workItemId, candidate);
  await finishCandidateRun(brain, actor, workspaceId, run("c1"), { title: "Writer's brief" });
  await finishCandidateRun(brain, actor, workspaceId, run("c2"), { title: "Reviewer's brief" });
  await finishCandidateRun(brain, actor, workspaceId, run("c3"), "fail");
  return { verifiedDigest: seedCandidateVerdict(brain, actor, workspaceId, run("c1"), "verified", "aa11"), rejectedDigest: seedCandidateVerdict(brain, actor, workspaceId, run("c2"), "rejected", "bb22") };
}

/** Makes the candidates' times steady (42 s, 1 min 5 s and 3 min), so a screenshot of them does not change from run to run. */
export function steadyDurations(brain: Brain, actor: ActorContext, workspaceId: string, workItemId: string): void {
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  for (const [candidate, ms] of [["c1", 42_000], ["c2", 65_000], ["c3", 180_000]] as const) ws.prepare("UPDATE execution_links SET finished_at_ms=created_at_ms+? WHERE work_item_id=? AND candidate_id=?").run(ms, workItemId, candidate);
}
