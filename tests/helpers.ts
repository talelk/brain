import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll } from "vitest";
import { join } from "node:path";
import type { ActorContext, ExecutionLink, WorkItem } from "../packages/contracts/src/index";
import { Brain } from "../apps/governor/src/application/brain";
import { scopesForPrincipal, type ResolvedActor } from "../apps/governor/src/application/authz";
import { totpCode, newTotpSecret } from "./support/totp";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const requireGovernor = createRequire(new URL("../apps/governor/package.json", import.meta.url));
const vendorCrypto = () => import(requireGovernor.resolve("better-auth/crypto")) as Promise<{ symmetricEncrypt(input: { key: string; data: string }): Promise<string> }>;

// Arrange pinned vendor rows for domain tests. Real sign-up, cookies, enrollment
// and sign-in are separately exercised against Better Auth's HTTP handler.
export function seedHuman(brain: Brain, organizationId: string, principalId: string): { token: string; sessionId: string } {
  const db = brain.store.control; const now = brain.store.now();
  const authOrg = (db.prepare("SELECT auth_organization_id AS id FROM organizations WHERE id=?").get(organizationId) as { id: string }).id;
  db.prepare('INSERT OR IGNORE INTO "user"(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES (?,?,?,0,?,?,0)').run(principalId, principalId, `${principalId}@fixture.test`, now, now);
  db.prepare('INSERT OR IGNORE INTO "member"(id,organizationId,userId,role,createdAt) VALUES (?,?,?,?,?)').run(`member-${organizationId}-${principalId}`, authOrg, principalId, "member", now);
  brain.ensurePrincipal(organizationId, principalId, "human");
  const token = randomBytes(32).toString("base64url"); const sessionId = brain.store.id("authsession");
  db.prepare('INSERT INTO "session"(id,userId,token,expiresAt,createdAt,updatedAt,activeOrganizationId) VALUES (?,?,?,?,?,?,?)').run(sessionId, principalId, token, now + 12*3600_000, now, now, authOrg);
  return { token, sessionId };
}

export function seedOrganization(brain: Brain, input: { organizationId: string; ownerId: string }): { organizationId: string; ownerPrincipalId: string; sessionToken: string } {
  const s = brain.store;
  s.control.prepare('INSERT INTO "organization"(id,name,slug,createdAt) VALUES (?,?,?,?)').run(input.organizationId, input.organizationId, input.organizationId, s.now());
  s.control.prepare("INSERT INTO organizations(id,auth_organization_id) VALUES (?,?)").run(input.organizationId, input.organizationId);
  const { token } = seedHuman(brain, input.organizationId, input.ownerId);
  for (const role of ["organization-admin", "security-admin", "tool-publisher"]) s.control.prepare("INSERT INTO organization_authorizations(organization_id,principal_id,role,granted_by,granted_at_ms) VALUES (?,?,?,?,?)").run(input.organizationId, input.ownerId, role, input.ownerId, s.now());
  return { organizationId: input.organizationId, ownerPrincipalId: input.ownerId, sessionToken: token };
}

export function setupCredential(brain: Brain): string {
  return readFileSync(join(brain.store.dataDir, "setup.token"), "utf8").trim();
}

// Disposable data directories of this test worker, removed when it exits so
// repeated runs never fill the temp volume.
const disposableDirs: string[] = [];
afterAll(() => { for (const dir of disposableDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

export function tempBrain(): { brain: Brain; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  disposableDirs.push(dir);
  return { brain: new Brain({ dataDir: dir, allowTestActor: true }), dir };
}

export interface TestWorld {
  brain: Brain;
  dir: string;
  org: string;
  owner: ActorContext;
  ownerToken: string;
  workspaceId: string;
  actor: (principalId: string, workspaceId?: string) => ActorContext;
  grantApprover: (principalId: string) => Promise<{ actor: ActorContext; token: string; totp: string; identity: ResolvedActor }>;
}

export function goldenDocs(): { path: string; text: string }[] {
  const base = join(process.cwd(), "examples/v1/golden-release/config");
  const files = [
    "fixture-brain.yaml", "fixture-policy.yaml", "fixture-type.yaml", "fixture-tools.yaml",
    "fixture-evaluators.yaml", "fixture.echo.yaml", "fixture.verify.yaml", "fixture-evaluator.yaml",
    "fixture-workflow.yaml", "fixture-workspace.yaml",
  ];
  return files.map((f) => ({ path: `config/${f}`, text: readFileSync(join(base, f), "utf8") }));
}

export function setupWorld(existing?: Brain): TestWorld {
  const { brain, dir } = existing ? { brain: existing, dir: existing.store.dataDir } : tempBrain();
  const org = "org-test";
  const boot = seedOrganization(brain, { organizationId: org, ownerId: "owner-1" });
  const actor = (principalId: string, workspaceId?: string): ActorContext => ({
    kind: "human", actorId: principalId, organizationId: org,
    ...(workspaceId ? { workspaceId } : {}),
    scopes: scopesForPrincipal(brain.store, principalId, org, workspaceId),
    authMethod: "session", authGeneration: 1,
  });
  const owner = actor("owner-1");
  brain.createWorkspace(owner, { workspaceId: "ws-test", slug: "test" });
  const ownerWs = actor("owner-1", "ws-test");
  const { digest } = brain.stageRelease(ownerWs, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(ownerWs, digest);
  return {
    brain, dir, org, owner: ownerWs, ownerToken: boot.sessionToken,
    workspaceId: "ws-test", actor,
    async grantApprover(principalId: string) {
      const { token } = seedHuman(brain, org, principalId);
      brain.store.control.prepare(
        "INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-test', ?, ?, 'approver', 1, 'owner-1', ?)",
      ).run(org, principalId, brain.store.now());
      brain.store.control.prepare(
        "INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-test', ?, ?, 'operator', 1, 'owner-1', ?)",
      ).run(org, principalId, brain.store.now());
      const totp = newTotpSecret();
      const { symmetricEncrypt } = await vendorCrypto();
      const key = process.env["BRAIN_AUTH_SECRET"] ?? Buffer.from(brain.store.pepper).toString("hex");
      const encrypted = await symmetricEncrypt({ key, data: `base32:${totp}` });
      brain.store.control.prepare('UPDATE "user" SET twoFactorEnabled=1 WHERE id=?').run(principalId);
      brain.store.control.prepare('INSERT INTO "twoFactor"(id,userId,secret,backupCodes,verified) VALUES (?,?,?,?,1)').run(`factor-${principalId}`, principalId, encrypted, "[]");
      const identity = await brain.resolveActor(new Headers({ authorization: `Bearer ${token}` }), "ws-test");
      return { actor: identity.actor, token, totp, identity };
    },
  };
}

export async function stepUp(world: TestWorld, who: { actor: ActorContext; token: string; totp: string }, approvalId: string, subjectDigest: string): Promise<string> {
  const headers = new Headers({ authorization: `Bearer ${who.token}` });
  const identity = await world.brain.resolveActor(headers, world.workspaceId);
  const ch = world.brain.stepUp.createChallenge(identity, approvalId, subjectDigest);
  const code = totpCode(who.totp, Date.now());
  return (await world.brain.stepUp.verify(identity, ch.challengeId, code, headers)).evidenceId;
}

export const DIGEST_A = `sha256:${"a".repeat(64)}`;

/**
 * Seeds one work item through the real tables (mission + confirmed plan,
 * FK-safe) for tests that need rows without driving the command path.
 */
export function seedWorkItem(brain: Brain, organizationId: string, workspaceId: string, id: string, state: string, criteria: string[]): void {
  const ws = brain.store.workspaceDb(workspaceId, organizationId);
  const now = brain.store.now();
  const missionId = `mission-${id}`, planId = `plan-${id}`;
  ws.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,version,created_at_ms,updated_at_ms) VALUES (?,?,?,'[\"seeded\"]','seed-owner',1,?,?)")
    .run(missionId, `Mission for ${id}`, "seeded", now, now);
  ws.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms,confirmed_at_ms) VALUES (?,?,'1',?,'confirmed','manual','seed-owner','[]',?,?)")
    .run(planId, missionId, DIGEST_A, now, now);
  ws.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES (?,?,?,?,'seeded work item',?,?,'seeded',?,?)")
    .run(id, missionId, planId, "task", state, JSON.stringify(criteria), now, now);
}

/** Live (non-abandoned) work items and execution links of a world's workspace. */
export async function workView(w: TestWorld): Promise<{ items: WorkItem[]; executions: ExecutionLink[] }> {
  const items = (await w.brain.executeQuery(w.owner, { queryType: "workItems.list", workspaceId: w.workspaceId, limit: 100 }) as { snapshot: { items: WorkItem[] } }).snapshot.items;
  const executions = (await w.brain.executeQuery(w.owner, { queryType: "executionLinks.list", workspaceId: w.workspaceId, limit: 100 }) as { snapshot: { items: ExecutionLink[] } }).snapshot.items;
  return { items: [...items], executions: [...executions] };
}
