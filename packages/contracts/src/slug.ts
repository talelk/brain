/** Names that become addresses and file names. Dependency-free, so the web app imports it too. */

export const SLUG = /^[a-z][a-z0-9-]{0,62}$/u;
export const isSlug = (name: string): boolean => SLUG.test(name);

/**
 * What a person typed, as the lower-case, dashed name an address or a file needs: accents are dropped (`Réseau` is `reseau`), anything else
 * that is not a letter or digit becomes one dash, and the result starts with a letter. Empty when nothing usable is left.
 */
export const slugify = (text: string): string => text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^[^a-z]+/u, "").slice(0, 40).replace(/-+$/u, "");

/** A tool is named by its folder: slugs joined by dots. The dots stay. */
export const slugifyTool = (text: string): string => text.split(".").map(slugify).filter((part) => part !== "").join(".");
