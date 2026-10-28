import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorContext } from "@brain/contracts";
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

export function tempBrain(): { brain: Brain; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
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
