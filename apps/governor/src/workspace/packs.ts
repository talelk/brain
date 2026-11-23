import { BrainError, PackFile, PLATFORM_PACK, type CommandOutputs, type PackInfo, type PackUpdate, type SnapshotManifest } from "@brain/contracts";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Governor } from "../app";
import type { Gov } from "../dispatch";
import { append } from "../events";
import { listPacks, readPack, releasedDirOf, releasedVersions, type Files } from "./files";
import { readFolderAt, readHead, tagCommit, tags } from "./git";
import { loadWorkspace } from "./load";
import { adminWorkspace } from "./platform";
import { activate, commitFolder, getWorkspace, manifestOf, workspaceDir, type Committed } from "./store";

/**
 * Packs kept and delivered by the platform workspace (docs/model.md, "Packs are kept and delivered here"). A workspace pins a release in `brain.toml`;
 * a release is the content of `packs/<name>/` of the platform folder at one commit, frozen as `<data>/released/<name>@<n>/` and tagged `<name>@<n>`.
 */
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const lastRelease = (gov: Gov, name: string): number => releasedVersions(releasedDirOf(gov.dataDir), name).at(-1) ?? 0;

/** The packs the workspace uses that have a newer release than the one it is pinned to (the baseline is 0). */
export function updatesOf(gov: Gov, manifest: SnapshotManifest): PackUpdate[] {
  return manifest.packs.flatMap((pack) => {
    const latest = lastRelease(gov, pack);
    const pinned = manifest.pins?.[pack] ?? 0;
    return latest > pinned ? [{ pack, pinned, latest }] : [];
  });
}

/** The text of a brain.toml with each pack in `updates` pinned to its latest release; the rest of the file is as it was. */
function pinned(text: string, updates: readonly PackUpdate[]): string {
  const latest = new Map(updates.map((one) => [one.pack, one.latest]));
  const start = text.search(/^packs[ \t]*=[ \t]*\[/mu);
  const end = start < 0 ? -1 : text.indexOf("]", start);
  if (end < 0) return text;
  return text.slice(0, start) + text.slice(start, end).replace(/"([^"]+)"/gu, (whole, ref: string) => { const name = ref.split("@")[0] as string; return latest.has(name) ? `"${name}@${latest.get(name)}"` : whole; }) + text.slice(end);
}

/** `packs/<name>/<path>` for every file of every shipped pack: what the platform workspace starts with. */
export function seedPacks(gov: Gov): Map<string, Uint8Array> {
  const seed = new Map<string, Uint8Array>();
  for (const pack of listPacks(gov.packsDir)) for (const [path, bytes] of readPack(gov.packsDir, pack.name) ?? []) seed.set(`packs/${pack.name}/${path}`, bytes);
  return seed;
}

/** A pack.toml with its `version` line set. */
const withVersion = (text: string, version: number): string => (/^version\s*=.*$/mu.test(text) ? text.replace(/^version\s*=.*$/mu, `version = ${version}`) : text.replace(/^(name\s*=.*)$/mu, `$1\nversion = ${version}`));
/** The files of a pack compared without its `version` line. */
const sameFiles = (a: Files, b: Files): boolean => {
  const plain = (files: Files): Array<[string, string]> => [...files].map(([path, bytes]): [string, string] => [path, path === "pack.toml" ? decode(bytes).replace(/^version\s*=.*\n?/mu, "") : Buffer.from(bytes).toString("base64")]).sort(([x], [y]) => (x < y ? -1 : 1));
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
};
const packOf = (files: Files, prefix: string): Files => new Map([...files].filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => [path.slice(prefix.length), bytes] as const));

async function platformFiles(gov: Gov): Promise<Files | undefined> {
  const platform = adminWorkspace(gov);
  return platform ? (await readHead(workspaceDir(gov, platform.slug))).files : undefined;
}

/** What the platform workspace shows of each shipped pack. */
async function infos(gov: Gov): Promise<PackInfo[]> {
  const folder = await platformFiles(gov);
  const workspaces = (gov.db.prepare("SELECT slug, name, active_snapshot AS snapshot FROM workspaces WHERE active_snapshot != '' ORDER BY slug").all() as Array<{ slug: string; name: string; snapshot: string }>).map((row) => ({ ...row, manifest: manifestOf(gov, row.snapshot as never) }));
  return listPacks(gov.packsDir).map((pack): PackInfo => {
    const released = releasedVersions(releasedDirOf(gov.dataDir), pack.name);
    const working = folder ? packOf(folder, `packs/${pack.name}/`) : undefined;
    const last = released.at(-1);
    const base = last === undefined ? readPack(gov.packsDir, pack.name) : readPack(gov.packsDir, pack.name, last, releasedDirOf(gov.dataDir));
    return {
      ...pack, version: last ?? 0, released,
      ...(working && working.size > 0 ? { working: { changed: !base || !sameFiles(working, base) } } : {}),
      usedBy: workspaces.filter((row) => row.manifest.packs.includes(pack.name)).map((row) => ({ slug: row.slug, name: row.name, pin: row.manifest.pins?.[pack.name] ?? 0 })),
    };
  });
}

/** Writes a release's files under `<released>/<name>@<n>/`; nothing is written over an existing release. */
function freeze(gov: Gov, name: string, version: number, files: Files): string {
  const target = join(releasedDirOf(gov.dataDir), `${name}@${version}`);
  if (existsSync(target)) throw new BrainError("CONFLICT", `${name}@${version} is already released`);
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes, { mode: 0o444 });
  }
  return target;
}
const unfreeze = (target: string): void => {
  if (!existsSync(target)) return;
  for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) if (entry.isFile()) rmSync(join(entry.parentPath, entry.name), { force: true });
  rmSync(target, { recursive: true, force: true });
};

/** At start: a release whose directory is gone is written again from its tag in the platform folder. */
export async function restoreReleases(gov: Gov): Promise<void> {
  const platform = adminWorkspace(gov);
  if (!platform) return;
  const dir = workspaceDir(gov, platform.slug);
  for (const [tag, commit] of await tags(dir)) {
    const match = /^([a-z][a-z0-9-]*)@([1-9][0-9]*)$/u.exec(tag);
    if (!match || existsSync(join(releasedDirOf(gov.dataDir), tag))) continue;
    freeze(gov, match[1] as string, Number(match[2]), await readFolderAt(dir, commit, `packs/${match[1] as string}/`));
  }
}

export function registerPacks({ gov: { registry } }: Governor): void {
  registry.query("packs.list", async (ctx) => ({ packs: await infos(ctx.gov) }));

  registry.query("pack.files", async (ctx, input) => {
    const workspace = getWorkspace(ctx.db, input.workspaceId);
    const manifest = manifestOf(ctx.gov, workspace.snapshotDigest);
    let files: Files | undefined;
    if (manifest.platform === "admin") {
      files = input.version === "working" ? packOf((await platformFiles(ctx.gov)) ?? new Map(), `packs/${input.name}/`) : readPack(ctx.gov.packsDir, input.name, input.version, releasedDirOf(ctx.gov.dataDir));
    } else if (manifest.packs.includes(input.name) && input.version !== "working") {
      files = readPack(ctx.gov.packsDir, input.name, input.version, releasedDirOf(ctx.gov.dataDir));
    } else throw new BrainError("NOT_FOUND", `This workspace does not use the pack ${input.name}`);
    if (!files || files.size === 0) throw new BrainError("NOT_FOUND", `There is no such version of ${input.name}`);
    return { files: [...files].filter(([, bytes]) => bytes.length <= 1_000_000 && !bytes.includes(0)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => ({ path, content: decode(bytes) })) };
  });

  registry.command<"pack.release", { readonly committed: Committed; readonly version: number; readonly name: string }>("pack.release", {
    async prepare(ctx, input) {
      const workspace = getWorkspace(ctx.db, input.workspaceId);
      if (manifestOf(ctx.gov, workspace.snapshotDigest).platform !== "admin") throw new BrainError("FORBIDDEN", "Only the admin workspace releases packs");
      const dir = workspaceDir(ctx.gov, workspace.slug);
      const files = packOf((await readHead(dir)).files, `packs/${input.name}/`);
      const packToml = files.get("pack.toml");
      if (!packToml) throw new BrainError("NOT_FOUND", `The platform workspace has no packs/${input.name}/pack.toml`);
      const parsed = PackFile.safeParse((() => { try { return parseToml(decode(packToml)); } catch { return {}; } })());
      if (!parsed.success) throw new BrainError("INVALID_INPUT", `packs/${input.name}/pack.toml is not valid`, parsed.error.issues.map((issue) => ({ path: `packs/${input.name}/pack.toml`, message: issue.message })));
      const version = Math.max(parsed.data.version ?? 0, lastRelease(ctx.gov, input.name)) + 1;
      const bumped = encode(withVersion(decode(packToml), version));
      files.set("pack.toml", bumped);
      const target = freeze(ctx.gov, input.name, version, files);
      try {
        const check = loadWorkspace(new Map([["brain.toml", encode(`name = "Check"\n${input.name === PLATFORM_PACK ? "platform = \"admin\"\n" : ""}packs = ["${input.name}@${version}"]\n`)]]), ctx.gov.packsDir, releasedDirOf(ctx.gov.dataDir));
        if (!check.manifest) throw new BrainError("INVALID_WORKSPACE", `${input.name} would not be a valid pack as it is, so nothing was released`, check.problems);
        const committed = await commitFolder(ctx.gov, workspace.slug, {
          write: new Map([[`packs/${input.name}/pack.toml`, bumped]]), remove: [], message: `Release ${input.name} ${version}`, author: { name: ctx.user?.name ?? "Brain", email: ctx.user?.email ?? "brain@localhost" }, instanceAdmin: ctx.user?.instanceAdmin === true,
        });
        await tagCommit(dir, `${input.name}@${version}`, committed.commit);
        return { committed, version, name: input.name };
      } catch (e) {
        unfreeze(target);
        throw e;
      }
    },
    run(ctx, input, { committed, version, name }): CommandOutputs["pack.release"] {
      activate(ctx.gov, ctx.db, input.workspaceId, committed, ctx.actor, "workspace.changed");
      append(ctx.db, { type: "pack.released", workspaceId: input.workspaceId, subject: `pack:${name}`, payload: { name, version, commit: committed.commit }, actor: ctx.actor });
      return { version };
    },
  });

  registry.command<"packs.updateAll", { readonly done: Array<{ readonly workspaceId: string; readonly slug: string; readonly name: string; readonly packs: PackUpdate[]; readonly committed: Committed }>; readonly failed: Array<{ readonly slug: string; readonly message: string }> }>("packs.updateAll", {
    async prepare(ctx, input) {
      const platform = getWorkspace(ctx.db, input.workspaceId);
      if (manifestOf(ctx.gov, platform.snapshotDigest).platform !== "admin") throw new BrainError("FORBIDDEN", "Only the admin workspace updates the other workspaces");
      const rows = ctx.gov.db.prepare("SELECT id, slug, name, active_snapshot AS snapshot FROM workspaces WHERE status = 'active' AND active_snapshot != '' ORDER BY slug").all() as Array<{ id: string; slug: string; name: string; snapshot: string }>;
      const done: Array<{ workspaceId: string; slug: string; name: string; packs: PackUpdate[]; committed: Committed }> = [];
      const failed: Array<{ slug: string; message: string }> = [];
      for (const row of rows) {
        const packs = updatesOf(ctx.gov, manifestOf(ctx.gov, row.snapshot as never));
        if (packs.length === 0) continue;
        try {
          const dir = workspaceDir(ctx.gov, row.slug);
          const brain = (await readHead(dir)).files.get("brain.toml");
          if (!brain) throw new BrainError("NOT_FOUND", "The workspace has no brain.toml");
          const committed = await commitFolder(ctx.gov, row.slug, {
            write: new Map([["brain.toml", encode(pinned(decode(brain), packs))]]), remove: [], message: `Update ${packs.map((one) => `${one.pack} to v${one.latest}`).join(", ")}`,
            author: { name: ctx.user?.name ?? "Brain", email: ctx.user?.email ?? "brain@localhost" }, instanceAdmin: ctx.user?.instanceAdmin === true,
          });
          done.push({ workspaceId: row.id, slug: row.slug, name: row.name, packs, committed });
        } catch (e) {
          failed.push({ slug: row.slug, message: e instanceof Error ? e.message : String(e) });
        }
      }
      return { done, failed };
    },
    run(ctx, input, { done, failed }): CommandOutputs["packs.updateAll"] {
      for (const one of done) {
        activate(ctx.gov, ctx.db, one.workspaceId, one.committed, ctx.actor, "workspace.changed");
        append(ctx.db, { type: "packs.updated", workspaceId: one.workspaceId, subject: `workspace:${one.workspaceId}`, payload: { packs: one.packs.map((pack) => `${pack.pack}@${pack.latest}`), commit: one.committed.commit, by: input.workspaceId }, actor: ctx.actor });
      }
      return { updated: done.map(({ slug, name, packs }) => ({ slug, name, packs })), failed };
    },
  });
}
