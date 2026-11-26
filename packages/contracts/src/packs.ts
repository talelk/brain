/** How the `packs` entries of a `brain.toml` read and are pinned. It depends on nothing, so the web app imports it too. */

/** A pack entry of brain.toml split into its name and the release it pins (0: the shipped baseline). */
export const splitPackRef = (ref: string): { readonly name: string; readonly pin: number } => {
  const [name = "", pin] = ref.split("@");
  return { name, pin: pin === undefined ? 0 : Number(pin) };
};

/** The entries with each updated pack at its latest release. A pack in use only because another requires it is not listed yet, so its pin is added. */
export function withPins(refs: readonly string[], updates: readonly { readonly pack: string; readonly latest: number }[]): string[] {
  const latest = new Map(updates.map((one) => [one.pack, `${one.pack}@${one.latest}`]));
  const named = new Set(refs.map((ref) => splitPackRef(ref).name));
  return [...refs.map((ref) => latest.get(splitPackRef(ref).name) ?? ref), ...updates.filter((one) => !named.has(one.pack)).map((one) => `${one.pack}@${one.latest}`)];
}
