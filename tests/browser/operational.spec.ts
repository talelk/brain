import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { join } from "node:path";

test.use({ requireTwoFactor: false, integrationUrls: true });

test("optional-factor operator inspects a release, activates it, dispatches both starter workflows, and reads evidence", async ({ page, governor }, info) => {
  const capture = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  const errors: string[] = []; page.on("pageerror",(error) => errors.push(error.message));
  const brain = governor.app.brain;
  const boot = await brain.bootstrap({ organizationId: "org-ui-ops", name: "Operations", email: "operator@example.test", password: "operator-password-123" }, governor.credential);
  const { actor } = await brain.resolveActor(new Headers({ authorization: `Bearer ${boot.sessionToken}` }));
  brain.createWorkspace(actor,{workspaceId:"operations",slug:"operations"});
  const bundle = fixtureStarter();
  const { digest } = brain.stageRelease(actor,bundle.documents,bundle.sourceRevision,bundle.scripts,bundle.instructions,bundle.schemas);
  await page.goto(governor.url);
  await page.getByLabel(/^Email/).fill("operator@example.test");
  await page.getByLabel(/^Password/).fill("operator-password-123");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Today",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Authenticator setup"})).toHaveCount(0);
  await capture("today");
  await page.goto(`${governor.url}/settings`);
  await expect(page.getByRole("heading",{name:"Security",exact:true})).toBeVisible();
  await capture("settings-security");
  await page.goto(`${governor.url}/settings?tab=people`);
  await expect(page.getByRole("heading",{name:"People",exact:true})).toBeVisible();
  await expect(page.getByText("operator@example.test",{exact:true}).locator("visible=true").first()).toBeVisible();
  await page.goto(`${governor.url}/settings?tab=invitations`);
  await expect(page.getByRole("heading",{name:"Invitations",exact:true})).toBeVisible();
  await page.goto(`${governor.url}/settings?tab=policy`);
  await expect(page.getByRole("heading",{name:"Authentication policy",exact:true})).toBeVisible();
  await expect(page.getByText("Enabled · sign-in only",{exact:true})).toBeVisible();
  await page.goto(`${governor.url}/w/operations/knowledge`);
  await expect(page.getByRole("link",{name:"Open Memory UI"})).toHaveAttribute("href","https://memory.example.test/");
  await expect(page.getByRole("link",{name:"Open Memory UI"})).toHaveAttribute("rel","noopener noreferrer");
  await capture("knowledge");
  await page.goto(`${governor.url}/settings?tab=release`);
  await expect(page.getByLabel("Staged release",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Inspect selected release",exact:true}).click();
  await expect(page.getByText(/operations-assistant/).first()).toBeVisible();
  await capture("settings-release");
  await page.getByRole("button",{name:"Activate inspected release",exact:true}).click();
  await expect.poll(() => brain.activeRelease(actor.organizationId)?.digest).toBe(digest);
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search Brain",{exact:true}).fill("operations-triage");
  await expect(page.getByRole("option",{name:/operations triage/i}).first()).toBeVisible();
  await capture("global-search");
  await page.getByRole("option",{name:/operations triage/i}).first().click();
  await expect(page).toHaveURL(/\/w\/operations\/workflows\?selected=operations-triage/);
  const cfg = (group:string) => ({ governorUrl:governor.url,runnerId:`runner-ui-${group}`,stateDir:join(brain.store.dataDir,`runner-${group}`),engines:["fixture"],capabilities:["os:linux","tool:bash","tool:python3","isolation:ephemeral-container"] });
  const author=cfg("agents"),evaluator=cfg("evaluators");
  const authorSession=await enrollAndHello(author,brain.issueEnrollment(actor,"agents").token);
  const evalSession=await enrollAndHello(evaluator,brain.issueEnrollment(actor,"evaluators").token);
  for (const id of ["operations-triage","support-draft"]) {
    await page.goto(`${governor.url}/w/operations/workflows`);
    await page.getByRole("region",{name:"Workflows",exact:true}).getByRole("button",{name:`Start task: ${id}`,exact:true}).click();
    if (id === "operations-triage") await page.getByLabel(/^Situation/).fill("Latency increased after deployment");
    else { await page.getByLabel(/^Title/).fill("Session expired"); await page.getByLabel(/^Body/).fill("I cannot sign in"); }
    await capture(`workflow-${id}`);
    await page.getByRole("button",{name:"Review task",exact:true}).click();
    await page.getByRole("heading",{name:"Review before starting",exact:true}).locator("..").getByRole("button",{name:"Start task",exact:true}).click();
    await page.waitForURL(/\/jobs\//);
    expect(await runOnce(author,authorSession.sessionToken,authorSession.epoch)).toBe(true);
    expect(await runOnce(evaluator,evalSession.sessionToken,evalSession.epoch)).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading",{name:"Structured output",exact:true})).toBeVisible();
    await expect(page.getByText(/Fixture:/).first()).toBeVisible();
    await page.getByRole("radio",{name:"Evidence",exact:true}).click();
    await expect(page.getByText("Independent verdict: verified",{exact:true})).toBeVisible();
    await capture(`run-${id}`);
  }
  await page.goto(`${governor.url}/w/operations/runs`);
  await capture("runs");
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES ('operations',?,?,'approver',1,?,?)").run(actor.organizationId,actor.actorId,actor.actorId,Date.now());
  brain.ensurePrincipal(actor.organizationId,"ui-independent-requester","human");
  for (const decision of ["approve","reject","request-changes"] as const) {
    const digest=`sha256:${"a".repeat(64)}`;
    const subject={organizationId:actor.organizationId,workspaceId:"operations",operation:"diagnostic.review",tool:{id:"operations.validate",digest},inputDigest:digest,target:{targetId:"diagnostic",environmentId:"local",preconditionDigest:digest},artifactDigest:digest,policyDigest:digest,configDigest:releaseDigest(brain,actor.organizationId),effectBounds:{},expiresAt:new Date(Date.now()+3600000).toISOString(),nonce:`ui-${decision}`};
    const approvalId=brain.createApprovalForGate({organizationId:actor.organizationId,workspaceId:"operations",runId:"ui-review",stepId:decision,subject,expiresAtMs:Date.now()+3600000,requestedBy:"ui-independent-requester"});
    await page.goto(`${governor.url}/approvals/${approvalId}`);
    await expect(page.getByText("One-use evidence bound to this session and the exact subject digest.",{exact:true})).toBeVisible();
    await capture(`approval-${decision}`);
    await page.getByRole("button",{name:"Review action",exact:true}).click();
    await page.getByLabel(/^Decision note/).fill(`Operator chose ${decision}`);
    await expect(page.getByLabel(/^Authenticator code/)).toHaveCount(0);
    await page.getByRole("button",{name:decision==="approve"?"Approve exact action":decision==="reject"?"Reject":"Request changes",exact:true}).click();
    await expect(page.getByText(/Decision recorded/)).toBeVisible();
    expect(brain.store.control.prepare("SELECT decision FROM approval_decisions WHERE approval_id=?").get(approvalId)).toEqual({decision});
  }
  const boardSeed = Date.now();
  const boardWs = brain.store.workspaceDb("operations",actor.organizationId);
  boardWs.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-ui-design','Design review','Design intent','[\"evidence\"]',?, ?, ?)").run(actor.actorId,boardSeed,boardSeed);
  boardWs.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-ui-design','obj-ui-design',1,?,'confirmed','manual',?,'[]',?)").run(`sha256:${"c".repeat(64)}`,actor.actorId,boardSeed);
  boardWs.prepare("INSERT INTO work_items(id,objective_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('work-ui-design','obj-ui-design','plan-ui-design','design','Design review card','ready','[\"evidence\"]','Start this task',?,?)").run(boardSeed,boardSeed);
  await page.goto(`${governor.url}/w/operations/board`);
  await expect(page.getByText("Design review card",{exact:true})).toBeVisible();
  await capture("board");
  expect(errors).toEqual([]);
});

function releaseDigest(brain: import("../../apps/governor/src/application/brain").Brain, organizationId:string) { return brain.activeRelease(organizationId)!.digest; }

