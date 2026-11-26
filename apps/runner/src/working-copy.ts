import { existsSync, mkdirSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mediaTypeOf, type OfferProject, gitAuthorization, isSlug } from "@brain/contracts";
import { execa } from "execa";
import { touchMirror } from "./cache";

/**
 * Working copies (docs/architecture.md section 8), with the `git` command line.
 *
 * Per workspace and project the runner keeps a bare mirror, `<state>/repos/<workspace>/<project>.git`, fetched with a credential leased
 * for that one fetch. The credential reaches git as an HTTP header in the environment of the fetch; it is never in an address, a config
 * file or an argv. An attempt gets its own clone of each project at the base commit (`work/<project>`).
 *
 * The state commits the attempt starts from (the tasks it waits for, and its own earlier attempt: docs/architecture.md, section 8) are fetched
 * from the git store into the mirror and merged into the working copy, in the order the offer gives them; a conflict fails the attempt with the
 * paths. What the agent then changes is the attempt's. Its **state commit** is the tree of the whole working copy with the base commit and the
 * inherited commits as parents, pushed to the store so the next attempt, on any runner, starts from it; there is one only for a project whose
 * tree differs from its base commit's. Beside it goes a **diff** of the tree against the base commit, for people to read; it never rebuilds work.
 *
 * The tree and the diff are taken with the mirror as the git directory and an index and object folder of the attempt's own, never with the
 * `.git` folder inside the working copy: the agent could write that folder, and git runs commands a repository's configuration names. The
 * diff is plain `git diff` output whose paths start with the project's folder, as the projects lie under `work/`.
 */

/** A failure of an attempt's setup. `infrastructure` is true when nothing about the task caused it (the repository could not be reached). */
export class SetupError extends Error {
  constructor(message: string, readonly infrastructure = false) { super(message); this.name = "SetupError"; }
}

const MAX_DIFF_BYTES = 8 * 1024 * 1024;

/** git sees nothing of the host's configuration and never asks a person for anything. */
const GIT_ENV = { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ASKPASS: "/bin/false" };
const IDENTITY = ["-c", "user.name=Brain", "-c", "user.email=brain@localhost"];

interface GitOptions { readonly timeoutMs?: number; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly input?: Uint8Array; readonly signal?: AbortSignal | undefined }

async function git(args: readonly string[], options: GitOptions = {}): Promise<{ ok: boolean; stdout: Uint8Array; text: string; stderr: string }> {
  const result = await execa("git", args, {
    ...(options.cwd ? { cwd: options.cwd } : {}), env: { ...GIT_ENV, ...options.env }, extendEnv: false, reject: false, encoding: "buffer", stripFinalNewline: false,
    maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 15 * 60_000, ...(options.input ? { input: options.input } : { stdin: "ignore" as const }), ...(options.signal ? { cancelSignal: options.signal } : {}),
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
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: ${gitAuthorization(credential)}` };
}

/** One fetch at a time per mirror: slots of this runner share them. */
const mirrorLocks = new Map<string, Promise<unknown>>();
function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (mirrorLocks.get(key) ?? Promise.resolve()).then(work, work);
  mirrorLocks.set(key, run.catch(() => undefined));
  return run;
}

const scrub = (text: string, secret: string | undefined): string => (secret && secret.length >= 4 ? text.split(secret).join("[redacted]") : text).trim().slice(-600);

interface Checkout { readonly name: string; readonly dir: string; readonly mirror: string; readonly base: string }

export interface WorkingCopy {
  /** The attempt's `work` folder; each project is a folder of it. */
  readonly root: string;
  /** The commit each project's working copy started from, by project name. */
  readonly baseCommits: Readonly<Record<string, string>>;
  /** What the working copy holds beside each project's base commit, as one diff for people to read. */
  diff(signal?: AbortSignal): Promise<Uint8Array>;
  /** Pushes the state commit of every project whose tree differs from its base commit's to the store, and returns them by project. */
  push(signal?: AbortSignal): Promise<Record<string, string>>;
}

export interface WorkingCopyRequest {
  readonly stateDir: string;
  readonly workspaceId: string;
  /** `<state>/attempts/<attempt>`: the working copy goes in its `work` folder, the runner's own git files in `git`. */
  readonly attemptDir: string;
  readonly projects: readonly OfferProject[];
  /** Leases the credential of a project that names one. */
  readonly credential: (project: OfferProject) => Promise<string>;
  readonly attemptId: string;
  /** The git store: its address, the token of this attempt and the goal. */
  readonly store: { readonly url: string; readonly token: string; readonly goalId: string } | undefined;
  /** The state commits the attempt starts from, in the order to merge them: those of the tasks it waits for, then its own earlier attempt's. */
  readonly inherited: ReadonlyArray<{ readonly label: string; readonly attemptId: string; readonly commits: Readonly<Record<string, string>> }>;
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
    touchMirror(mirror);
    const secret = project.credential ? await request.credential(project) : undefined;
    const env = credentialEnv(project.repo, secret);
    const fetched = await git(["-C", mirror, "fetch", "--quiet", "--prune", "--no-tags", "--depth", "50", "--", project.repo, `+refs/heads/${project.branch}:refs/heads/${project.branch}`], { env, signal });
    if (!fetched.ok) throw new SetupError(`project ${project.name} could not be fetched from its repository (branch ${project.branch}): ${scrub(fetched.stderr, secret)}`, true);
    const has = async (commit: string): Promise<boolean> => (await git(["-C", mirror, "cat-file", "-e", `${commit}^{commit}`], { signal })).ok;
    if (project.baseCommit) {
      if (!/^[0-9a-f]{40,64}$/u.test(project.baseCommit)) throw new SetupError(`the base commit of project ${project.name} is not a commit id`);
      // A commit the branch window does not hold (a pull request's head, or a base the branch has moved far past) is fetched by its id, alone:
      // it is kept under a branch name of the mirror so that a clone of the mirror carries it; only its tree is needed to check it out and to take the patch, so a deep negotiation is avoided. A commit whose tree is not whole counts as absent.
      // Whole: the commit, its tree and every blob of it are here (a commit alone, or with a part of its tree, counts as absent).
      const whole = async (commit: string): Promise<boolean> => (await has(commit)) && (await git(["-C", mirror, "rev-list", "--objects", "-n", "1", "--missing=error", commit], { signal })).ok;
      const keep = `refs/heads/base-${project.baseCommit}`;
      // A commit that is present but that no ref reaches (left by an earlier fetch, the branch having moved past it) is not in a clone of the mirror: it gets its name.
      const reached = async (): Promise<boolean> => (await git(["-C", mirror, "for-each-ref", "--contains", project.baseCommit as string, "--count=1", "--format=%(refname)"], { signal })).text !== "";
      if (await whole(project.baseCommit)) { if (!(await reached())) await git(["-C", mirror, "update-ref", keep, project.baseCommit], { signal }); }
      else {
        await git(["-C", mirror, "fetch", "--quiet", "--no-tags", "--depth", "1", "--", project.repo, `+${project.baseCommit}:${keep}`], { env, signal, timeoutMs: 120_000 });
        if (!(await whole(project.baseCommit)) || !(await reached())) throw new SetupError(`commit ${project.baseCommit.slice(0, 12)} of project ${project.name} could not be obtained from its repository: the branch ${project.branch} has moved on and the commit this task started from is no longer served. Start the task again from the current head of the branch.`);
      }
      return project.baseCommit;
    }
    const head = await git(["-C", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${project.branch}^{commit}`], { signal });
    if (!head.ok || !head.text) throw new SetupError(`project ${project.name} has no branch ${project.branch}`);
    return head.text;
  });
}

const storeRepo = (request: WorkingCopyRequest, project: { readonly name: string }): string => `${request.store?.url ?? ""}/${request.workspaceId}/${project.name}.git`;
/** A state commit is kept in the store under the goal and its own name. */
const stateRef = (request: WorkingCopyRequest, commit: string): string => `refs/brain/${request.store?.goalId ?? ""}/${commit}`;

/** Fetches the state commits this attempt starts from into the mirror, each under the name `state-<commit>`. The store names a ref by the commit it points at, so what arrives is the commit the offer names. */
async function fetchStates(request: WorkingCopyRequest, project: OfferProject, mirror: string): Promise<string[]> {
  const { signal, store } = request;
  const wanted = request.inherited.flatMap((state) => (state.commits[project.name] ? [{ state, commit: state.commits[project.name] as string }] : []));
  if (wanted.length === 0 || !store) return [];
  return locked(mirror, async () => {
    const env = credentialEnv(storeRepo(request, project), store.token);
    for (const { state, commit } of wanted) {
      if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new SetupError(`the state of ${state.label} is not a commit id`);
      const fetched = await git(["-C", mirror, "fetch", "--quiet", "--no-tags", "--", storeRepo(request, project), `+${stateRef(request, commit)}:refs/heads/state-${commit}`], { env, signal });
      if (!fetched.ok) throw new SetupError(`the state of ${state.label} could not be fetched for project ${project.name} from the git store: ${scrub(fetched.stderr, store.token)}`, true);
    }
    return wanted.map(({ commit }) => commit);
  });
}

/** Merges the inherited state commits of a project into its working copy, in order; throws with the conflicting paths when one does not fit. */
async function mergeStates(request: WorkingCopyRequest, copy: Checkout, commits: readonly string[]): Promise<void> {
  const { signal } = request;
  for (const commit of commits) {
    const merged = await git(["-C", copy.dir, ...IDENTITY, "merge", "--quiet", "--no-edit", "--no-verify", commit], { signal });
    if (merged.ok) continue;
    const unmerged = pathsOf((await git(["-C", copy.dir, "diff", "--name-only", "--diff-filter=U"], { signal })).text);
    throw new SetupError(`the changes of the tasks this one waits for do not merge in project ${copy.name}: ${unmerged.length > 0 ? `conflict in ${unmerged.slice(0, 20).join(", ")}` : merged.stderr.slice(-300)}`);
  }
}

async function checkout(request: WorkingCopyRequest, project: OfferProject, mirror: string, base: string): Promise<Checkout> {
  const dir = join(request.attemptDir, "work", project.name);
  const { signal } = request;
  // A copy of its own, not hard links into the mirror: the agent may write this folder.
  const cloned = await git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", mirror, dir], { signal });
  const placed = cloned.ok ? await git(["-C", dir, "checkout", "--quiet", "--detach", base], { signal }) : cloned;
  if (!placed.ok) throw new SetupError(`the working copy of project ${project.name} could not be created: ${placed.stderr.slice(-300)}`, !project.baseCommit);
  await git(["-C", dir, "remote", "remove", "origin"], { signal });
  return { name: project.name, dir, mirror, base };
}

const pathsOf = (text: string): string[] => [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];

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

/** The project's working copy against its base commit. */
async function diffOf(attemptDir: string, copy: Checkout, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const { env } = await snapshot(attemptDir, copy, signal);
  const diff = await git(["diff", "--cached", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", `--src-prefix=a/${copy.name}/`, `--dst-prefix=b/${copy.name}/`, copy.base], { cwd: copy.dir, env, signal });
  if (!diff.ok) throw new SetupError(`the changes of project ${copy.name} could not be read: ${diff.stderr.slice(-300)}`, true);
  return diff.stdout;
}

/** Fetches the mirrors, creates the attempt's working copy and merges the state commits it starts from. No project means no working copy. */
export async function prepareWorkingCopy(request: WorkingCopyRequest): Promise<WorkingCopy | undefined> {
  if (request.projects.length === 0) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(request.workspaceId) || request.workspaceId.includes("..")) throw new SetupError("the workspace id cannot name a folder");
  const unnamed = request.projects.find((project) => !isSlug(project.name));
  if (unnamed) throw new SetupError(`the project name ${unnamed.name} cannot name a folder`);
  const root = join(request.attemptDir, "work");
  mkdirSync(join(request.attemptDir, "git"), { recursive: true });
  mkdirSync(root, { recursive: true });
  if (!request.store) throw new SetupError("the Governor has no git store (BRAIN_STORE_URL), so an attempt on a project cannot hand its work on");
  const copies: Checkout[] = [];
  const inherited = new Map<string, string[]>();
  for (const project of request.projects) {
    const mirror = join(request.stateDir, "repos", request.workspaceId, `${project.name}.git`);
    const base = await fetchMirror(request, project, mirror);
    inherited.set(project.name, await fetchStates(request, project, mirror));
    copies.push(await checkout(request, project, mirror, base));
  }
  for (const copy of copies) await mergeStates(request, copy, inherited.get(copy.name) ?? []);
  /** The state commit of each project at the tree last pushed: asking again for an unchanged tree makes no new commit. */
  const pushedAt = new Map<string, { tree: string; commit: string }>();
  return {
    root,
    baseCommits: Object.fromEntries(copies.map((copy) => [copy.name, copy.base])),
    diff: async (signal) => {
      const parts: Buffer[] = [];
      for (const copy of copies) {
        const diff = await diffOf(request.attemptDir, copy, signal);
        if (diff.length > 0) parts.push(Buffer.from(diff).at(-1) === 0x0a ? Buffer.from(diff) : Buffer.concat([Buffer.from(diff), Buffer.from("\n")]));
      }
      const whole = Buffer.concat(parts);
      // A diff is for reading: past a size nobody reads, it says so instead of filling the Governor.
      return new Uint8Array(whole.length <= MAX_DIFF_BYTES ? whole : Buffer.from(`The changes are too large to show here (${whole.length} bytes of diff); the state commit holds them.\n`));
    },
    push: async (signal) => {
      const pushed: Record<string, string> = {};
      for (const copy of copies) {
        const { tree, env } = await snapshot(request.attemptDir, copy, signal);
        const baseTree = await git(["-C", copy.mirror, "rev-parse", `${copy.base}^{tree}`], { signal });
        if (tree === baseTree.text) continue;
        const known = pushedAt.get(copy.name);
        if (known?.tree === tree) { pushed[copy.name] = known.commit; continue; }
        const parents = [copy.base, ...(inherited.get(copy.name) ?? [])].flatMap((parent) => ["-p", parent]);
        const made = await git([...IDENTITY, "commit-tree", tree, ...parents, "-m", `Brain: the state of attempt ${request.attemptId}`], { cwd: copy.dir, env, signal });
        if (!made.ok || !made.text) throw new SetupError(`the state of project ${copy.name} could not be recorded: ${made.stderr.slice(-300)}`, true);
        const url = storeRepo(request, copy);
        const sent = await git(["push", "--quiet", url, `${made.text}:${stateRef(request, made.text)}`], { cwd: copy.dir, env: { ...env, ...credentialEnv(url, request.store?.token) }, signal });
        if (!sent.ok) throw new SetupError(`the state of project ${copy.name} could not be pushed to the git store: ${scrub(sent.stderr, request.store?.token)}`, true);
        pushedAt.set(copy.name, { tree, commit: made.text });
        pushed[copy.name] = made.text;
      }
      return pushed;
    },
  };
}

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
      files.push({ name, bytes: new Uint8Array(readFileSync(path)), mediaType: mediaTypeOf(entry.name) });
    }
  };
  if (existsSync(outDir)) walk(outDir, "");
  return { files, skipped };
}
