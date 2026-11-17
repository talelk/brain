import { existsSync, mkdirSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { OfferProject } from "@brain/contracts";
import { execa } from "execa";

/**
 * Working copies (docs/architecture.md section 8), with the `git` command line.
 *
 * Per workspace and project the runner keeps a bare mirror, `<state>/repos/<workspace>/<project>.git`, fetched with a credential leased
 * for that one fetch. The credential reaches git as an HTTP header in the environment of the fetch; it is never in an address, a config
 * file or an argv. An attempt gets its own clone of each project at the base commit (`work/<project>`).
 *
 * A task's patch holds only that task's own changes. The patches of the tasks it waits for are applied first, each on top of the one
 * before, in the order the offer gives them (three-way where two of them changed the same file); a conflict fails the attempt with the
 * paths. That state is the attempt's baseline: it is committed in the working copy (a local commit, never pushed) and its tree is kept
 * in the runner's own git files. The task's own earlier patch is then applied on top and left as uncommitted changes, and at the end
 * the attempt's patch is the diff against the baseline. The base commit reported for a project stays the project's real commit.
 *
 * The baseline tree and the final diff are taken with the mirror as the git directory and an index and object folder of the attempt's
 * own, never with the `.git` folder inside the working copy: the agent could write that folder, and git runs commands a repository's
 * configuration names.
 *
 * The patch of an attempt (one artifact for all projects, re-appliable per project) is plain `git diff` output: for each project that
 * has changes,
 *
 *   git diff --binary --full-index --no-renames --src-prefix=a/<project>/ --dst-prefix=b/<project>/ <baseline>
 *
 * one after the other. Every path in it therefore starts with the project's folder, as the projects lie under `work/`. The part of one
 * project is the file sections (each starts at a `diff --git` line) whose paths start with `<project>/`; it applies with
 * `git apply --binary -p2` in a checkout of that project that holds the changes it was made on. The Governor reads the same form
 * (`integrations/patch.ts`). A task that changed nothing has an empty patch.
 */

/** A failure of an attempt's setup. `infrastructure` is true when nothing about the task caused it (the repository could not be reached). */
export class SetupError extends Error {
  constructor(message: string, readonly infrastructure = false) { super(message); this.name = "SetupError"; }
}

/** The part of a patch that concerns one project, paths still starting with `<project>/`. */
export interface PatchSection { readonly project: string; readonly diff: Uint8Array }

const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const SECTION_START = Buffer.from("diff --git ");

export function buildPatch(sections: readonly PatchSection[]): Uint8Array {
  return new Uint8Array(Buffer.concat(sections.flatMap((section) => (section.diff.length === 0 || section.diff.at(-1) === 0x0a ? [Buffer.from(section.diff)] : [Buffer.from(section.diff), Buffer.from("\n")]))));
}

/** Splits a patch into the parts of its projects, in the order they first appear. No line of a hunk or of a binary patch starts with `diff --git `. */
export function parsePatch(bytes: Uint8Array): PatchSection[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = new Map<string, Buffer[]>();
  const starts: number[] = [];
  for (let at = buffer.indexOf(SECTION_START); at >= 0; at = buffer.indexOf(SECTION_START, at + 1)) if (at === 0 || buffer[at - 1] === 0x0a) starts.push(at);
  if (buffer.length > 0 && starts[0] !== 0) throw new SetupError("a working-copy patch is not `git diff` output");
  for (const [index, start] of starts.entries()) {
    const section = buffer.subarray(start, starts[index + 1] ?? buffer.length);
    const lineEnd = section.indexOf("\n");
    // A path with unusual bytes is written in quotes; the project's folder comes first either way.
    const project = /^diff --git "?a\/([a-z][a-z0-9-]*)\//u.exec(section.subarray(0, lineEnd < 0 ? section.length : lineEnd).toString("latin1"))?.[1];
    if (!project) throw new SetupError("a working-copy patch has a file outside every project's folder");
    parts.set(project, [...(parts.get(project) ?? []), section]);
  }
  return [...parts].map(([project, sections]) => ({ project, diff: new Uint8Array(Buffer.concat(sections)) }));
}

/** git sees nothing of the host's configuration and never asks a person for anything. */
const GIT_ENV = { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ASKPASS: "/bin/false" };
const IDENTITY = ["-c", "user.name=Brain", "-c", "user.email=brain@localhost"];

interface GitOptions { readonly timeoutMs?: number; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly input?: Uint8Array; readonly signal?: AbortSignal | undefined }

async function git(args: readonly string[], options: GitOptions = {}): Promise<{ ok: boolean; stdout: Uint8Array; text: string; stderr: string }> {
  const result = await execa("git", args, {
    ...(options.cwd ? { cwd: options.cwd } : {}), env: { ...GIT_ENV, ...options.env }, extendEnv: false, reject: false, encoding: "buffer", stripFinalNewline: false,
    maxBuffer: MAX_PATCH_BYTES, timeout: options.timeoutMs ?? 15 * 60_000, ...(options.input ? { input: options.input } : { stdin: "ignore" as const }), ...(options.signal ? { cancelSignal: options.signal } : {}),
  });
  const stdout = result.stdout instanceof Uint8Array ? result.stdout : new Uint8Array();
  const stderr = result.stderr instanceof Uint8Array ? Buffer.from(result.stderr).toString("utf8") : String(result.stderr ?? "");
  return { ok: result.exitCode === 0, stdout, text: Buffer.from(stdout).toString("utf8").trim(), stderr: stderr || (result.exitCode === 0 ? "" : String(result.shortMessage ?? "git failed")) };
}

/**
 * The environment that gives one fetch its credential: an Authorization header for the repository's own origin and no other. A
 * credential written `user:password` is used as it is; anything else is a token.
 */
export function credentialEnv(repo: string, credential: string | undefined): Record<string, string> {
  if (!credential) return {};
  let origin: string;
  try { const url = new URL(repo); if (url.protocol !== "https:" && url.protocol !== "http:") return {}; origin = url.origin; } catch { return {}; }
  const basic = Buffer.from(credential.includes(":") ? credential : `x-access-token:${credential}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

/** One fetch at a time per mirror: slots of this runner share them. */
const mirrorLocks = new Map<string, Promise<unknown>>();
function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (mirrorLocks.get(key) ?? Promise.resolve()).then(work, work);
  mirrorLocks.set(key, run.catch(() => undefined));
  return run;
}

const scrub = (text: string, secret: string | undefined): string => (secret && secret.length >= 4 ? text.split(secret).join("[redacted]") : text).trim().slice(-600);

interface Checkout { readonly name: string; readonly dir: string; readonly mirror: string; readonly base: string; baseline: string }

export interface WorkingCopy {
  /** The attempt's `work` folder; each project is a folder of it. */
  readonly root: string;
  /** The commit each project's working copy started from, by project name. */
  readonly baseCommits: Readonly<Record<string, string>>;
  /** The task's own changes: every project against the attempt's baseline (the base commit with the inherited patches applied), as one patch. */
  patch(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface WorkingCopyRequest {
  readonly stateDir: string;
  readonly workspaceId: string;
  /** `<state>/attempts/<attempt>`: the working copy goes in its `work` folder, the runner's own git files in `git`. */
  readonly attemptDir: string;
  readonly projects: readonly OfferProject[];
  /** Leases the credential of a project that names one. */
  readonly credential: (project: OfferProject) => Promise<string>;
  /** The patches of the tasks this one waits for, in the order to apply them; together with the base commit they make the baseline. */
  readonly inherited: ReadonlyArray<{ readonly label: string; readonly bytes: Uint8Array }>;
  /** The patch an earlier attempt of this task left: its own changes, applied on the baseline. */
  readonly own?: Uint8Array;
  readonly signal?: AbortSignal;
}

async function fetchMirror(request: WorkingCopyRequest, project: OfferProject, mirror: string): Promise<string> {
  const { signal } = request;
  return locked(mirror, async () => {
    if (!existsSync(join(mirror, "HEAD"))) {
      mkdirSync(mirror, { recursive: true });
      const made = await git(["init", "--quiet", "--bare", mirror], { signal });
      if (!made.ok) throw new SetupError(`the mirror of project ${project.name} could not be created: ${made.stderr.slice(-300)}`, true);
      // Commits an attempt works on must stay even after the branch moved away from them.
      await git(["-C", mirror, "config", "gc.auto", "0"], { signal });
    }
    const secret = project.credential ? await request.credential(project) : undefined;
    const env = credentialEnv(project.repo, secret);
    const fetched = await git(["-C", mirror, "fetch", "--quiet", "--prune", "--no-tags", "--depth", "50", project.repo, `+refs/heads/${project.branch}:refs/heads/${project.branch}`], { env, signal });
    if (!fetched.ok) throw new SetupError(`project ${project.name} could not be fetched from its repository (branch ${project.branch}): ${scrub(fetched.stderr, secret)}`, true);
    const has = async (commit: string): Promise<boolean> => (await git(["-C", mirror, "cat-file", "-e", `${commit}^{commit}`], { signal })).ok;
    if (project.baseCommit) {
      if (!/^[0-9a-f]{40,64}$/u.test(project.baseCommit)) throw new SetupError(`the base commit of project ${project.name} is not a commit id`);
      // A commit the branch window does not hold (a pull request's head, or a base the branch has moved far past) is fetched by its id, alone:
      // it is kept under a branch name of the mirror so that a clone of the mirror carries it; only its tree is needed to check it out and to take the patch, so a deep negotiation is avoided. A commit whose tree is not whole counts as absent.
      const whole = async (commit: string): Promise<boolean> => (await has(commit)) && (await git(["-C", mirror, "ls-tree", "-r", "--name-only", commit], { signal })).ok;
      if (!(await whole(project.baseCommit))) await git(["-C", mirror, "fetch", "--quiet", "--no-tags", "--depth", "1", project.repo, `+${project.baseCommit}:refs/heads/base-${project.baseCommit}`], { env, signal, timeoutMs: 120_000 });
      if (!(await whole(project.baseCommit))) throw new SetupError(`commit ${project.baseCommit.slice(0, 12)} of project ${project.name} could not be obtained from its repository: the branch ${project.branch} has moved on and the commit this task started from is no longer served. Start the task again from the current head of the branch.`);
      return project.baseCommit;
    }
    const head = await git(["-C", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${project.branch}^{commit}`], { signal });
    if (!head.ok || !head.text) throw new SetupError(`project ${project.name} has no branch ${project.branch}`);
    return head.text;
  });
}

async function checkout(request: WorkingCopyRequest, project: OfferProject, mirror: string, base: string): Promise<Checkout> {
  const dir = join(request.attemptDir, "work", project.name);
  const { signal } = request;
  // A copy of its own, not hard links into the mirror: the agent may write this folder.
  const cloned = await git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", mirror, dir], { signal });
  const placed = cloned.ok ? await git(["-C", dir, "checkout", "--quiet", "--detach", base], { signal }) : cloned;
  if (!placed.ok) throw new SetupError(`the working copy of project ${project.name} could not be created: ${placed.stderr.slice(-300)}`, true);
  await git(["-C", dir, "remote", "remove", "origin"], { signal });
  return { name: project.name, dir, mirror, base, baseline: "" };
}

const pathsOf = (text: string): string[] => [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];

/** Applies one project's part of a patch on top of what the working copy holds; throws with the conflicting paths when it does not fit. */
async function applySection(request: WorkingCopyRequest, copy: Checkout, section: PatchSection, label: string): Promise<void> {
  const { signal } = request;
  // Three-way where the file has changed since the patch was made: the blobs it names are the ones earlier patches left here.
  const applied = await git(["-C", copy.dir, "apply", "--3way", "--binary", "--whitespace=nowarn", "-p2", "-"], { input: section.diff, signal });
  if (applied.ok) return;
  const unmerged = pathsOf((await git(["-C", copy.dir, "diff", "--name-only", "--diff-filter=U"], { signal })).text);
  // git names a path it could not patch as "error: patch failed: <path>:<line>" or "error: <path>: <why>".
  const named = applied.stderr.split("\n").filter((line) => line.startsWith("error: ") && line.includes(": ", "error: ".length)).map((line) => line.slice("error: ".length).replace(/^patch failed: /u, "").split(":")[0]!.trim()).filter(Boolean);
  const paths = unmerged.length > 0 ? unmerged : [...new Set(named)];
  throw new SetupError(`${label} do not apply to project ${copy.name}: ${paths.length > 0 ? `conflict in ${paths.slice(0, 20).join(", ")}` : applied.stderr.slice(-300)}`);
}

/** The tree of what the working copy holds now, written with the runner's own git directory, index and object folder. */
async function snapshot(attemptDir: string, copy: Checkout, signal: AbortSignal | undefined): Promise<{ tree: string; env: Record<string, string> }> {
  const index = join(attemptDir, "git", `${copy.name}.index`);
  const objects = join(attemptDir, "git", `${copy.name}.objects`);
  mkdirSync(objects, { recursive: true });
  const env = { GIT_DIR: copy.mirror, GIT_WORK_TREE: copy.dir, GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(copy.mirror, "objects") };
  let tree = "";
  for (const step of [...(existsSync(index) ? [] : [["read-tree", copy.base]]), ["add", "--all", "."], ["write-tree"]]) {
    const done = await git(step, { cwd: copy.dir, env, signal });
    if (!done.ok) throw new SetupError(`the changes of project ${copy.name} could not be read: ${done.stderr.slice(-300)}`, true);
    tree = done.text;
  }
  return { tree, env };
}

/** The project's changes against the attempt's baseline. */
async function diffOf(attemptDir: string, copy: Checkout, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const { env } = await snapshot(attemptDir, copy, signal);
  const diff = await git(["diff", "--cached", "--binary", "--full-index", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", `--src-prefix=a/${copy.name}/`, `--dst-prefix=b/${copy.name}/`, copy.baseline], { cwd: copy.dir, env, signal });
  if (!diff.ok) throw new SetupError(`the changes of project ${copy.name} could not be read: ${diff.stderr.slice(-300)}`, true);
  return diff.stdout;
}

/** Fetches the mirrors, creates the attempt's working copy, applies the inherited patches (the baseline) and then the task's own. No project means no working copy. */
export async function prepareWorkingCopy(request: WorkingCopyRequest): Promise<WorkingCopy | undefined> {
  if (request.projects.length === 0) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(request.workspaceId) || request.workspaceId.includes("..")) throw new SetupError("the workspace id cannot name a folder");
  const unnamed = request.projects.find((project) => !/^[a-z][a-z0-9-]{0,62}$/u.test(project.name));
  if (unnamed) throw new SetupError(`the project name ${unnamed.name} cannot name a folder`);
  const root = join(request.attemptDir, "work");
  mkdirSync(join(request.attemptDir, "git"), { recursive: true });
  mkdirSync(root, { recursive: true });
  const copies: Checkout[] = [];
  for (const project of request.projects) {
    const mirror = join(request.stateDir, "repos", request.workspaceId, `${project.name}.git`);
    copies.push(await checkout(request, project, mirror, await fetchMirror(request, project, mirror)));
  }
  const apply = async (bytes: Uint8Array, label: string): Promise<void> => {
    for (const section of parsePatch(bytes)) {
      const copy = copies.find((candidate) => candidate.name === section.project);
      // A patch may hold a project this task does not work on; that part is not this working copy's.
      if (copy) await applySection(request, copy, section, label);
    }
  };
  for (const patch of request.inherited) await apply(patch.bytes, patch.label);
  for (const copy of copies) {
    // The baseline: what the task starts from. A local commit for the agent's own view of it, and its tree in the runner's own git files.
    if (!(await git(["-C", copy.dir, "diff", "--cached", "--quiet"], { signal: request.signal })).ok) {
      const committed = await git(["-C", copy.dir, ...IDENTITY, "commit", "--quiet", "--no-verify", "-m", "Changes of the tasks this one waits for"], { signal: request.signal });
      if (!committed.ok) throw new SetupError(`the baseline of project ${copy.name} could not be recorded: ${committed.stderr.slice(-300)}`, true);
    }
    copy.baseline = (await snapshot(request.attemptDir, copy, request.signal)).tree;
  }
  if (request.own) {
    await apply(request.own, "this task's earlier changes");
    // The task's own changes are left as the working copy's uncommitted changes against the baseline.
    for (const copy of copies) await git(["-C", copy.dir, "reset", "--quiet", "--mixed", "HEAD"], { signal: request.signal });
  }
  return {
    root,
    baseCommits: Object.fromEntries(copies.map((copy) => [copy.name, copy.base])),
    patch: async (signal) => {
      const sections: PatchSection[] = [];
      for (const copy of copies) {
        const diff = await diffOf(request.attemptDir, copy, signal);
        if (diff.length > 0) sections.push({ project: copy.name, diff });
      }
      return buildPatch(sections);
    },
  };
}

const MEDIA_TYPES: Readonly<Record<string, string>> = { ".md": "text/markdown", ".txt": "text/plain", ".log": "text/plain", ".json": "application/json", ".csv": "text/csv", ".html": "text/html", ".patch": "text/x-diff", ".diff": "text/x-diff", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".pdf": "application/pdf" };
const MAX_OUTPUT_FILES = 200;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface OutputFile { readonly name: string; readonly bytes: Uint8Array; readonly mediaType: string }

/**
 * The files the agent left in `out/`, by their path in it. Only plain files are taken: a link could name anything on the runner's host.
 * `skipped` names what was left out (links, files that are too large, files past the count).
 */
export function collectOutputs(outDir: string): { files: OutputFile[]; skipped: string[] } {
  const files: OutputFile[] = [];
  const skipped: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path, name); continue; }
      if (!entry.isFile() || lstatSync(path).size > MAX_OUTPUT_BYTES || files.length >= MAX_OUTPUT_FILES) { skipped.push(name); continue; }
      files.push({ name, bytes: new Uint8Array(readFileSync(path)), mediaType: MEDIA_TYPES[extname(entry.name).toLowerCase()] ?? "application/octet-stream" });
    }
  };
  if (existsSync(outDir)) walk(outDir, "");
  return { files, skipped };
}
