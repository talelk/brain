import { test, expect } from "./fixtures";
import type { PlanTask, TeamMember } from "@brain/contracts";
import { driveRuns, enrollRunners, signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";

// A first-time user finds where a mission's usage went (#111, ADR 0051): the mission's Usage section opens a breakdown by team member, agent,
// engine and model, each adding up to the mission total, and the run inspector names who each attempt belonged to. The work is done by real
// fixture runners; the person only reads.
const team: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "reviewer", role: "Reviewer", agentId: "operations-assistant", engine: "fixture" },
];

test("usage breakdown: where a mission's usage went, by member, agent, engine and model", async ({ page, governor }) => {
  test.setTimeout(150_000);
  const saved = process.env["BRAIN_LOCAL_MODEL_ID"];
  process.env["BRAIN_LOCAL_MODEL_ID"] = "qwen-local-demo";
  try {
    const { brain, actor, cookie } = await signUpOwner(page, governor, "breakdown");
    brain.createWorkspace(actor, { workspaceId: "ws-attr", slug: "attr" });
    const bundle = fixtureStarter();
    brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
    const ws = (await brain.resolveActor(new Headers({ cookie }), "ws-attr")).actor;
    const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-attr", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
    } as never, key)).receipt;
    const tasks: PlanTask[] = [
      { id: "write", title: "Write the draft", criteria: ["written"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } },
      { id: "review", title: "Review the draft", criteria: ["reviewed"], dependsOn: [], assignment: { kind: "agent", id: "reviewer", role: "specialist" }, workflowId: "operations-triage" },
    ];
    const missionId = (await command("mission.create", "b-create", { title: "Draft and review", intent: "Draft and review", successCriteria: ["done"] })).resourceId ?? "";
    const planId = (await command("plan.propose", "b-plan", { missionId, origin: "manual", tasks, team })).resourceId ?? "";
    await command("plan.confirm", "b-confirm", { planVersionId: planId }, 1);
    const sessions = await enrollRunners(governor, actor, "breakdown");
    const open = () => brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id='ws-attr' AND state IN ('queued','offered','running')").get() as { n: number };
    const total = () => brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id='ws-attr'").get() as { n: number };
    await driveRuns(sessions, () => total().n >= 2 && open().n === 0, 120_000);
    // Reading the usage settles the attempts whose runners have released their capacity.
    const seen = ((await brain.executeQuery(ws, { queryType: "usage.mission", workspaceId: "ws-attr", resourceId: missionId })) as unknown as { snapshot: { usage: { attempts: number } } }).snapshot.usage;
    expect(seen.attempts).toBeGreaterThanOrEqual(2);

    await page.goto(`${governor.url}/w/ws-attr/missions`);
    // The work finished, so the mission is closed and listed under Closed missions.
    await page.getByText(/^Closed missions \(/).click();
    await page.getByRole("button", { name: "Open mission Draft and review" }).click();
    await expect(page.getByTestId("mission-usage")).toBeVisible({ timeout: 20_000 });
    const panel = page.getByTestId("usage-breakdown");
    await panel.getByText("Where the usage went", { exact: true }).click();
    const byMember = panel.getByTestId("usage-by-member");
    await expect(byMember).toContainText("Writer (writer)");
    await expect(byMember).toContainText("Reviewer (reviewer)");
    await expect(panel.getByTestId("usage-by-agent")).toContainText("task-worker");
    await expect(panel.getByTestId("usage-by-agent")).toContainText("operations-assistant");
    await expect(panel.getByTestId("usage-by-engine")).toContainText("fixture");
    await expect(panel.getByTestId("usage-by-model")).toContainText("qwen-local-demo");
    // The evaluator that checked the work reported no model: said so, not guessed.
    await expect(panel.getByTestId("usage-by-model")).toContainText("Not reported");

    // The run inspector names who each attempt belonged to.
    const job = brain.store.control.prepare("SELECT j.id AS id FROM jobs j JOIN job_attempts a ON a.job_id=j.id WHERE j.workspace_id='ws-attr' AND a.reported_engine IS NOT NULL ORDER BY j.created_at_ms LIMIT 1").get() as { id: string };
    await page.goto(`${governor.url}/runs/${job.id}`);
    const who = page.getByTestId("run-usage-who").first();
    await expect(who).toBeVisible({ timeout: 20_000 });
    await expect(who).toContainText("engine fixture");
    await expect(who).toContainText("model qwen-local-demo");
    await expect(who).toContainText(/member (writer|reviewer)/);
  } finally {
    if (saved === undefined) delete process.env["BRAIN_LOCAL_MODEL_ID"]; else process.env["BRAIN_LOCAL_MODEL_ID"] = saved;
  }
});
