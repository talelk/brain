/**
 * Model keys on a runner host, as the kept engine adapters still read them. The Governor's model gateway now holds the keys
 * (docs/architecture.md section 6); this file goes when the runner's engines stop reading keys from their environment.
 */
const KEY_REFERENCE = /^[a-z][a-z0-9-]{0,31}$/u;
/** Anything that looks like a vendor secret is refused as a reference even when it would fit the slug. */
const LOOKS_LIKE_SECRET = /^(?:sk|pk|key|token|secret|bearer)-|[0-9]{8,}/iu;

export function isKeyReference(value: string): boolean {
  return KEY_REFERENCE.test(value) && !LOOKS_LIKE_SECRET.test(value);
}

/** The one environment variable a key reference resolves to: a fixed prefix, so a reference can never name another secret of the host. */
export function modelKeyEnvName(keyRef: string): string {
  return `BRAIN_MODEL_KEY_${keyRef.toUpperCase().replace(/-/gu, "_")}`;
}

/** The key of a reference from the given environment, or undefined when the host has none set. */
export function resolveModelKey(keyRef: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  if (!isKeyReference(keyRef)) return undefined;
  const key = env[modelKeyEnvName(keyRef)];
  return key ? key : undefined;
}
