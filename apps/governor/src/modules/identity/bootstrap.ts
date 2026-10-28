import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { BootstrapRequest } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import type { Store } from "../../application/store";
import { assertRegularFile } from "../../infrastructure/persistence/directory";
import { BrainDomainError } from "../../domain/errors";
import type { BrainAuth } from "./auth";

export interface BootstrapResult { readonly organizationId: string; readonly ownerPrincipalId: string; readonly sessionToken: string; readonly cookies: readonly string[] }
const busy = new WeakSet<Store>();

export async function bootstrapIdentity(store: Store, auth: BrainAuth, raw: unknown, setupCredential: string): Promise<BootstrapResult> {
    const path = join(store.dataDir, "setup.token");
    if (existsSync(join(store.dataDir, "RESTORED-SUSPENDED.json")) || !existsSync(path)) throw new BrainDomainError("FORBIDDEN", "setup unavailable");
    assertRegularFile(path);
    const stat = lstatSync(path);
    if ((stat.mode & 0o077) !== 0 || stat.size > 512) throw new BrainDomainError("FORBIDDEN", "setup credential must remain private");
    const expected = store.tokenDigest("local-setup", readFileSync(path, "utf8").trim());
    const received = store.tokenDigest("local-setup", setupCredential);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))) throw new BrainDomainError("FORBIDDEN", "local setup credential required");
    const check = validate("BootstrapRequest", raw);
    if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", check.errors.join("; "));
    const parsed = raw as BootstrapRequest;
    const input = { ...parsed, email: parsed.email.toLowerCase() };
    const s = store;
    if (busy.has(store) || s.control.prepare("SELECT 1 FROM organizations LIMIT 1").get()) throw new BrainDomainError("CONFLICT", "initial setup is already complete or in progress");
    busy.add(store);
    try {
      const prior = s.control.prepare("SELECT organization_id,email FROM setup_intent WHERE singleton=1").get() as { organization_id: string; email: string } | undefined;
      if (prior && (prior.organization_id !== input.organizationId || prior.email !== input.email)) throw new BrainDomainError("CONFLICT", "resume the original pending setup");
      if (!prior) s.control.prepare("INSERT INTO setup_intent VALUES (1,?,?,'pending')").run(input.organizationId, input.email);
      const account = await auth.bootstrapAccount(input);
      const authOrganizationId = await auth.bootstrapOrganization(account.userId, `brain-${input.organizationId.toLowerCase()}`, input.name);
      s.inTx(s.control, () => {
        s.control.prepare("INSERT INTO organizations(id,auth_organization_id) VALUES (?,?)").run(input.organizationId, authOrganizationId);
        s.control.prepare("INSERT INTO principals(id,organization_id,kind,auth_subject_id) VALUES (?,?,'human',?)").run(account.userId, input.organizationId, account.userId);
        for (const role of ["organization-admin", "security-admin", "tool-publisher"]) {
          s.control.prepare("INSERT INTO organization_authorizations(organization_id,principal_id,role,granted_by,granted_at_ms) VALUES (?,?,?,?,?)").run(input.organizationId, account.userId, role, account.userId, s.now());
        }
        s.control.prepare("UPDATE setup_intent SET state='ready' WHERE singleton=1").run();
        s.emit(s.control, { organizationId: input.organizationId, aggregateType: "organization", aggregateId: input.organizationId, eventType: "organization.bootstrapped", payload: { ownerPrincipalId: account.userId } });
      });
      unlinkSync(path);
      return { organizationId: input.organizationId, ownerPrincipalId: account.userId, sessionToken: account.token, cookies: account.cookies };
    } finally { busy.delete(store); }
}
