import { join } from "node:path";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ActorContext } from "@brain/contracts";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import type { Brain } from "../../apps/governor/src/application/brain";

/** Shared pieces of the browser specs that drive a whole mission on the fixture engine with real runners. */
export interface GovernorFixture { url: string; credential: string; app: { brain: Brain } }
export interface RunnerSession { cfg: Parameters<typeof runOnce>[0]; sessionToken: string; epoch: number }

/** First-run setup through the real form: the owner exists and the workspace page is up. Returns the owner's actor. */
export async function signUpOwner(page: Page, governor: GovernorFixture, label: string): Promise<{ brain: Brain; actor: ActorContext; cookie: string }> {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill(`${label} organization`);
  await page.getByLabel(/^Email/).fill(`${label}@example.test`);
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await governor.app.brain.resolveActor(new Headers({ cookie }))).actor;
  return { brain: governor.app.brain, actor, cookie };
}

/** Enrolls one fixture runner per group (agents, evaluators) the way an installed machine would. */
export async function enrollRunners(governor: GovernorFixture, actor: ActorContext, prefix: string, groups: readonly string[] = ["agents", "evaluators"]): Promise<RunnerSession[]> {
  const brain = governor.app.brain;
  const sessions: RunnerSession[] = [];
  for (const group of groups) {
    const cfg = { governorUrl: governor.url, runnerId: `${prefix}-${group}`, stateDir: join(brain.store.dataDir, `${prefix}-${group}`), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const hello = await enrollAndHello(cfg, brain.jobProtocol.issueEnrollment(actor, group).token);
    sessions.push({ cfg, sessionToken: hello.sessionToken, epoch: hello.epoch });
  }
  return sessions;
}

/** Lets the runners claim and finish every job until the condition holds. */
export async function driveRuns(sessions: readonly RunnerSession[], until: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!until()) {
    if (Date.now() > deadline) throw new Error("runners did not finish the run in time");
    let worked = false;
    for (const session of sessions) worked = (await runOnce(session.cfg, session.sessionToken, session.epoch)) || worked;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
