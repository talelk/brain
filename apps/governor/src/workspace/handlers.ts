import { BrainError, isSlug, type CommandInput, type CommandOutputs, type FileEntry, type WorkspaceSummary } from "@brain/contracts";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { stringify } from "smol-toml";
import type { Governor } from "../app";
import type { Db } from "../db";
import type { Ctx, Gov } from "../dispatch";
import { append } from "../events";
import { setSecret } from "../trust/secrets";
import { listPacks, readPack } from "./files";
import type { Author } from "./git";
import { activate, commitFolder, commitOf, getWorkspace, loadFolder, manifestOf, workspaceDir, type Committed } from "./store";

const encode = (content: string): Uint8Array => new TextEncoder().encode(content);
const slugOf = (words: string): string => words.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^[^a-z]+|-+$/gu, "").slice(0, 40);
const author = (ctx: Ctx) => ({ name: ctx.user?.name ?? "Brain", email: ctx.user?.email ?? "brain@localhost" });

/** The first `brain.toml` of a workspace: its packs, a spend cap, and the model and project given at creation, with secrets by reference. */
function firstBrainToml(input: CommandInput<"workspace.create">): string {
  const { model, project } = input;
  const projectName = project ? (project.name ?? (slugOf(project.repo.replace(/\.git$/u, "").split("/").at(-1) ?? "") || "project")) : undefined;
  return stringify({
    name: input.name,
    description: input.description,
    packs: input.packs,
    limits: { daily_spend_usd: 20, running_tasks: 4, confirm_plans: "person" },
    ...(model ? { model: [{ name: model.name, provider: model.provider, url: model.url, model: model.model, ...(model.key ? { key: `secret:model-${model.name}` } : {}) }] } : {}),
    ...(project ? { project: [{ name: projectName, repo: project.repo, branch: project.branch, access: project.access, ...(project.credential ? { credential: "secret:github" } : {}) }] } : {}),
    ...(project?.credential && project.repo.includes("github.com") ? { github: { credential: "secret:github" } } : {}),
  });
}

/** A new workspace's folder, committed and valid, not yet a workspace: `createWorkspace` makes it one. */
export interface NewWorkspace { readonly slug: string; readonly committed: Committed }

/** Writes and commits the folder of a new workspace. Git cannot run in a transaction, so this comes first. */
export async function commitNewWorkspace(gov: Gov, input: CommandInput<"workspace.create">, by: Author): Promise<NewWorkspace> {
  const slug = input.slug ?? slugOf(input.name);
  if (!isSlug(slug)) throw new BrainError("INVALID_INPUT", "Give the workspace an address", [{ path: "slug", message: "an address is lower-case letters, digits and dashes, starting with a letter" }]);
  if (gov.db.prepare("SELECT 1 FROM workspaces WHERE slug=?").get(slug)) throw new BrainError("CONFLICT", `A workspace already has the address ${slug}`);
  // A folder no workspace owns is what a creation that failed half-way left behind.
  const dir = workspaceDir(gov, slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  try {
    return { slug, committed: await commitFolder(gov, slug, { write: new Map([["brain.toml", encode(firstBrainToml(input))]]), remove: [], message: "Create the workspace", author: by }) };
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

export function registerWorkspace({ gov: { registry } }: Governor): void {
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
    commitFolder(ctx.gov, getWorkspace(ctx.db, workspaceId).slug, { write, remove, message, author: author(ctx) });
  const activated = (ctx: Ctx, workspaceId: string, committed: Committed) => {
    activate(ctx.gov, ctx.db, workspaceId, committed, ctx.actor, "workspace.changed");
    return { commit: committed.commit, snapshotDigest: committed.snapshotDigest };
  };
  registry.command<"file.write", Committed>("file.write", {
    prepare: (ctx, input) => change(ctx, input.workspaceId, new Map(input.files.map((file) => [file.path, encode(file.content)])), [], input.message ?? `Change ${input.files.map((file) => file.path).join(", ")}`.slice(0, 200)),
    run: (ctx, input, committed) => activated(ctx, input.workspaceId, committed),
  });
  registry.command<"file.delete", Committed>("file.delete", {
    prepare: (ctx, input) => change(ctx, input.workspaceId, new Map(), input.paths, input.message ?? `Remove ${input.paths.join(", ")}`.slice(0, 200)),
    run: (ctx, input, committed) => activated(ctx, input.workspaceId, committed),
  });

  registry.query("workspace.get", (ctx, input) => {
    const workspace = getWorkspace(ctx.db, input.workspaceId);
    const summary: WorkspaceSummary = { id: workspace.id, slug: workspace.slug, name: workspace.name, description: workspace.description, status: workspace.status, role: ctx.role ?? "viewer" };
    return { ...summary, snapshotDigest: workspace.snapshotDigest, commit: commitOf(ctx.db, workspace.id, workspace.snapshotDigest), snapshot: manifestOf(ctx.gov, workspace.snapshotDigest) };
  });

  const entries = async (ctx: Ctx, workspaceId: string): Promise<Array<FileEntry & { content: Uint8Array }>> => {
    const loaded = await loadFolder(ctx.gov, getWorkspace(ctx.db, workspaceId).slug);
    return [...loaded.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, bytes: file.bytes.length, source: file.source, ...(file.replaces ? { replaces: file.replaces } : {}), content: file.bytes }));
  };
  registry.query("workspace.files", async (ctx, input) => ({ files: (await entries(ctx, input.workspaceId)).map(({ content: _content, ...entry }) => entry) }));
  registry.query("file.read", async (ctx, input) => {
    const file = (await entries(ctx, input.workspaceId)).find((entry) => entry.path === input.path);
    if (!file) throw new BrainError("NOT_FOUND", `The workspace has no file ${input.path}`);
    return { ...file, content: new TextDecoder().decode(file.content) };
  });

  registry.query("packs.list", (ctx) => ({ packs: listPacks(ctx.gov.packsDir) }));
}
