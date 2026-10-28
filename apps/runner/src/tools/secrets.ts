import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Scoped secret delivery (T14): the Governor and workflow declarations only
// ever carry secret *references*. Values live in runner-local protected
// files laid out as <secretsDir>/<workspaceId>/<name> (mode 0600, owned by
// the runner account) and are resolved here, at invocation time, for
// privileged tool slots only. Values are injected as process env for the
// single tool execution and scrubbed from every returned stream.
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_SECRET_BYTES = 8192;
const MAX_SECRETS = 16;

export interface ResolvedSecrets {
  env: Record<string, string>;
  values: string[];
}

export function secretsDir(): string | undefined {
  return process.env["BRAIN_SECRETS_DIR"];
}

// secretRefs arrives as declared workflow input: { ENV_NAME: "secret-name" }.
// Anything malformed, out of scope, or missing fails closed — the tool never
// runs with a partial secret set.
export function resolveSecretRefs(
  secretRefs: unknown,
  workspaceId: string | undefined,
  effectClass: string,
): { ok: true; resolved: ResolvedSecrets } | { ok: false; error: string } {
  if (secretRefs === undefined) return { ok: true, resolved: { env: {}, values: [] } };
  if (!secretRefs || typeof secretRefs !== "object" || Array.isArray(secretRefs)) {
    return { ok: false, error: "secretRefs must be an object of ENV_NAME to secret name" };
  }
  const entries = Object.entries(secretRefs as Record<string, unknown>);
  if (entries.length === 0) return { ok: true, resolved: { env: {}, values: [] } };
  if (entries.length > MAX_SECRETS) return { ok: false, error: "too many secretRefs" };
  if (effectClass !== "privileged") return { ok: false, error: "secretRefs require a privileged tool slot" };
  if (!workspaceId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(workspaceId)) return { ok: false, error: "secretRefs require a workspace scope" };
  const root = secretsDir();
  if (!root) return { ok: false, error: "no runner secret store configured" };
  const env: Record<string, string> = {};
  const values: string[] = [];
  for (const [envName, rawName] of entries) {
    if (!ENV_NAME.test(envName)) return { ok: false, error: `invalid secret env name ${envName}` };
    if (typeof rawName !== "string" || !SECRET_NAME.test(rawName) || rawName.includes("..")) {
      return { ok: false, error: "invalid secret reference name" };
    }
    const path = join(root, workspaceId, rawName);
    if (!existsSync(path)) return { ok: false, error: `secret reference not available in workspace scope: ${rawName}` };
    const st = statSync(path);
    if (!st.isFile() || st.size === 0 || st.size > MAX_SECRET_BYTES) return { ok: false, error: `secret reference unusable: ${rawName}` };
    if ((st.mode & 0o077) !== 0) return { ok: false, error: `secret file permissions too open: ${rawName}` };
    const value = readFileSync(path, "utf8").replace(/\n$/u, "");
    if (!value) return { ok: false, error: `secret reference empty: ${rawName}` };
    env[envName] = value;
    values.push(value);
  }
  return { ok: true, resolved: { env, values } };
}

export function scrubSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join("[redacted]");
  return out;
}
