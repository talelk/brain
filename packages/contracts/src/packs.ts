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

/*
 * A pack is an Agent Plugins 1.0 folder (docs/model.md, Packs): `plugin.json` at its root, skills in `skills/`, and what only Brain reads
 * (agents, tools, Plays, memory) in the directory named after Brain's namespace. A workspace holds those files without that directory.
 */
export const PACK_MANIFEST = "plugin.json";
export const PACK_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** The namespace of what is Brain's in a pack: its entry of `extensions` and its directory. */
export const PACK_NAMESPACE = "io.github.talelk.brain";
const OWN = `${PACK_NAMESPACE}/`;
const BRAIN_ONLY = /^(?:agents|tools|plays|memory)(?:\/|$)/u;

/** Where a pack holds the file a workspace has at this path. */
export const packPath = (path: string): string => (path.startsWith("skills/") ? path : `${OWN}${path}`);

/**
 * What a pack gives a workspace, by the paths the workspace holds it at, and the files that are in the wrong place of a pack. Everything
 * else in the folder (the manifest, a read-me, another client's directory, `mcp.json`) is not Brain's to read.
 */
export function packContents<T>(files: ReadonlyMap<string, T>): { readonly files: Map<string, T>; readonly misplaced: ReadonlyArray<{ readonly path: string; readonly message: string }> } {
  const held = new Map<string, T>();
  const misplaced: Array<{ path: string; message: string }> = [];
  for (const [path, value] of files) {
    const inside = path.startsWith(OWN) ? path.slice(OWN.length) : undefined;
    if (inside?.startsWith("skills/")) misplaced.push({ path, message: "a pack holds its skills in skills/ at its root" });
    else if (inside !== undefined) held.set(inside, value);
    else if (path.startsWith("skills/")) held.set(path, value);
    else if (BRAIN_ONLY.test(path)) misplaced.push({ path, message: `a pack holds this in ${OWN}` });
  }
  return { files: held, misplaced };
}
