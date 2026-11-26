import { z } from "zod";
import { packRef, translations, isSkillName, isSlug } from "./files";
import { PACK_NAMESPACE, PACK_SCHEMA } from "./packs";

/**
 * A pack's `plugin.json` (Agent Plugins 1.0). What the format defines is held to it; what Brain needs beyond it is Brain's entry of
 * `extensions`; other clients' entries and fields the format does not know are left as they are.
 */
export const PackExtension = z.strictObject({
  /** The packs it needs; a release names the release of each, such as `base@2`. */
  requires: z.array(packRef).default([]),
  translations: translations({ description: z.string().optional() }),
});
export type PackExtension = z.infer<typeof PackExtension>;

const text = z.string().optional();
const FIELDS = {
  $schema: z.literal(PACK_SCHEMA),
  // A pack's name is a name of the format that Brain can also use as a folder.
  name: z.string().refine((value) => isSlug(value) && isSkillName(value), "a pack name must be lower-case letters, digits and single dashes, starting with a letter and not ending with a dash"),
  version: text,
  description: z.string().default(""),
  author: z.strictObject({ name: text, email: text, url: text }).optional(),
  homepage: text,
  repository: text,
  license: text,
  keywords: z.array(z.string()).optional(),
  extensions: z.unknown().optional(),
};
const Manifest = z.looseObject(FIELDS);

export interface PackManifest {
  readonly name: string;
  readonly description: string;
  /** The release of Brain the manifest names (0: none): the first number of its `version`. */
  readonly version: number;
  readonly requires: readonly string[];
  readonly translations: PackExtension["translations"];
}
export interface ReadManifest {
  /** Undefined when the manifest is not valid. */
  readonly pack?: PackManifest;
  readonly problems: readonly string[];
  /** Fields the format does not know, which are ignored. */
  readonly ignored: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const releaseOf = (version: string | undefined): number => Number(/^([1-9][0-9]{0,5})(?:\.|$)/u.exec(version ?? "")?.[1] ?? 0);
const jsonOf = (source: string): unknown => { try { return JSON.parse(source) as unknown; } catch { return undefined; } };
const said = (error: z.ZodError, at: string): string[] => error.issues.map((issue) => { const path = [at, ...issue.path.map(String)].filter(Boolean).join("."); return path ? `${path}: ${issue.message}` : issue.message; });

export function readPackManifest(source: string): ReadManifest {
  const json = jsonOf(source);
  if (!isObject(json)) return { problems: ["not a JSON object"], ignored: [] };
  const ignored = Object.keys(json).filter((key) => !(key in FIELDS));
  const manifest = Manifest.safeParse(json);
  if (!manifest.success) return { problems: said(manifest.error, ""), ignored };
  const { extensions } = manifest.data;
  if (extensions !== undefined && !isObject(extensions)) ignored.push("extensions");
  const own = PackExtension.safeParse((isObject(extensions) ? extensions[PACK_NAMESPACE] : undefined) ?? {});
  if (!own.success) return { problems: said(own.error, `extensions.${PACK_NAMESPACE}`), ignored };
  const { name, description, version } = manifest.data;
  return { pack: { name, description, version: releaseOf(version), requires: own.data.requires, translations: own.data.translations }, problems: [], ignored };
}

/** The fields of a manifest in the order Brain writes them; any other follows. */
const ordered = (json: Record<string, unknown>): Record<string, unknown> => Object.fromEntries([...Object.keys(FIELDS).filter((key) => key in json), ...Object.keys(json).filter((key) => !(key in FIELDS))].map((key) => [key, json[key]]));

/**
 * A valid manifest written again with the release it is (0: no version) or the packs it requires changed. Everything else it says is kept;
 * the writing is always the same, so two versions of a pack differ only in what changed.
 */
export function writePackManifest(source: string, change: { readonly version?: number; readonly requires?: readonly string[] }): string {
  const json = { ...(jsonOf(source) as Record<string, unknown>) };
  if (change.version !== undefined) {
    if (change.version === 0) delete json["version"];
    else json["version"] = `${change.version}.0.0`;
  }
  if (change.requires !== undefined) {
    const extensions = isObject(json["extensions"]) ? json["extensions"] : {};
    const own = isObject(extensions[PACK_NAMESPACE]) ? { ...extensions[PACK_NAMESPACE] } : {};
    if (change.requires.length === 0) delete own["requires"];
    else own["requires"] = [...change.requires];
    if (Object.keys(own).length > 0) json["extensions"] = { ...extensions, [PACK_NAMESPACE]: own };
  }
  return `${JSON.stringify(ordered(json), null, 2)}\n`;
}
