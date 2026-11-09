import type { Page } from "@playwright/test";
import type { Brain } from "../../apps/governor/src/application/brain";
import { fixtureStarter } from "./starter";
import { seedDemoWorkspace, type DemoSeed } from "./seedDemoWorkspace";

export interface BrowserDemo { workspaceId: string; seed: DemoSeed; seededAtMs: number }

/**
 * A signed-in browser session over a realistically seeded "operations" workspace (missions in every
 * state, a pending approval, a runner, a ticket, an incident, a document and one dispatched run with a
 * session), built with `seedDemoWorkspace` on the fixture starter release. Shared by the accessibility
 * and visual-baseline specs so both look at the same data.
 */
export async function seedBrowserDemo(page: Page, governor: { url: string; credential: string; app: { brain: Brain } }): Promise<BrowserDemo> {
  const brain = governor.app.brain;
  const response = await page.request.post(`${governor.url}/v1/setup`, { headers: { authorization: `Setup ${governor.credential}` }, data: { email: "demo@example.test", password: "demo-password-12345", name: "Demo Operator", organizationId: "org-demo" } });
  if (response.status() !== 201) throw new Error(`demo setup failed with ${response.status()}`);
  const boot = await response.json() as { sessionToken: string };
  const headers = new Headers({ authorization: `Bearer ${boot.sessionToken}` });
  brain.createWorkspace((await brain.resolveActor(headers)).actor, { workspaceId: "operations", slug: "Operations" });
  const actor = (await brain.resolveActor(headers, "operations")).actor;
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  for (const role of ["operator", "approver"]) brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES ('operations',?,?,?,1,?,?)").run(actor.organizationId, actor.actorId, role, actor.actorId, brain.store.now());
  const seededAtMs = brain.store.now();
  const seed = await seedDemoWorkspace(brain, actor, "operations", { dispatch: { workflowId: "operations-triage", input: { situation: "Sign-in latency regression" } } });
  return { workspaceId: "operations", seed, seededAtMs };
}
