import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../../application/store";
import { decryptGitCredentials } from "../integrations/index";
import type { SecretMaterial, SecretScope, SecretsAdapter } from "./port";

const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_SECRET_BYTES = 8192;

/** `git:<connectionId>`: the reference of a Git connection's credentials. */
export const gitReference = (connectionId: string): string => `git:${connectionId}`;

/**
 * Built-in adapter over the encrypted store the Governor already keeps (AES-GCM, ADR 0024): the credentials of a Git connection, served
 * only to a workspace that has a verified write binding to it. The value is the credential JSON the Git client takes.
 */
export class EncryptedStoreAdapter implements SecretsAdapter {
  readonly id = "encrypted-store";
  constructor(private readonly store: Store) {}

  serves(ref: string): boolean { return ref.startsWith("git:"); }

  resolve(scope: SecretScope, ref: string): SecretMaterial | undefined {
    const connectionId = ref.slice("git:".length);
    const row = this.store.control.prepare(`SELECT c.id, c.encrypted_credentials FROM git_connections c JOIN repository_bindings b ON b.connection_id=c.id
      WHERE c.id=? AND c.organization_id=? AND c.status='verified' AND b.workspace_id=? AND b.status='verified' AND b.access='write' LIMIT 1`).get(connectionId, scope.organizationId, scope.workspaceId) as { id: string; encrypted_credentials: string } | undefined;
    if (!row) return undefined;
    return { value: JSON.stringify(decryptGitCredentials(this.store.pepper, scope.organizationId, row.id, row.encrypted_credentials)) };
  }
}

/**
 * Small second adapter: protected files on the Governor host at <dir>/<workspaceId>/<name> (mode 0600, owned by the Governor account).
 * This is where the runner-local secret store went: a runner no longer holds any of it.
 */
export class HostFileAdapter implements SecretsAdapter {
  readonly id = "host-file";
  constructor(private readonly dir: string | undefined) {}

  serves(ref: string): boolean { return SECRET_NAME.test(ref); }

  resolve(scope: SecretScope, ref: string): SecretMaterial | undefined {
    if (!this.dir || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(scope.workspaceId) || ref.includes("..")) return undefined;
    const path = join(this.dir, scope.workspaceId, ref);
    if (!existsSync(path)) return undefined;
    const st = statSync(path);
    if (!st.isFile() || st.size === 0 || st.size > MAX_SECRET_BYTES || (st.mode & 0o077) !== 0) return undefined;
    const value = readFileSync(path, "utf8").replace(/\n$/u, "");
    return value ? { value } : undefined;
  }
}
