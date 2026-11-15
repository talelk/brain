// Secret credentials on the runner (ADR 0065). The runner holds no secret store: the Governor mints short-lived credentials, bound to the
// attempt and its fence, for the secrets a privileged tool declared. They arrive over the authenticated runner channel, live only in this
// process's memory for one tool call, go to the sandbox beside the stdin and never to disk, an event or an artifact. This file is what turns
// the Governor's answer into what a tool call uses, and scrubs every value from whatever the tool returns.
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_SECRETS = 16;

export interface SecretCredential { id: string; envName: string; value: string; expiresAt: string }

/** What the tool broker needs of the Governor: mint the attempt's credentials, and re-check them immediately before use. */
export interface SecretCredentialSource {
  mint(): Promise<SecretCredential[]>;
  validate(ids: readonly string[]): Promise<void>;
}

export interface ResolvedSecrets {
  env: Record<string, string>;
  values: string[];
  ids: string[];
  expiresAtMs: number;
}

export const noSecrets = (): ResolvedSecrets => ({ env: {}, values: [], ids: [], expiresAtMs: Number.POSITIVE_INFINITY });

/**
 * secretRefs arrives as the declared workflow input { ENV_NAME: reference }. The reference names are not looked up here: the Governor mints
 * for what the job's pinned payload declares, and the names must agree with it, else the tool never runs with a partial or foreign set.
 */
export async function leaseSecretRefs(
  secretRefs: unknown,
  effectClass: string,
  source: SecretCredentialSource | undefined,
): Promise<{ ok: true; resolved: ResolvedSecrets } | { ok: false; error: string }> {
  if (secretRefs === undefined) return { ok: true, resolved: noSecrets() };
  if (!secretRefs || typeof secretRefs !== "object" || Array.isArray(secretRefs)) return { ok: false, error: "secretRefs must be an object of ENV_NAME to secret name" };
  const declared = Object.entries(secretRefs as Record<string, unknown>);
  if (declared.length === 0) return { ok: true, resolved: noSecrets() };
  if (declared.length > MAX_SECRETS) return { ok: false, error: "too many secretRefs" };
  if (effectClass !== "privileged") return { ok: false, error: "secretRefs require a privileged tool slot" };
  for (const [envName, ref] of declared) if (!ENV_NAME.test(envName) || typeof ref !== "string") return { ok: false, error: `invalid secret reference for ${envName}` };
  if (!source) return { ok: false, error: "no secret credentials are available to this tool call" };
  let minted: SecretCredential[];
  try { minted = await source.mint(); } catch (e) { return { ok: false, error: `secret credentials were refused: ${e instanceof Error ? e.message.slice(0, 200) : "refused"}` }; }
  const names = new Set(minted.map((credential) => credential.envName));
  if (minted.length !== declared.length || declared.some(([envName]) => !names.has(envName))) return { ok: false, error: "the secret credentials do not match the tool's declared secrets" };
  const now = Date.now();
  if (minted.some((credential) => Date.parse(credential.expiresAt) <= now)) return { ok: false, error: "a secret credential has already expired; invocation refused" };
  return { ok: true, resolved: {
    env: Object.fromEntries(minted.map((credential) => [credential.envName, credential.value])),
    values: minted.map((credential) => credential.value),
    ids: minted.map((credential) => credential.id),
    expiresAtMs: Math.min(...minted.map((credential) => Date.parse(credential.expiresAt))),
  } };
}

/** Immediately before the tool runs: expired locally is refused without asking, and the Governor re-checks revocation and the fence (and audits a refusal). */
export async function assertSecretsCurrent(resolved: ResolvedSecrets, source: SecretCredentialSource | undefined): Promise<string | undefined> {
  if (resolved.ids.length === 0) return undefined;
  if (Date.now() >= resolved.expiresAtMs) {
    // Ask anyway so the Governor records the refused use; the answer cannot change the outcome.
    await source?.validate(resolved.ids).catch(() => undefined);
    return "a secret credential expired before the tool ran; invocation refused";
  }
  try { await source!.validate(resolved.ids); return undefined; } catch (e) { return `secret credentials no longer valid: ${e instanceof Error ? e.message.slice(0, 200) : "refused"}`; }
}

export function scrubSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join("[redacted]");
  return out;
}
