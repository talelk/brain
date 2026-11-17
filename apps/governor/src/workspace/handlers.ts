import { BrainError, isSlug, slugify, MAX_FILE_BYTES, MAX_WRITE_BYTES, type CommandInput, type CommandOutputs, type WorkspaceSummary } from "@brain/contracts";
import { randomBytes } from "node:crypto";
import git from "isomorphic-git";
import { existsSync, rmSync } from "node:fs";
import { stringify } from "smol-toml";
import { accessOf } from "../access";
import type { Governor } from "../app";
import type { Db } from "../db";
import type { Ctx, Gov } from "../dispatch";
import { append } from "../events";
import { httpOver } from "../integrations/pull-request";
import { setSecret } from "../trust/secrets";
import { classifyPath, readPack } from "./files";
import type { Author } from "./git";
import { listFiles, readFileOf } from "./listing";
import { lastPush, pushFolderSoon } from "./push";
import { updatesOf } from "./packs";
import { activate, commitFolder, commitOf, getWorkspace, manifestOf, workspaceDir, type Committed } from "./store";
import { extname } from "node:path";

const encode = (content: string): Uint8Array => new TextEncoder().encode(content);
const author = (ctx: Ctx) => ({ name: ctx.user?.name ?? "Brain", email: ctx.user?.email ?? "brain@localhost" });

/** The project's name when it is not given: the last part of its address (`https://github.com/acme/shop.git` is `shop`). */
export const projectNameOf = (repo: string): string => slugify(repo.replace(/[/?#]+$/u, "").replace(/\.git$/u, "").split(/[/:]/u).at(-1) ?? "") || "project";

/** The branch the repository itself calls its default, asked of the server in at most three seconds; undefined when it cannot be known. */
export async function defaultBranchOf(gov: Gov, repo: string, token: string | undefined): Promise<string | undefined> {
  if (!/^https?:\/\//u.test(repo)) return undefined;
  try {
    const headers = token ? { authorization: `Basic ${Buffer.from(token.includes(":") ? token : `x-access-token:${token}`).toString("base64")}` } : {};
    const send: typeof fetch = (input, init) => gov.fetch(input, { ...init, signal: AbortSignal.timeout(3_000) });
    const info = await git.getRemoteInfo({ http: httpOver(send), url: repo, headers });
    const head = (info as { HEAD?: string }).HEAD;
    return head?.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : undefined;
  } catch { return undefined; }
}

/** The first `brain.toml` of a workspace: its packs, a spend cap, and the model, project and folder remote given at creation, with secrets by reference. Defaults are left out. */
function firstBrainToml(input: CommandInput<"workspace.create">, branch: string): string {
  const { model, project } = input;
  const onGithub = project !== undefined && /^https:\/\/github\.com\//u.test(project.repo);
  return stringify({
    name: input.name,
    description: input.description,
    ...(input.platform ? { platform: input.platform } : {}),
    packs: input.packs,
    limits: { daily_spend_usd: 20 },
    ...(model ? { model: [{ name: model.name, provider: model.provider, url: model.url, model: model.model, ...(model.key ? { key: `secret:model-${model.name}` } : {}) }] } : {}),
    ...(project ? { project: [{ name: project.name ?? projectNameOf(project.repo), repo: project.repo, ...(branch !== "main" ? { branch } : {}), ...(project.access === "write" ? { access: "write" } : {}), ...(project.credential && !onGithub ? { credential: "secret:github" } : {}) }] } : {}),
    ...(project?.credential && onGithub ? { github: { credential: "secret:github" } } : {}),
    ...(input.folderRemote ? { git: { remote: input.folderRemote } } : {}),
  });
}

/** A new workspace's folder, committed and valid, not yet a workspace: `createWorkspace` makes it one. */
export interface NewWorkspace { readonly slug: string; readonly committed: Committed }

/** Writes and commits the folder of a new workspace. Git cannot run in a transaction, so this comes first. */
export async function commitNewWorkspace(gov: Gov, input: CommandInput<"workspace.create">, by: Author): Promise<NewWorkspace> {
  // The address is the workspace's folder: it comes from the name unless given, and it is the same address whatever the case or accents typed.
  const slug = slugify(input.slug ?? input.name);
  if (!isSlug(slug)) throw new BrainError("INVALID_INPUT", "Give the workspace a name with letters in it: its address is made from it", [{ path: "name", message: "the name makes no address: use letters or digits" }]);
  // Archived workspaces keep their address.
  if (gov.db.prepare("SELECT 1 FROM workspaces WHERE slug=?").get(slug)) throw new BrainError("CONFLICT", `A workspace already has the address "${slug}". Change the name.`, [{ path: "name", message: `A workspace already has the address "${slug}": change the name` }]);
  const project = input.project;
  const branch = project?.branch ?? (project ? ((await defaultBranchOf(gov, project.repo, project.credential)) ?? "main") : "main");
  // A folder no workspace owns is what a creation that failed half-way left behind.
  const dir = workspaceDir(gov, slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  try {
    return { slug, committed: await commitFolder(gov, slug, { write: new Map([["brain.toml", encode(firstBrainToml(input, branch))]]), remove: [], message: "Create the workspace", author: by, instanceAdmin: true }) };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Makes a committed folder a workspace, with its first admin and the secrets given at creation. Runs in the command's transaction. */
export function createWorkspace(gov: Gov, db: Db, input: CommandInput<"workspace.create">, { slug, committed }: NewWorkspace, userId: string): CommandOutputs["workspace.create"] {
  const now = gov.clock.nowMs();
  const workspaceId = `ws_${randomBytes(9).toString("base64url")}`;
  db.prepare("INSERT INTO workspaces(id, slug, name, description, active_snapshot, created_at_ms) VALUES (?,?,?,?,?,?)").run(workspaceId, slug, input.name, input.description, committed.snapshotDigest, now);
  db.prepare("INSERT INTO members(workspace_id, user_id, role, created_at_ms) VALUES (?,?,'admin',?)").run(workspaceId, userId, now);
  if (input.model?.key) setSecret(gov, db, { workspaceId, name: `model-${input.model.name}`, value: input.model.key, by: userId });
  if (input.project?.credential) setSecret(gov, db, { workspaceId, name: "github", value: input.project.credential, by: userId });
  activate(gov, db, workspaceId, committed, { kind: "person", id: userId }, "workspace.created");
  return { workspaceId, slug, snapshotDigest: committed.snapshotDigest };
}

/** The pack a first workspace is made from, and that workspace: what a person sees before they have made anything. Its `hello` Play is the sample goal. */
export const STARTER_PACK = "base";
export const starterWorkspace = (gov: Gov): CommandInput<"workspace.create"> | undefined =>
  (readPack(gov.packsDir, STARTER_PACK) ? { name: "Starter", description: "A first workspace to try Brain in. Start the Play \"Say hello\" to see a goal become a checked result.", packs: [STARTER_PACK] } : undefined);

const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".mp3", ".mp4", ".mov", ".woff", ".woff2"]);
/** What a download says its bytes are. Anything a browser could run as a page is plain bytes; an SVG stays an image so that `<img>` can show it. */
const MEDIA: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8", ".markdown": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json", ".toml": "text/plain; charset=utf-8",
};
/** A file is text when it is valid UTF-8 without NUL and not of a kind that is always bytes. */
function textOf(path: string, bytes: Uint8Array): string | undefined {
  if (BINARY.has(extname(path).toLowerCase()) || bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
}

/** The bytes of a written file. Documents may arrive as base64; the limits are on the bytes, and are checked here whatever the caller. */
function bytesOf(files: CommandInput<"file.write">["files"]): Map<string, Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  const refused: Array<{ path: string; message: string }> = [];
  let total = 0;
  for (const file of files) {
    let content: Uint8Array;
    if (file.encoding === "base64") {
      if (classifyPath(file.path)?.kind !== "document") { refused.push({ path: file.path, message: "only a document can be sent as bytes; Brain's own files are text" }); continue; }
      if (file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.content)) { refused.push({ path: file.path, message: "the content is not valid base64" }); continue; }
      content = new Uint8Array(Buffer.from(file.content, "base64"));
    } else {
      content = encode(file.content);
    }
    if (bytes.has(file.path)) refused.push({ path: file.path, message: "the path is written twice" });
    if (content.length > MAX_FILE_BYTES) refused.push({ path: file.path, message: `a file is at most ${MAX_FILE_BYTES / 1024 / 1024} MB` });
    total += content.length;
    bytes.set(file.path, content);
  }
  if (total > MAX_WRITE_BYTES) refused.push({ path: "", message: `one upload is at most ${MAX_WRITE_BYTES / 1024 / 1024} MB in all` });
  if (refused.length > 0) throw new BrainError("INVALID_INPUT", "The files cannot be written", refused);
  return bytes;
}

export function registerWorkspace({ gov: { registry }, gov, app }: Governor): void {
  // The folder's remote: every activated snapshot of a workspace that has one is pushed, in the background.
  gov.onActivate.push((workspaceId, manifest) => { if (manifest.git) pushFolderSoon(gov, workspaceId); });
  registry.command<"workspace.create", NewWorkspace>("workspace.create", {
    prepare: (ctx, input) => commitNewWorkspace(ctx.gov, input, author(ctx)),
    run(ctx, input, prepared) {
      if (!ctx.user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
      return createWorkspace(ctx.gov, ctx.db, input, prepared, ctx.user.id);
    },
  });

  registry.command("workspace.archive", (ctx, input) => {
    ctx.db.prepare("UPDATE workspaces SET status='archived' WHERE id=?").run(input.workspaceId);
    append(ctx.db, { type: "workspace.archived", workspaceId: input.workspaceId, subject: `workspace:${input.workspaceId}`, payload: {}, actor: ctx.actor });
    return {};
  });

  const change = (ctx: Ctx, workspaceId: string, write: ReadonlyMap<string, Uint8Array>, remove: readonly string[], message: string): Promise<Committed> =>
    commitFolder(ctx.gov, getWorkspace(ctx.db, workspaceId).slug, { write, remove, message, author: author(ctx), instanceAdmin: ctx.user?.instanceAdmin === true });
  const activated = (ctx: Ctx, workspaceId: string, committed: Committed) => {
    activate(ctx.gov, ctx.db, workspaceId, committed, ctx.actor, "workspace.changed");
    return { commit: committed.commit, snapshotDigest: committed.snapshotDigest };
  };
  registry.command<"file.write", Committed>("file.write", {
    prepare: (ctx, input) => change(ctx, input.workspaceId, bytesOf(input.files), input.remove, input.message ?? `Change ${[...input.files.map((file) => file.path), ...input.remove].join(", ")}`.slice(0, 200)),
    run: (ctx, input, committed) => activated(ctx, input.workspaceId, committed),
  });
  registry.command<"file.delete", Committed>("file.delete", {
    prepare: (ctx, input) => change(ctx, input.workspaceId, new Map(), input.paths, input.message ?? `Remove ${input.paths.join(", ")}`.slice(0, 200)),
    run: (ctx, input, committed) => activated(ctx, input.workspaceId, committed),
  });

  registry.query("workspace.get", (ctx, input) => {
    const workspace = getWorkspace(ctx.db, input.workspaceId);
    const snapshot = manifestOf(ctx.gov, workspace.snapshotDigest);
    const summary: WorkspaceSummary = {
      id: workspace.id, slug: workspace.slug, name: workspace.name, description: workspace.description, status: workspace.status, role: ctx.role ?? "viewer",
      visibility: snapshot.visibility === "public" ? "public" : "private", platform: snapshot.platform ?? null, viaPublic: ctx.user ? (accessOf(ctx.gov, ctx.user.id, workspace.id)?.viaPublic ?? false) : false,
    };
    return { ...summary, snapshotDigest: workspace.snapshotDigest, commit: commitOf(ctx.db, workspace.id, workspace.snapshotDigest), snapshot, updates: updatesOf(ctx.gov, snapshot), folderPush: snapshot.git ? lastPush(ctx.gov, workspace.id) : null };
  });

  registry.query("workspace.files", async (ctx, input) => ({ files: await listFiles(ctx.gov, input.workspaceId) }));
  registry.query("file.read", async (ctx, input) => {
    const { bytes, ...origin } = await readFileOf(ctx.gov, input.workspaceId, input.path);
    const text = textOf(input.path, bytes);
    return { path: input.path, bytes: bytes.length, ...origin, content: text ?? "", binary: text === undefined };
  });
  // The bytes of a file, for a member of the workspace. Always a download, never a page of Brain: what is stored comes from people and agents.
  app.get("/v1/workspaces/:id/files/*", async (c) => {
    const user = await gov.auth.user(c.req.raw.headers);
    if (!user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    const workspaceId = c.req.param("id");
    if (!accessOf(gov, user.id, workspaceId)) throw new BrainError("NOT_FOUND", "Workspace not found");
    const path = decodeURIComponent(c.req.path.slice(`/v1/workspaces/${workspaceId}/files/`.length));
    const file = await readFileOf(gov, workspaceId, path);
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": MEDIA[extname(path).toLowerCase()] ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "file")}`,
        "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, no-store",
      },
    });
  });

}
