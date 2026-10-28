/**
 * Display helpers shared by every screen so the same server value renders the
 * same way everywhere (counts, digests) — no per-page truncation dialects.
 */

/** "1 decision" / "3 decisions"; never "1 decisions". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * One consistent truncated digest form: `sha256:ba102196c289…`. The ellipsis is
 * part of the rendering so a shortened digest can never read as a complete one.
 */
export function shortDigest(digest: string | undefined, hexChars = 12): string {
  if (!digest) return "—";
  const colon = digest.indexOf(":");
  const prefix = colon >= 0 ? digest.slice(0, colon + 1) : "";
  const hex = colon >= 0 ? digest.slice(colon + 1) : digest;
  return `${prefix}${hex.slice(0, hexChars)}…`;
}
