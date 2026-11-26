import { BrainError, MAX_FILE_BYTES, MAX_WRITE_BYTES, PACK_MANIFEST, packContents, packPath, pathProblem, PLATFORM_PACK, readPackManifest, splitPackRef, gitAuthorization, type Effect, type PackImport, type Problem } from "@brain/contracts";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { parse as parseToml } from "smol-toml";
import type { Gov } from "../dispatch";
import { log } from "../log";
import { httpOver } from "../integrations/pull-request";
import { readPack, releasedDirOf, releasedVersions, type Files } from "./files";
import { readFolderAt } from "./git";
import { loadWorkspace } from "./load";
import { packShapeProblems } from "./pack-shape";

/** Reading a pack out of another repository (docs/model.md, "Packs are kept and delivered here"): fetched at one commit and held to what every pack is held to. */
const MOST_FILES = 500;
const COMMIT = /^[0-9a-f]{40}$/u;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const refused = (message: string, problems?: Problem[]): BrainError => new BrainError("INVALID_INPUT", message, problems);

export interface Source { readonly repo: string; readonly ref?: string | undefined; readonly path: string; readonly credential?: string | undefined }

/** The commit a ref names and the files of the pack's folder there. Hidden files are not part of a pack. */
export async function fetchPack(gov: Gov, source: Source): Promise<{ commit: string; files: Files }> {
  const dir = fs.mkdtempSync(join(tmpdir(), "brain-pack-"));
  const folder = source.path.replace(/^\/+|\/+$/gu, "");
  try {
    const remote = { fs, http: httpOver(gov.fetch), dir, ...(source.credential ? { headers: { authorization: gitAuthorization(source.credential) } } : {}) };
    let commit: string;
    try {
      const wanted = source.ref !== undefined && COMMIT.test(source.ref) ? source.ref : undefined;
      await git.clone({ ...remote, url: source.repo, ...(source.ref !== undefined && !wanted ? { ref: source.ref } : {}), singleBranch: true, noTags: true, noCheckout: true, depth: 1 });
      // A commit that is not the branch's head is found by reading further back: git here cannot ask for a commit by its id alone.
      if (wanted) for (const depth of [50, 500, 5000]) {
        if (await git.readCommit({ fs, dir, oid: wanted }).then(() => true, () => false)) break;
        await git.fetch({ ...remote, url: source.repo, singleBranch: true, depth, tags: false }).catch(() => undefined);
      }
      commit = (await git.readCommit({ fs, dir, oid: wanted ?? (await git.resolveRef({ fs, dir, ref: "HEAD" })) })).oid;
    } catch (e) {
      throw refused(`The repository could not be read at ${source.ref ?? "its default branch"}: ${e instanceof Error ? e.message.split("\n")[0] : "it did not answer"}`);
    }
    const found = await readFolderAt(dir, commit, folder === "" ? "" : `${folder}/`);
    const files: Files = new Map([...found].filter(([path]) => !path.split("/").some((part) => part.startsWith("."))));
    if (!files.has(PACK_MANIFEST)) throw refused(`There is no ${PACK_MANIFEST} ${folder === "" ? "at the root of the repository" : `in ${folder}`}`);
    const sizes = [...files.values()].map((bytes) => bytes.length);
    if (files.size > MOST_FILES || sizes.some((size) => size > MAX_FILE_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > MAX_WRITE_BYTES) throw refused("The pack is too large: at most 500 files, 5 MB each and 20 MB in all");
    const odd = [...files.keys()].flatMap((path) => { const problem = pathProblem(path); return problem ? [{ path, message: problem }] : []; });
    if (odd.length > 0) throw refused("The pack holds paths a workspace cannot hold", odd);
    return { commit, files };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What is in a fetched pack, once it is found to be a pack: valid over what it requires, in its shape, and with no file another pack has. */
export function checkImported(gov: Gov, files: Files): Omit<PackImport, "commit"> {
  const { pack, problems: wrong, ignored } = readPackManifest(decode(files.get(PACK_MANIFEST) as Uint8Array));
  if (!pack) throw refused(`${PACK_MANIFEST} is not valid`, wrong.map((message) => ({ path: PACK_MANIFEST, message })));
  const { name, requires } = pack;
  if (ignored.length > 0) log("warn", "pack.fields_ignored", { pack: name, fields: ignored.join(", ") });
  const released = releasedDirOf(gov.dataDir);
  const needed = requires.map((ref) => splitPackRef(ref).name).filter((one) => one !== name);
  const at = needed.map((one) => { const latest = releasedVersions(released, one).at(-1); return latest === undefined ? one : `${one}@${latest}`; });
  const platform = name === PLATFORM_PACK || needed.includes(PLATFORM_PACK);
  // The pack's files stand as a workspace's own over the packs it requires, which is how they are read when the pack is used.
  const held = packContents(files);
  const folder: Files = new Map([...held.files, ["brain.toml", encode(`name = "Check"\n${platform ? 'platform = "admin"\n' : ""}packs = ${JSON.stringify(at)}\n`)]]);
  const loaded = loadWorkspace(folder, gov.packsDir, released);
  // A problem of the pack's own file is named where the pack holds it; those of the packs it requires already are.
  const inPack = (path: string): string => (path === "brain.toml" ? PACK_MANIFEST : path.startsWith("packs/") ? path : packPath(path));
  const problems = [...held.misplaced, ...[...loaded.problems, ...(loaded.manifest ? packShapeProblems(loaded.manifest, "workspace") : [])].map((problem) => ({ path: inPack(problem.path), message: problem.message }))];
  const replaces = [...loaded.files].flatMap(([path, file]) => (file.source === "workspace" && file.replaces !== undefined && path !== "brain.toml" ? [{ path, pack: file.replaces }] : [])).sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = loaded.manifest;
  if (!manifest || problems.length > 0) throw new BrainError("INVALID_WORKSPACE", `${name} is not a valid pack, so nothing was imported`, problems.map((problem) => ({ path: `packs/${name}/${problem.path}`, message: problem.message })));
  const own = <T extends { readonly source: string }>(entries: Readonly<Record<string, T>>): Array<[string, T]> => Object.entries(entries).filter(([, entry]) => entry.source === "workspace");
  const shipped = (tool: string): Effect | undefined => {
    const file = ["base", PLATFORM_PACK].map((from) => readPack(gov.packsDir, from)?.get(packPath(`tools/${tool}/tool.toml`))).find((bytes) => bytes !== undefined);
    return file ? (parseToml(decode(file)) as { effect?: Effect }).effect : undefined;
  };
  return {
    name, requires: needed, replaces,
    tools: own(manifest.tools).map(([tool, entry]) => {
      const standard = entry.runs === "brain" ? shipped(tool) : undefined;
      return { name: tool, effect: entry.effect, network: [...entry.network], secrets: [...entry.secrets], ...(standard !== undefined && standard !== entry.effect ? { shippedEffect: standard } : {}) };
    }),
    agents: own(manifest.agents).map(([agent]) => agent), plays: own(manifest.plays).map(([play]) => play), skills: own(manifest.skills ?? {}).map(([skill]) => skill),
  };
}
